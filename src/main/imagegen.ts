// On-device image generation via stable-diffusion.cpp (the bundled `sd-cli`).
// Mirrors the llm.ts pattern: resolve the binary from resources/bin, pick a
// Stable Diffusion model from the userData models dir, spawn one-shot txt2img/
// img2img, persist the PNG under userData/generated-images, return a data URL.

import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { NodeDownloadBridge } from '@offgrid/models/node'
import {
  generatedImageSidecarPath,
  readGeneratedImageSidecar,
  writeGeneratedImageSidecar,
  type GeneratedImageSidecar
} from './imagegen/gallery-sidecar'
import {
  ensureCheckpointExtension as ensureCheckpointExt,
  hasCheckpointExtension as hasCheckpointExt,
  IMAGE_CANCELLED_MESSAGE,
  initialImageProgress as initialProgressState,
  isImageModelFile,
  reduceImageProgress as reduceProgress,
  stripCheckpointExtension as stripCheckpointExt,
  type ImageExecutionPlan,
  type ImageNativeExecutionFacts,
  imageTaesdFilename
} from '@offgrid/models'
import type { DesktopManagedRuntime } from './model-runtime-port'
import {
  isMfluxModelId,
  mfluxAvailable,
  getMfluxModel,
  runMflux,
  cancelMflux,
  MFLUX_MODELS
} from './mflux'
import { binRoots, dataDir, modelsDir, resourceDirs, exe } from './runtime-env'
import { sdServer } from './sd-server'
import { hasMlmodelc, isZImageModel, isQuantizedModel } from './imagegen/runtime-detect'
import { buildCoreMLArgs, buildZImageArgs, buildStandardArgs } from './imagegen/args'
import {
  resolveExistingOwnedEntry,
  resolveExistingOwnedPath,
  resolveOwnedDestination
} from './imagegen/owned-path'
import {
  type ImageGenerationPipelineUpdateContract,
  type ImageGenerationOutputContract,
  type ImageGenerationRequestContract
} from '../shared/image-generation-contract'
import { desktopModelServices } from './model-service-access'
import {
  desktopImageApplication,
  registerDesktopImageCancelBoundary,
  registerDesktopImageInspectionBoundary
} from './imagegen/application-service'
import { desktopImageRuntimeIdentity } from './models/image-runtime-identity'

function findSdCli(): string | null {
  for (const r of binRoots()) {
    const p = path.join(r, 'sd', exe('sd-cli'))
    if (fs.existsSync(p)) return p
  }
  return null
}

function hasSdServer(): boolean {
  return binRoots().some((root) => fs.existsSync(path.join(root, 'sd', exe('sd-server'))))
}

/** The Core ML (ANE) image-gen Swift helper, if bundled. */
function findCoreMLBin(): string | null {
  // Core ML is Apple-Silicon only — never offered off macOS (Windows/Linux use sd).
  if (process.platform !== 'darwin') return null
  for (const r of binRoots()) {
    const p = path.join(r, 'coreml-sd', 'coreml-sd')
    if (fs.existsSync(p)) return p
  }
  return null
}

/** A Core ML model is a DIRECTORY of compiled .mlmodelc resources, not a GGUF. */
function isCoreMLModelDir(p: string): boolean {
  if (process.platform !== 'darwin') return false // Core ML is macOS-only
  try {
    if (!fs.statSync(p).isDirectory()) return false
    return hasMlmodelc(fs.readdirSync(p))
  } catch {
    return false
  }
}

/** All image models on disk: GGUFs, custom .safetensors checkpoints, Core ML dirs. */
/** Every image type the library persists (persistImageGenerationOutput). One rule for listing, ownership, export. */
const GENERATED_IMAGE_FILE = /\.(png|jpe?g|webp)$/i

export function listImageModels(): string[] {
  const dir = modelsDir()
  let files: string[] = []
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }
  const ownedEntries = files
    .map((name) => ({ name, filePath: resolveExistingOwnedEntry(dir, name) }))
    .filter((entry): entry is { name: string; filePath: string } => entry.filePath !== null)
  const coreml = ownedEntries.filter((entry) => isCoreMLModelDir(entry.filePath)).map((e) => e.name)
  const checkpoints = ownedEntries
    .filter((entry) => isImageModelFile(entry.name))
    .map((e) => e.name)
  // MLX (mflux) models are virtual ids (mlx/…), not files in the models dir.
  // Appended last so the sd-cli default (Z-Image) stays the preferred pick.
  // mflux fetches its own weights from HF on first use (cached in userData).
  const mlx = mfluxAvailable() ? MFLUX_MODELS.map((m) => m.id) : []
  return [...coreml, ...checkpoints, ...mlx]
}

/** All generated images on disk, newest first (excludes step-preview files). */
export function listGeneratedImages(scope?: GeneratedImageScope): {
  path: string
  name: string
  mtime: number
  syncId?: string
  conversationId?: string
  projectId?: string | null
}[] {
  const dir = path.join(dataDir(), 'generated-images')
  try {
    let all = fs
      .readdirSync(dir)
      .filter((f) => GENERATED_IMAGE_FILE.test(f) && !f.startsWith('preview-'))
      .flatMap((f) => {
        const ownedImage = resolveExistingOwnedEntry(dir, f)
        if (!ownedImage) return []
        // The sidecar is the one owner of what is known about an image besides its bytes, including
        // the syncId that names it on the mesh. Read through that module so this scan and the sync
        // receiver cannot disagree about the shape.
        const meta = readGeneratedImageSidecar(ownedImage)
        return [
          {
            path: ownedImage,
            name: f,
            mtime: fs.statSync(ownedImage).mtimeMs,
            syncId: meta.syncId,
            conversationId: meta.conversationId,
            projectId: meta.projectId ?? null
          }
        ]
      })
      .sort((a, b) => b.mtime - a.mtime)
    if (scope?.conversationId) all = all.filter((r) => r.conversationId === scope.conversationId)
    else if (scope?.projectId) all = all.filter((r) => r.projectId === scope.projectId)
    return all
  } catch {
    return []
  }
}

/** Delete a generated image from disk. */
export function deleteGeneratedImage(p: string): boolean {
  try {
    const dir = path.join(dataDir(), 'generated-images')
    const ownedImage = resolveExistingOwnedPath(dir, p)
    if (!ownedImage || !GENERATED_IMAGE_FILE.test(ownedImage)) return false
    fs.unlinkSync(ownedImage)
    fs.rmSync(generatedImageSidecarPath(ownedImage), { force: true })
    return true
  } catch {
    return false
  }
}

// --- Style-preset thumbnails (bundled release assets; never hotlinked) --------
/** Map of style key -> bundled thumbnail path. */
export function listStyleThumbs(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const resources of resourceDirs()) {
    const directory = path.join(resources, 'style-thumbs')
    try {
      for (const file of fs.readdirSync(directory)) {
        const match = file.match(/^(.+)\.(png|jpe?g|webp)$/i)
        if (match && !out[match[1]!]) out[match[1]!] = path.join(directory, file)
      }
    } catch {
      /* this resource root does not contain style previews */
    }
  }
  return out
}

// --- LoRA adapters -----------------------------------------------------------
// LoRAs live in userData/models/loras as .safetensors. sd-cli applies them via
// the `--lora-model-dir` flag + `<lora:NAME:WEIGHT>` syntax injected into the
// prompt (NAME = filename without extension). Our checkpoints are quantized, so
// sd-cli auto-selects "at_runtime" apply mode (compatible, slightly slower).
function loraDir(): string {
  return path.join(modelsDir(), 'loras')
}

export interface LoraInfo {
  /** Filename without extension — the NAME used in <lora:NAME:weight>. */
  name: string
  /** Display label (name with separators tidied). */
  label: string
  file: string
  sizeBytes: number
}

/** List installed LoRA adapters. */
export function listLoras(): LoraInfo[] {
  const dir = loraDir()
  const out: LoraInfo[] = []
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!hasCheckpointExt(f)) continue
      const ownedFile = resolveExistingOwnedEntry(dir, f)
      if (!ownedFile) continue
      const name = stripCheckpointExt(f)
      let sizeBytes = 0
      try {
        sizeBytes = fs.statSync(ownedFile).size
      } catch {
        /* ignore */
      }
      out.push({ name, label: name.replace(/[_-]+/g, ' '), file: ownedFile, sizeBytes })
    }
  } catch {
    /* dir doesn't exist yet */
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

/** Absolute path to the LoRA folder (created on demand) — for "reveal in Finder". */
export function ensureLoraDir(): string {
  const dir = loraDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Download a LoRA .safetensors into the LoRA folder (HF resolve URLs, follows redirects). */
export async function downloadLora(
  url: string,
  filename: string,
  onProgress?: (pct: number) => void
): Promise<string> {
  const dir = ensureLoraDir()
  const dest = resolveOwnedDestination(dir, filename)
  if (!dest || !hasCheckpointExt(filename)) throw new Error('Invalid LoRA filename.')
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest
  const bridge = new NodeDownloadBridge(dir)
  await bridge.download(url, dest, {
    onProgress: (written, total) => {
      if (total > 0) onProgress?.(Math.round((written / total) * 100))
    }
  })
  return dest
}

/** Resolve the TAESD decoder for a model's family, if the file is installed.
 *  Returns null (so callers just skip taesd) when it isn't — the feature is a
 *  no-op until the tiny decoder is downloaded into the models dir. */
export function resolveTaesd(base: string): string | null {
  return resolveExistingOwnedEntry(modelsDir(), imageTaesdFilename(base))
}

/** Find a companion file (text encoder / vae) in the models dir by pattern. */
function findInModels(re: RegExp): string | null {
  try {
    const f = fs.readdirSync(modelsDir()).find((x) => re.test(x))
    return f ? resolveExistingOwnedEntry(modelsDir(), f) : null
  } catch {
    return null
  }
}

// A GGUF checkpoint is loadable via `-m` only if it's a FULL pipeline (UNET + VAE
// + text encoder). Many SDXL quants on HF (e.g. animagine-xl, illustrious) ship
// the UNET ONLY — sd.cpp then can't detect the version ("get sd version from file
// failed") and aborts. Those need `--diffusion-model` + separate CLIP + VAE.
// Detect by scanning the tensor-name table (near the file start) for VAE + CLIP
// namespaces. On any read error we assume FULL so models that already work aren't
// regressed. Cached by path+size+mtime. (Z-Image/FLUX are handled separately.)
const ggufFullCache = new Map<string, boolean>()
function ggufIsFullCheckpoint(p: string): boolean {
  if (!/\.gguf$/i.test(p)) return true // .safetensors checkpoints are full pipelines
  let key: string
  try {
    const st = fs.statSync(p)
    key = `${p}:${st.size}:${st.mtimeMs}`
  } catch {
    return true
  }
  const cached = ggufFullCache.get(key)
  if (cached !== undefined) return cached
  let full = true
  try {
    const fd = fs.openSync(p, 'r')
    try {
      // The tensor-name table sits just after the (tiny) KV metadata, well within
      // the first few MB even for 2600-tensor checkpoints.
      const buf = Buffer.alloc(Math.min(4_000_000, fs.fstatSync(fd).size))
      fs.readSync(fd, buf, 0, buf.length, 0)
      const s = buf.toString('latin1')
      const hasVae = s.includes('first_stage_model') || s.includes('vae.') || s.includes('.vae')
      const hasClip =
        s.includes('cond_stage_model') ||
        s.includes('conditioner') ||
        s.includes('text_encoder') ||
        s.includes('text_model')
      full = hasVae && hasClip
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    full = true
  }
  ggufFullCache.set(key, full)
  return full
}

/** The local image model selected by the shared control plane, as a native runtime id. */
export function activeImageModel(): string | null {
  const selected = desktopModelServices.llm.active('image').model
  if (!selected || selected.source !== 'local') return null
  return path.basename(imageRuntimeModelId(selected.id))
}

/** Translate a canonical catalog selection only at the native runtime boundary. */
function imageRuntimeModelId(selected: string): string {
  return desktopImageRuntimeIdentity.resolve(selected)
}

function resolveNativeModel(selected?: string): string | null {
  if (!selected) return null
  const dir = modelsDir()
  const runtimeId = imageRuntimeModelId(selected)
  if (isMfluxModelId(runtimeId)) return runtimeId
  return resolveExistingOwnedEntry(dir, runtimeId)
}

function fileSizeGb(filePath: string | null | undefined): number {
  try {
    return filePath ? fs.statSync(filePath).size / 1e9 : 0
  } catch {
    return 0
  }
}

async function inspectSourceDimensions(
  sourceImageUri: string | undefined
): Promise<{ width: number; height: number } | undefined> {
  if (!sourceImageUri) return undefined
  try {
    const { default: sharp } = await import('sharp')
    const metadata = await sharp(sourceImageUri).metadata()
    return metadata.width && metadata.height
      ? { width: metadata.width, height: metadata.height }
      : undefined
  } catch {
    return undefined
  }
}

function inspectMfluxFacts(
  runtimeId: string,
  persistentRequested: boolean
): ImageNativeExecutionFacts {
  if (!mfluxAvailable()) throw new Error('The selected MLX image runtime is not available.')
  return {
    modelIdentity: runtimeId,
    modelName: getMfluxModel(runtimeId)?.label ?? runtimeId,
    runtime: 'mflux',
    totalMemoryGb: os.totalmem() / 1e9,
    modelSizeGb: 0,
    zImage: false,
    fullCheckpoint: true,
    quantized: false,
    persistentRequested,
    sdServerAvailable: false,
    companions: {}
  }
}

/** Probe filesystem and native capability only. Shared owns every decision made from these facts. */
export async function inspectImageNativeExecution(input: {
  modelId: string
  sourceImageUri?: string
  persistentRequested: boolean
}): Promise<ImageNativeExecutionFacts> {
  const runtimeId = imageRuntimeModelId(input.modelId)
  if (isMfluxModelId(runtimeId)) {
    return inspectMfluxFacts(runtimeId, input.persistentRequested)
  }

  const model = resolveNativeModel(input.modelId)
  if (!model) throw new Error('The selected image model is not installed. Download it from Models.')
  const coreml = isCoreMLModelDir(model)
  if (coreml && !findCoreMLBin()) {
    throw new Error('Core ML helper (coreml-sd) not found in resources/bin/coreml-sd.')
  }
  if (!coreml && !findSdCli()) {
    throw new Error('Image generation binary (sd-cli) not found in resources/bin/sd.')
  }

  const zImage = !coreml && isZImageModel(path.basename(model))
  const zImageTextEncoder = zImage
    ? (findInModels(/qwen3-4b-instruct.*\.gguf$/i) ?? undefined)
    : undefined
  const zImageVae = zImage
    ? (findInModels(/^ae\.(safetensors|sft)$|^ae.*\.gguf$/i) ?? undefined)
    : undefined
  const fullCheckpoint = coreml || zImage || ggufIsFullCheckpoint(model)
  const sourceDimensions = await inspectSourceDimensions(input.sourceImageUri)

  return {
    modelIdentity: model,
    modelName: path.basename(model),
    runtime: coreml ? 'coreml' : 'stable-diffusion',
    totalMemoryGb: os.totalmem() / 1e9,
    modelSizeGb: fileSizeGb(model),
    zImage,
    fullCheckpoint,
    quantized: isQuantizedModel(path.basename(model)),
    persistentRequested: input.persistentRequested,
    sdServerAvailable: hasSdServer(),
    sourceDimensions,
    companions: {
      zImageTextEncoder,
      zImageVae,
      sdxlClipL: !fullCheckpoint
        ? (findInModels(/clip[_-]?l.*\.(safetensors|gguf)$/i) ?? undefined)
        : undefined,
      sdxlClipG: !fullCheckpoint
        ? (findInModels(/clip[_-]?g.*\.(safetensors|gguf)$/i) ?? undefined)
        : undefined,
      sdxlVae: !fullCheckpoint
        ? (findInModels(/(sdxl[_-]?vae|vae[_-]?sdxl|sdxl.*vae).*\.(safetensors|gguf)$/i) ??
          undefined)
        : undefined
    },
    companionSizeGb: {
      zImageTextEncoder: fileSizeGb(zImageTextEncoder),
      zImageVae: fileSizeGb(zImageVae)
    }
  }
}

registerDesktopImageInspectionBoundary(inspectImageNativeExecution)

/** Whether image generation is usable right now (binary + at least one model). */
export function imageGenStatus(): {
  available: boolean
  models: string[]
  active: string | null
  reason?: string
} {
  const models = listImageModels()
  // The model an incoming request would actually load (the user's active pick,
  // else the resolver default) — so the composer can default its picker to it and
  // match the Active-models panel, instead of guessing from a name heuristic (which
  // used to land on the parked Core ML model).
  const active = activeImageModel()
  // Available if EITHER runtime is usable: sd-cli (with a model) or MLX/mflux.
  if (!findSdCli() && !mfluxAvailable())
    return { available: false, models, active, reason: 'no image runtime found' }
  if (!models.length)
    return { available: false, models, active, reason: 'no image model installed' }
  return { available: true, models, active }
}

export type ImageGenParams = ImageGenerationRequestContract

export type ImageGenOutput = ImageGenerationOutputContract

/** Native runtimes receive the final prompt as input. The wrapper adds it to their output once. */
type NativeImageGenOutput = Omit<ImageGenOutput, 'prompt'>

export interface ImageGenProgress {
  step: number
  total: number
  secPerStep: number
  // sd-cli prints an "N/N - Xs/it" sequence for the denoising loop AND again for
  // the VAE-tiling decode. Tag which one so the UI shows "Decoding" instead of a
  // confusing second 0→N count.
  phase?: 'sampling' | 'decoding'
}

/** Which chat or project to narrow the gallery to. A filter, not the facts about an image. */
export interface GeneratedImageScope {
  conversationId?: string
  projectId?: string | null
}

/** Persist the chat/project owner beside a generated image.
 *
 * The image service owns this metadata because listing, filtering, deletion, and
 * export all depend on the same file boundary. Callers should not manufacture
 * sidecars themselves.
 */
export function saveGeneratedImageScope(imagePath: string, facts: GeneratedImageSidecar): void {
  const dir = path.join(dataDir(), 'generated-images')
  const ownedImage = resolveExistingOwnedPath(dir, imagePath)
  if (!ownedImage || !GENERATED_IMAGE_FILE.test(ownedImage)) {
    throw new Error('Generated image is outside the app image library.')
  }

  // Merged by the sidecar owner, not replaced here. The scope is saved AFTER the image has been
  // given its mesh identity, and the write this replaced dropped that identity on every save.
  writeGeneratedImageSidecar(ownedImage, facts)
}

/**
 * Keep the app's own copy of the image a generation was based on.
 *
 * The user picks an init image from their own disk, and nothing kept it: the path was handed to the
 * generator, used, and forgotten. So the moment that file moved or was deleted there was no record of
 * what an img2img turn was made from - "convert this into light mode" with nothing to show for the
 * thing being converted.
 *
 * Copies live in a `sources` subdirectory so the gallery scan, which reads PNG files in the directory
 * itself, does not list an input as though the user had generated it. Returns the copy's path, or null
 * when the source cannot be read - a generation is not worth failing over its provenance.
 */
export function preserveGeneratedImageSource(syncId: string, sourcePath: string): string | null {
  try {
    const directory = path.join(dataDir(), 'generated-images', 'sources')
    fs.mkdirSync(directory, { recursive: true })
    const extension = path.extname(sourcePath).toLowerCase() || '.png'
    const kept = path.join(directory, `${syncId}${extension}`)
    const temporary = `${kept}.part`
    try {
      fs.copyFileSync(sourcePath, temporary)
      fs.renameSync(temporary, kept)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
    return kept
  } catch (error) {
    console.error(
      `[imagegen] could not keep the init image: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return null
  }
}

/** Copy one app-owned generated image to a user-selected destination.
 *
 * The copy is promoted atomically so a full destination volume cannot replace
 * an existing export with truncated bytes.
 */
export async function exportGeneratedImage(imagePath: string, destination: string): Promise<void> {
  const dir = path.join(dataDir(), 'generated-images')
  const ownedImage = resolveExistingOwnedPath(dir, imagePath)
  if (!ownedImage || !GENERATED_IMAGE_FILE.test(ownedImage)) {
    throw new Error('Generated image is outside the app image library.')
  }

  const temporaryDestination = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${String(process.pid)}.${String(Date.now())}.tmp`
  )
  try {
    await fs.promises.copyFile(ownedImage, temporaryDestination)
    await fs.promises.rename(temporaryDestination, destination)
  } finally {
    await fs.promises.rm(temporaryDestination, { force: true })
  }
}

let currentChild: ChildProcess | null = null
let nativeExecutionActive = false

/** Kill the active native engine. Shared owns the public cancellation state machine. */
export function cancelImageNative(): boolean {
  const active = nativeExecutionActive
  cancelMflux() // no-op if mflux isn't the active runtime
  void sdServer.cancelCurrent() // cancels the in-flight job on the resident server (no-op if idle)
  currentChild?.kill('SIGKILL')
  return active
}

registerDesktopImageCancelBoundary(() => {
  cancelImageNative()
})

/** Cancel the shared image use case. Native cancellation runs through its boundary port. */
export function cancelImageGen(): boolean {
  const running = desktopImageApplication.isRunning()
  if (running) void desktopImageApplication.cancel()
  return running
}

/** Raw native image execution. Shared GenerationService owns routing, admission,
 * serialization, cancellation fencing, and residency before this function runs. */
export async function generateImageNative(
  plan: ImageExecutionPlan,
  onUpdate?: (update: ImageGenerationPipelineUpdateContract) => void,
  signal?: AbortSignal
): Promise<ImageGenOutput> {
  onUpdate?.({ stage: 'preparing', enhancedPrompt: plan.prompt })
  const progressObserver = onUpdate
    ? (progress: ImageGenProgress & { preview?: string }) =>
        onUpdate({
          stage: progress.phase === 'decoding' ? 'decoding' : 'generating',
          progress
        })
    : undefined
  const output = await runImageGen(plan, progressObserver, signal ?? new AbortController().signal)
  return { ...output, prompt: plan.prompt }
}

/** Public image execution uses the shared route and residency owner. The adapter
 * above this boundary calls generateImageNative, so no generation path recurses. */
export async function generateImage(
  params: ImageGenParams,
  onUpdate?: (update: ImageGenerationPipelineUpdateContract) => void
): Promise<ImageGenOutput> {
  return desktopImageApplication.start(params, onUpdate)
}

async function runImageGen(
  plan: ImageExecutionPlan,
  onProgress?: (p: ImageGenProgress & { preview?: string }) => void,
  signal: AbortSignal = new AbortController().signal
): Promise<NativeImageGenOutput> {
  if (signal.aborted) throw new Error(IMAGE_CANCELLED_MESSAGE)
  nativeExecutionActive = true
  const cancelOnAbort = (): void => {
    cancelImageNative()
  }
  signal.addEventListener('abort', cancelOnAbort, { once: true })
  try {
    // --- MLX / mflux runtime branch (FLUX / Z-Image with native LoRA) ----------
    // Self-contained: reuses the single-flight guard; the LLM is already evicted by the
    // queue (evicts: ['llm']) before we get here, then delegates the spawn to the mflux
    // module. Returns before the sd-cli path.
    const selectedModel = plan.modelIdentity
    if (plan.engine === 'mflux') {
      const def = getMfluxModel(selectedModel)!
      const outDir = path.join(dataDir(), 'generated-images')
      fs.mkdirSync(outDir, { recursive: true })
      const outPath = path.join(outDir, `img-${String(Date.now())}.png`)
      await runMflux(
        {
          prompt: plan.prompt,
          model: selectedModel,
          width: plan.width,
          height: plan.height,
          steps: plan.steps,
          seed: plan.seed,
          // mflux --lora-paths wants a full path or HF repo (not a bare name like
          // sd-cli's --lora-model-dir). Resolve a bare filename to the loras dir;
          // pass absolute paths and HF repo ids (contain '/') through unchanged.
          loras: plan.loras.map((l) => {
            if (path.isAbsolute(l.name) || l.name.includes('/')) return l
            const local = resolveExistingOwnedEntry(loraDir(), ensureCheckpointExt(l.name))
            return local ? { ...l, name: local } : l
          })
        },
        outPath,
        (p) => onProgress?.({ step: p.step, total: p.total, secPerStep: p.secPerStep })
      )
      if (!fs.existsSync(outPath)) throw new Error('MLX generation produced no output file.')
      const b64 = fs.readFileSync(outPath).toString('base64')
      return {
        dataUrl: `data:image/png;base64,${b64}`,
        path: outPath,
        seed: plan.seed ?? -1,
        model: def.label
      }
    }
    const model = plan.modelIdentity
    // Core ML models are directories of .mlmodelc resources → routed to the ANE
    // Swift helper; everything else (GGUF) runs on sd-cli.
    const coreml = plan.engine === 'coreml'
    const cli = coreml ? findCoreMLBin() : findSdCli()
    if (!cli) {
      throw new Error(
        coreml
          ? 'Core ML helper (coreml-sd) not found in resources/bin/coreml-sd.'
          : 'Image generation binary (sd-cli) not found in resources/bin/sd.'
      )
    }

    const loras = plan.loras

    const outDir = path.join(dataDir(), 'generated-images')
    fs.mkdirSync(outDir, { recursive: true })
    const seed = plan.seed ?? -1
    const stamp = String(Date.now())
    const outPath = path.join(outDir, `img-${stamp}.png`)
    const previewPath = path.join(outDir, `preview-${stamp}.png`)

    const base = path.basename(model)
    const isZImage = Boolean(plan.companions.zImageTextEncoder)

    // --- RESIDENT fast path (opt-in) --------------------------------------------
    // When the user sets image residency to 'resident', a plain full-checkpoint
    // txt2img (no LoRA, no init image, not Z-Image, not Core ML) runs on the warm
    // sd-server: it keeps the model loaded across images (~45s cold -> ~7s warm on
    // M4), same steps/quality. This was previously removed for causing memory
    // contention on 16GB — now SAFE because the ModalityQueue evicts the LLM before
    // image gen (evicts:['llm']) AND evicts this server when another modality needs
    // the RAM. Operation residency skips this path and uses the one-shot sd-cli.
    if (plan.engine === 'sd-server') {
      const taesd = plan.fastVae ? resolveTaesd(base) : undefined
      await sdServer.ensureUp({
        modelPath: model,
        diffusionFa: true,
        taesdPath: taesd ?? undefined
      })
      const { png, seed: usedSeed } = await sdServer.generate({
        prompt: plan.prompt,
        negativePrompt: plan.negativePrompt,
        width: plan.width,
        height: plan.height,
        steps: plan.steps,
        cfgScale: plan.guidanceScale,
        sampleMethod: plan.sampleMethod,
        scheduler: plan.scheduler,
        seed
      })
      await fs.promises.writeFile(outPath, png)
      return {
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        path: outPath,
        seed: usedSeed,
        model: base
      }
    }

    // --- Persistent sd-server fast path -----------------------------------------
    // A plain full-pipeline checkpoint doing txt2img (no LoRA, no init image) runs
    // on the RESIDENT sd-server, which keeps the model loaded across images: the
    // first image pays the ~13s Metal shader warmup + model load, but every image
    // after skips BOTH (measured ~45s cold -> ~7s warm on an M4). The step count /
    // resolution / quality are UNCHANGED — this only removes per-image warmup and
    // reload. Special stacks stay on one-shot sd-cli below: Z-Image (3-file stack),
    // Core ML (ANE), UNET-only checkpoints needing separate CLIP+VAE, img2img, and
    // LoRA (sd.cpp can't merge a LoRA into quantized weights anyway).
    // NOTE: a persistent sd-server fast path once lived here but is removed — it kept
    // ~4GB of image weights resident alongside the ~5GB chat model, causing memory
    // contention -> hangs + corrupted output on 16GB machines, and was never verified
    // end-to-end in-app. All full-checkpoint txt2img goes through the one-shot sd-cli
    // path below: it loads the model, generates with the karras/defaults, and FREES it
    // on exit (no resident pressure). sdServer.cancelCurrent() above stays a harmless
    // no-op. Re-introduce a resident server only if proven safe on 16GB + good output.

    const threads = String(Math.max(1, os.cpus().length - 2))
    // Live preview: write a rough partial image every step ('proj' needs no extra
    // model) so the UI can show the image forming step-by-step.
    const previewArgs = [
      '--preview',
      'proj',
      '--preview-path',
      previewPath,
      '--preview-interval',
      '1'
    ]

    let args: string[]
    if (coreml) {
      // Core ML (ANE) helper — directory model, prompt to PNG. No preview file.
      args = buildCoreMLArgs({
        model,
        prompt: plan.prompt,
        outPath,
        steps: plan.steps,
        seed,
        negativePrompt: plan.negativePrompt
      })
    } else if (isZImage) {
      // Z-Image is a separate stack: diffusion transformer + Qwen3-4B text encoder
      // (--llm) + FLUX VAE (--vae). Resolve the companion files here (I/O); the
      // pure builder assembles the flags with the turbo defaults.
      const llm = plan.companions.zImageTextEncoder!
      const vae = plan.companions.zImageVae!
      args = buildZImageArgs({
        model,
        llm,
        vae,
        prompt: plan.prompt,
        outPath,
        width: plan.width,
        height: plan.height,
        steps: plan.steps,
        cfgScale: plan.guidanceScale,
        seed,
        threads,
        previewArgs,
        sampleMethod: plan.sampleMethod
      })
    } else {
      // Full checkpoint → load with -m. UNET-only quant → load the diffusion model
      // separately and supply SDXL CLIP-L/CLIP-G + VAE; if those companions aren't
      // installed, fail with a clear message instead of the cryptic sd.cpp abort.
      let modelFlags: string[]
      if (!plan.companions.sdxlClipL) {
        modelFlags = ['-m', model]
      } else {
        modelFlags = [
          '--diffusion-model',
          model,
          '--clip_l',
          plan.companions.sdxlClipL,
          '--clip_g',
          plan.companions.sdxlClipG!,
          '--vae',
          plan.companions.sdxlVae!
        ]
      }
      // Per-model defaults (steps/cfg/schedule/size) come from the shared
      // standardModelDefaults inside the pure builder — single source of truth.
      // TAESD decode is OFF by default; resolve it here (I/O) only when fastVae is
      // set, and the builder decides taesd-vs-vae-tiling.
      const cliTaesd = plan.fastVae ? resolveTaesd(base) : null
      args = buildStandardArgs({
        base,
        modelFlags,
        prompt: plan.prompt,
        outPath,
        width: plan.width,
        height: plan.height,
        steps: plan.steps,
        cfgScale: plan.guidanceScale,
        seed,
        threads,
        previewArgs,
        taesdPath: cliTaesd,
        negativePrompt: plan.negativePrompt,
        initImage: plan.sourceImageUri,
        strength: plan.strength,
        sampleMethod: plan.sampleMethod,
        scheduler: plan.scheduler
      })
    }

    // Point sd-cli at the LoRA folder so the <lora:NAME:weight> tags resolve.
    if (!coreml && loras.length) {
      args.push('--lora-model-dir', loraDir())
    }

    // CRITICAL on Apple Silicon (unified memory): the LLM (gemma) and the image
    // model can't both be resident — together they overflow RAM and the whole
    // system swaps/hangs. The ModalityQueue has already evicted the LLM (evicts:
    // ['llm']) AND blocks the capture pipeline from respawning it while this heavy
    // tier-2 job holds the slot.
    // Give the OS time to actually reclaim the freed LLM pages before the image
    // model's load spike — otherwise the brief overlap causes a short stutter.
    try {
      let resolvedSeed = seed
      await new Promise<void>((resolve, reject) => {
        // cwd at the binary dir so @executable_path rpath resolves libstable-diffusion.dylib.
        const child = spawn(cli, args, { cwd: path.dirname(cli) })
        currentChild = child
        let log = ''
        // Pure progress reducer owns the seed parse + the denoise->decode phase
        // transition; the shell only handles the preview PNG read + the callback.
        let progress = initialProgressState(seed)
        let progressBuffer = ''
        const capture = (d: Buffer): void => {
          const s = d.toString()
          log += s
          // Terminal progress lines can arrive across multiple data chunks. Keep a
          // short rolling buffer so "12/" and "42" still become step 12 of 42.
          progressBuffer = `${progressBuffer}${s}`.slice(-2048)
          const { state, event } = reduceProgress(progress, progressBuffer, plan.steps)
          progress = state
          if (onProgress && event) {
            let preview: string | undefined
            try {
              if (fs.existsSync(previewPath))
                preview = `data:image/png;base64,${fs.readFileSync(previewPath).toString('base64')}`
            } catch {
              /* preview not ready */
            }
            onProgress({ ...event, preview })
          }
        }
        child.stdout.on('data', capture)
        child.stderr.on('data', capture)
        child.on('error', reject)
        child.on('close', (code) => {
          if (signal.aborted) {
            reject(new Error(IMAGE_CANCELLED_MESSAGE))
          } else if (code === 0) {
            // stash the resolved seed for the caller via closure
            resolvedSeed = progress.resolvedSeed
            resolve()
          } else {
            reject(new Error(`Image generation failed (exit ${String(code)}): ${log.slice(-400)}`))
          }
        })
      })

      if (!fs.existsSync(outPath)) throw new Error('Image generation produced no output file.')
      const b64 = fs.readFileSync(outPath).toString('base64')
      return {
        dataUrl: `data:image/png;base64,${b64}`,
        path: outPath,
        seed: resolvedSeed,
        model: path.basename(model)
      }
    } finally {
      currentChild = null
      fs.promises.unlink(previewPath).catch(() => {})
      // LLM warm-back-up happens once in the generateImage() wrapper's finally
      // (covers both this sd-cli path and the mflux path).
    }
  } finally {
    signal.removeEventListener('abort', cancelOnAbort)
    nativeExecutionActive = false
    currentChild = null
  }
}

/** Image generation as a ManagedRuntime for the shared residency seam. Only the
 *  RESIDENT sd-server holds memory between images; evict stops it so another
 *  modality can reclaim the RAM. warm/release are no-ops — the server lazily
 *  re-spawns on the next eligible resident generation (ensureUp), and the one-shot
 *  sd-cli/mflux paths hold nothing between jobs. */
export const imageRuntime: DesktopManagedRuntime = {
  modality: 'image',
  evict: () => {
    sdServer.stop()
  },
  warm: () => {
    /* lazily re-spawned by ensureUp on the next resident generation */
  },
  release: () => {
    sdServer.stop()
  }
}
