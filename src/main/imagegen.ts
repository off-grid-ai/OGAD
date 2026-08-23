// On-device image generation via stable-diffusion.cpp (the bundled `sd-cli`).
// Mirrors the llm.ts pattern: resolve the binary from resources/bin, pick a
// Stable Diffusion model from the userData models dir, spawn one-shot txt2img/
// img2img, persist the PNG under userData/generated-images, return a data URL.

import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { modalityQueue, IMAGE_JOB, CHAT_JOB } from './modality-queue/queue'
import { getResidencyMode } from './runtime-residency'
import { llm } from './llm'
import { getSetting } from './database'
import {
  generatedImageSidecarPath,
  readGeneratedImageSidecar,
  writeGeneratedImageSidecar,
  type GeneratedImageSidecar
} from './imagegen/gallery-sidecar'
import { enhancePrompt } from './imagegen/prompt-enhance'
import type { ManagedRuntime } from './runtime-manager'
import {
  isMfluxModelId,
  mfluxAvailable,
  getMfluxModel,
  runMflux,
  cancelMflux,
  MFLUX_MODELS
} from './mflux'
import { getActiveModal } from './active-models'
import { binRoots, dataDir, modelsDir, resourceDirs, exe } from './runtime-env'
import { sdServer } from './sd-server'
import { standardModelDefaults, taesdFilename } from '../shared/image-defaults'
import { defaultImageModelFilename } from './image-default'
import { hasMlmodelc, isZImageModel, isQuantizedModel } from './imagegen/runtime-detect'
import {
  isImageModelFile,
  hasCheckpointExt,
  stripCheckpointExt,
  ensureCheckpointExt
} from './imagegen/model-filter'
import { evaluateMemoryGuard } from './imagegen/memory-guard'
import {
  buildCoreMLArgs,
  buildZImageArgs,
  buildStandardArgs,
  DEFAULT_NEGATIVE
} from './imagegen/args'
import { initialProgressState, reduceProgress } from './imagegen/progress'
import {
  resolveExistingOwnedEntry,
  resolveExistingOwnedPath,
  resolveOwnedDestination
} from './imagegen/owned-path'
import { IMAGE_CANCELLED_MESSAGE, ImageGenerationLifecycle } from './imagegen/generation-lifecycle'
import {
  imageMemoryGuardErrorMessage,
  type ImageGenerationPipelineUpdateContract,
  type ImageGenerationOutputContract,
  type ImageGenerationRequestContract
} from '../shared/image-generation-contract'

function findSdCli(): string | null {
  for (const r of binRoots()) {
    const p = path.join(r, 'sd', exe('sd-cli'))
    if (fs.existsSync(p)) return p
  }
  return null
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
      .filter((f) => /\.png$/i.test(f) && !f.startsWith('preview-'))
      .map((f) => {
        const p = path.join(dir, f)
        // The sidecar is the one owner of what is known about an image besides its bytes, including
        // the syncId that names it on the mesh. Read through that module so this scan and the sync
        // receiver cannot disagree about the shape.
        const meta = readGeneratedImageSidecar(p)
        return {
          path: p,
          name: f,
          mtime: fs.statSync(p).mtimeMs,
          syncId: meta.syncId,
          conversationId: meta.conversationId,
          projectId: meta.projectId ?? null
        }
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
    if (!ownedImage || !/\.png$/i.test(ownedImage)) return false
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
        const match = file.match(/^(.+)\.png$/i)
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
  const res = await fetch(url) // Electron main = Node 18+, follows redirects (HF → CDN)
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  const tmp = `${dest}.part`
  const out = fs.createWriteStream(tmp)
  let received = 0
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out.write(Buffer.from(value))
      received += value.length
      if (total && onProgress) onProgress(Math.round((received / total) * 100))
    }
  } finally {
    await new Promise<void>((r) => out.end(r))
  }
  fs.renameSync(tmp, dest)
  return dest
}

/** Resolve the TAESD decoder for a model's family, if the file is installed.
 *  Returns null (so callers just skip taesd) when it isn't — the feature is a
 *  no-op until the tiny decoder is downloaded into the models dir. */
export function resolveTaesd(base: string): string | null {
  return resolveExistingOwnedEntry(modelsDir(), taesdFilename(base))
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

/** Pick a model: the requested filename if present, else prefer the higher-quality v2.1, else any. */
/** The image model an incoming request would actually load (active pick, else the
 *  resolver's default), as a bare filename — or null if none installed. */
export function activeImageModel(): string | null {
  const m = resolveModel()
  return m ? path.basename(m) : null
}

function resolveModel(preferred?: string): string | null {
  const dir = modelsDir()
  if (preferred) {
    const preferredPath = resolveExistingOwnedEntry(dir, preferred)
    if (preferredPath) return preferredPath
  }
  const sd = listImageModels()
  if (!sd.length) return null
  // User-chosen image model is the default when the caller didn't request one.
  const chosen = getActiveModal('image')
  if (chosen) {
    const chosenPath = resolveExistingOwnedEntry(dir, chosen)
    if (chosenPath) return chosenPath
    if (sd.includes(chosen)) return path.join(dir, chosen) // mlx/virtual id
  }
  // Smart default: DreamShaper XL v2 Turbo (the versatile default), RAM-aware —
  // a fresh user on <=16GB gets the Light (Q4) quant, >16GB gets the full (Q8).
  // Only when the user hasn't picked (getActiveModal above). Falls through to the
  // generic heuristic below when no DreamShaper quant is installed.
  const dreamshaper = defaultImageModelFilename(sd, os.totalmem() / 1e9)
  if (dreamshaper) return path.join(dir, dreamshaper)
  // Preference: Juggernaut XL v9 (default photoreal) > Z-Image-Turbo >
  // SDXL-Lightning > SDXL > SD 2.1 > anything else.
  const juggernaut = sd.find((f) => /juggernaut/i.test(f))
  const zimage = sd.find((f) => /z[-_]?image/i.test(f))
  const lightning = sd.find((f) => /lightning/i.test(f))
  const xl = sd.find((f) => /sdxl|xl/i.test(f))
  const v21 = sd.find((f) => /v2-1|v2\.1/i.test(f))
  return path.join(dir, juggernaut ?? zimage ?? lightning ?? xl ?? v21 ?? sd[0]!) // sd.length checked above
}

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
  if (!ownedImage || !/\.png$/i.test(ownedImage)) {
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
  if (!ownedImage || !/\.png$/i.test(ownedImage)) {
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
const generationLifecycle = new ImageGenerationLifecycle()

/** Kill an in-progress generation. Returns true if one was running. */
export function cancelImageGen(): boolean {
  cancelMflux() // no-op if mflux isn't the active runtime
  void sdServer.cancelCurrent() // cancels the in-flight job on the resident server (no-op if idle)
  if (!generationLifecycle.cancel()) return false
  // Cancellation owns the whole generation lifecycle, including the memory-reclaim
  // delay and native-server startup windows before a child/request exists. Recording
  // intent only when currentChild was set let Stop return true, then launch sd-cli
  // after the user had already cancelled.
  if (currentChild) {
    currentChild.kill('SIGKILL')
  }
  return true // mflux/persistent-server gen has no currentChild but still owns the lifecycle
}

/**
 * Public entry: run image generation through the ModalityQueue so the image model
 * can't be resident alongside the chat model on unified memory. `evicts: ['llm']`
 * frees the llama-server before generation starts — the exact guard the old inline
 * llm.pause() did, now owned by the queue (see modality-queue/queue.ts). When the
 * queue is disabled it just runs immediately (prior concurrent behavior).
 */
export async function generateImage(
  params: ImageGenParams,
  onUpdate?: (update: ImageGenerationPipelineUpdateContract) => void
): Promise<ImageGenOutput> {
  // Prompt enhancement runs FIRST, while the chat model is still resident — the
  // image job below evicts the LLM, so the text pass must precede it. Gated by a
  // setting; failure/timeout silently keeps the original prompt.
  const enhanced = await maybeEnhancePrompt(params.prompt, onUpdate)
  const effective = enhanced === params.prompt ? params : { ...params, prompt: enhanced }
  onUpdate?.({ stage: 'preparing', enhancedPrompt: enhanced })
  const progressObserver = onUpdate
    ? (progress: ImageGenProgress & { preview?: string }) =>
        onUpdate({
          stage: progress.phase === 'decoding' ? 'decoding' : 'generating',
          progress
        })
    : undefined
  // The queue evicts 'llm' before this runs AND re-warms it (mode-aware) when the
  // job finishes — so the image path no longer touches llm.pause/resume itself.
  const output = await modalityQueue.run(IMAGE_JOB, () => runImageGen(effective, progressObserver))
  return { ...output, prompt: effective.prompt }
}

/** Expand the user's prompt into a richer generation prompt via the local text
 *  model, when `enhanceImagePrompts` is on. Runs through the queue as a foreground
 *  text job (tier 2, evicts a resident image server) so it's serialized with chat.
 *  Any failure returns the original prompt unchanged — enhancement is best-effort. */
async function maybeEnhancePrompt(
  prompt: string,
  onUpdate?: (update: ImageGenerationPipelineUpdateContract) => void
): Promise<string> {
  const enabled = getSetting('enhanceImagePrompts', true)
  if (enabled) onUpdate?.({ stage: 'enhancing', enhancedPrompt: '' })
  let streamed = ''
  return enhancePrompt(prompt, {
    enabled,
    onText: (text) => {
      streamed += text
      onUpdate?.({ stage: 'enhancing', enhancedPrompt: streamed })
    },
    // Foreground text job (tier 2, evicts a resident image server), serialized with
    // chat. Runs while the chat model is still resident — the image job evicts it after.
    chat: (instruction, onText) =>
      modalityQueue.run(CHAT_JOB, () =>
        llm
          .chatStream(
            instruction,
            [],
            (text, kind) => {
              if (kind === 'content') onText(text)
            },
            { temperature: 0.7, thinking: false },
            200,
            60_000
          )
          .then((result) => result.content)
      )
  })
}

async function runImageGen(
  params: ImageGenParams,
  onProgress?: (p: ImageGenProgress & { preview?: string }) => void
): Promise<NativeImageGenOutput> {
  if (generationLifecycle.isRunning()) {
    throw new Error('An image is already generating — please wait for it to finish.')
  }
  if (!params.prompt.trim()) throw new Error('A prompt is required.')

  // --- MLX / mflux runtime branch (FLUX / Z-Image with native LoRA) ----------
  // Self-contained: reuses the single-flight guard; the LLM is already evicted by the
  // queue (evicts: ['llm']) before we get here, then delegates the spawn to the mflux
  // module. Returns before the sd-cli path.
  if (isMfluxModelId(params.model)) {
    const def = getMfluxModel(params.model)!
    const outDir = path.join(dataDir(), 'generated-images')
    fs.mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `img-${String(Date.now())}.png`)
    generationLifecycle.start()
    // Give the OS a moment to reclaim the freed LLM pages before the image load spike.
    try {
      await generationLifecycle.waitForMemoryReclaim()
      await runMflux(
        {
          prompt: params.prompt,
          model: params.model!,
          width: params.width,
          height: params.height,
          steps: params.steps,
          seed: params.seed,
          // mflux --lora-paths wants a full path or HF repo (not a bare name like
          // sd-cli's --lora-model-dir). Resolve a bare filename to the loras dir;
          // pass absolute paths and HF repo ids (contain '/') through unchanged.
          loras: (params.loras ?? []).map((l) => {
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
        seed: params.seed ?? -1,
        model: def.label
      }
    } finally {
      generationLifecycle.finish()
      currentChild = null
      // LLM warm-back-up happens once in the generateImage() wrapper's finally.
    }
  }

  // img2img: if the caller didn't pin a size, match the init image's dimensions
  // (rounded to /64). Avoids silently upscaling a 512px input to the model's 1024
  // default — which is much slower and can blow past client timeouts.
  if (params.initImage && (!params.width || !params.height)) {
    try {
      const sharp = (await import('sharp')).default
      const meta = await sharp(params.initImage).metadata()
      if (meta.width && meta.height) {
        const r64 = (n: number): number => Math.max(256, Math.min(2048, Math.round(n / 64) * 64))
        params.width = params.width ?? r64(meta.width)
        params.height = params.height ?? r64(meta.height)
      }
    } catch {
      /* fall back to model defaults */
    }
  }

  const model = resolveModel(params.model)
  if (!model) throw new Error('No image model installed. Download one from Models.')
  // Core ML models are directories of .mlmodelc resources → routed to the ANE
  // Swift helper; everything else (GGUF) runs on sd-cli.
  const coreml = isCoreMLModelDir(model)
  const cli = coreml ? findCoreMLBin() : findSdCli()
  if (!cli) {
    throw new Error(
      coreml
        ? 'Core ML helper (coreml-sd) not found in resources/bin/coreml-sd.'
        : 'Image generation binary (sd-cli) not found in resources/bin/sd.'
    )
  }

  // Memory guard (GGUF only) — on Apple Silicon unified memory, an oversized
  // model swaps to disk and FREEZES the machine. Refuse rather than freeze.
  // Core ML runs on the ANE with its own streaming, so it's exempt.
  // Reserve scales with RAM so an 8GB machine isn't blocked outright (a flat
  // 7GB reserve would leave it ~1GB and reject everything).
  const totalGb = os.totalmem() / 1e9
  const safeSizeGb = (p: string | null | undefined): number => {
    try {
      return p && fs.existsSync(p) ? fs.statSync(p).size / 1e9 : 0
    } catch {
      return 0
    }
  }
  // Z-Image is a 3-model stack (diffusion transformer + Qwen3-4B text encoder +
  // FLUX VAE) all resident at once — the diffusion file alone wildly understates
  // its footprint. Count the encoder + VAE too, or the guard waves through a
  // combo that then overflows unified memory and freezes the box.
  const zImageStack = isZImageModel(path.basename(model))
  const guard = evaluateMemoryGuard({
    totalGb,
    modelSizeGb: safeSizeGb(model),
    coreml,
    zImageStack,
    zEncoderGb: zImageStack ? safeSizeGb(findInModels(/qwen3-4b-instruct.*\.gguf$/i)) : 0,
    zVaeGb: zImageStack ? safeSizeGb(findInModels(/^ae\.(safetensors|sft)$|^ae.*\.gguf$/i)) : 0
  })
  if (guard.overBudget && !params.allowUnsafeMemoryOverride) {
    throw new Error(
      imageMemoryGuardErrorMessage(
        `Not enough memory to run ${path.basename(model)} (~${guard.modelGb.toFixed(1)}GB resident) on this ${totalGb.toFixed(0)}GB machine. ` +
          `Pick a lighter image model (e.g. SDXL-Lightning or SD 1.5) in the image options.`
      )
    )
  }

  // LoRA adapters: inject <lora:NAME:WEIGHT> into the prompt (Core ML helper
  // doesn't support LoRA, so skip there). The --lora-model-dir flag is added to
  // the sd-cli args below.
  const loras = (params.loras || []).filter((l) => l.name && Number.isFinite(l.weight))
  if (!coreml && loras.length) {
    // HARD LIMIT: stable-diffusion.cpp can only merge a LoRA into FULL-PRECISION
    // (f16/f32) weights. Our shipped checkpoints are quantized (q8_0 / Q4_K) to
    // save disk, and the LoRA merge then aborts the binary (Metal: unsupported
    // op CPY/ADD; CPU: GGML_ASSERT src1->type == F32). Fail with a clear message
    // instead of crash-aborting. Re-enable once an f16 base model ships.
    if (isQuantizedModel(path.basename(model))) {
      throw new Error(
        `LoRAs can't be applied to "${path.basename(model)}" — it's a quantized model, and the image engine can only merge a LoRA into a full-precision (f16) model. LoRA support needs a non-quantized base model (not yet shipped).`
      )
    }
    const tags = loras.map((l) => `<lora:${l.name}:${l.weight}>`).join(' ')
    params.prompt = `${params.prompt} ${tags}`
  }

  const outDir = path.join(dataDir(), 'generated-images')
  fs.mkdirSync(outDir, { recursive: true })
  const seed = params.seed ?? -1
  const stamp = String(Date.now())
  const outPath = path.join(outDir, `img-${stamp}.png`)
  const previewPath = path.join(outDir, `preview-${stamp}.png`)

  const base = path.basename(model)
  const isZImage = isZImageModel(base)

  // --- RESIDENT fast path (opt-in) --------------------------------------------
  // When the user sets image residency to 'resident', a plain full-checkpoint
  // txt2img (no LoRA, no init image, not Z-Image, not Core ML) runs on the warm
  // sd-server: it keeps the model loaded across images (~45s cold -> ~7s warm on
  // M4), same steps/quality. This was previously removed for causing memory
  // contention on 16GB — now SAFE because the ModalityQueue evicts the LLM before
  // image gen (evicts:['llm']) AND evicts this server when another modality needs
  // the RAM (image is registered as a ManagedRuntime). Default is 'on-demand',
  // which skips this entirely and uses the one-shot sd-cli path below (unchanged).
  const residentImage = getResidencyMode('image') === 'resident'
  const eligibleForServer =
    residentImage &&
    !onProgress &&
    !coreml &&
    !isZImage &&
    !loras.length &&
    !params.initImage &&
    ggufIsFullCheckpoint(model)
  if (eligibleForServer) {
    const { defaultSize, defaultSteps, defaultCfg, sampler, scheduler } =
      standardModelDefaults(base)
    const taesd = params.fastVae ? resolveTaesd(base) : undefined
    generationLifecycle.start()
    try {
      await sdServer.ensureUp({
        modelPath: model,
        diffusionFa: true,
        taesdPath: taesd ?? undefined
      })
      generationLifecycle.throwIfCancelled()
      const { png, seed: usedSeed } = await sdServer.generate({
        prompt: params.prompt,
        negativePrompt: params.negativePrompt?.trim() || DEFAULT_NEGATIVE,
        width: params.width ?? defaultSize,
        height: params.height ?? defaultSize,
        steps: params.steps ?? defaultSteps,
        cfgScale: params.cfgScale ?? defaultCfg,
        sampleMethod: sampler,
        scheduler,
        seed
      })
      await fs.promises.writeFile(outPath, png)
      return {
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        path: outPath,
        seed: usedSeed,
        model: base
      }
    } finally {
      generationLifecycle.finish()
      currentChild = null
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
      prompt: params.prompt,
      outPath,
      steps: params.steps,
      seed,
      negativePrompt: params.negativePrompt
    })
  } else if (isZImage) {
    // Z-Image is a separate stack: diffusion transformer + Qwen3-4B text encoder
    // (--llm) + FLUX VAE (--vae). Resolve the companion files here (I/O); the
    // pure builder assembles the flags with the turbo defaults.
    const llm = findInModels(/qwen3-4b-instruct.*\.gguf$/i)
    const vae = findInModels(/^ae\.(safetensors|sft)$|^ae.*\.gguf$/i)
    if (!llm)
      throw new Error(
        'Z-Image text encoder (Qwen3-4B-Instruct) not found — download it from Models.'
      )
    if (!vae) throw new Error('Z-Image VAE (ae.safetensors) not found — download it from Models.')
    args = buildZImageArgs({
      model,
      llm,
      vae,
      prompt: params.prompt,
      outPath,
      width: params.width,
      height: params.height,
      steps: params.steps,
      cfgScale: params.cfgScale,
      seed,
      threads,
      previewArgs
    })
  } else {
    // Full checkpoint → load with -m. UNET-only quant → load the diffusion model
    // separately and supply SDXL CLIP-L/CLIP-G + VAE; if those companions aren't
    // installed, fail with a clear message instead of the cryptic sd.cpp abort.
    let modelFlags: string[]
    if (ggufIsFullCheckpoint(model)) {
      modelFlags = ['-m', model]
    } else {
      const clipL = findInModels(/clip[_-]?l.*\.(safetensors|gguf)$/i)
      const clipG = findInModels(/clip[_-]?g.*\.(safetensors|gguf)$/i)
      const sdxlVae = findInModels(/(sdxl[_-]?vae|vae[_-]?sdxl|sdxl.*vae).*\.(safetensors|gguf)$/i)
      if (clipL && clipG && sdxlVae) {
        modelFlags = [
          '--diffusion-model',
          model,
          '--clip_l',
          clipL,
          '--clip_g',
          clipG,
          '--vae',
          sdxlVae
        ]
      } else {
        const dir = modelsDir()
        const usable = listImageModels()
          .filter(
            (f) => /z[-_]?image|lightning/i.test(f) || ggufIsFullCheckpoint(path.join(dir, f))
          )
          .map((f) => path.basename(f))
        throw new Error(
          `"${base}" is a UNET-only model — it has no built-in text encoder or VAE, so it can't generate on its own ` +
            `(it needs SDXL CLIP-L, CLIP-G and a VAE, which aren't installed). ` +
            (usable.length
              ? `Pick a complete model instead: ${usable.slice(0, 4).join(', ')}.`
              : `Download a complete checkpoint (e.g. SDXL-Lightning) or Z-Image.`)
        )
      }
    }
    // Per-model defaults (steps/cfg/schedule/size) come from the shared
    // standardModelDefaults inside the pure builder — single source of truth.
    // TAESD decode is OFF by default; resolve it here (I/O) only when fastVae is
    // set, and the builder decides taesd-vs-vae-tiling.
    const cliTaesd = params.fastVae ? resolveTaesd(base) : null
    args = buildStandardArgs({
      base,
      modelFlags,
      prompt: params.prompt,
      outPath,
      width: params.width,
      height: params.height,
      steps: params.steps,
      cfgScale: params.cfgScale,
      seed,
      threads,
      previewArgs,
      taesdPath: cliTaesd,
      negativePrompt: params.negativePrompt,
      initImage: params.initImage,
      strength: params.strength
    })
  }

  // Point sd-cli at the LoRA folder so the <lora:NAME:weight> tags resolve.
  if (!coreml && loras.length) {
    args.push('--lora-model-dir', loraDir())
  }

  generationLifecycle.start()
  // CRITICAL on Apple Silicon (unified memory): the LLM (gemma) and the image
  // model can't both be resident — together they overflow RAM and the whole
  // system swaps/hangs. The ModalityQueue has already evicted the LLM (evicts:
  // ['llm']) AND blocks the capture pipeline from respawning it while this heavy
  // tier-2 job holds the slot.
  // Give the OS time to actually reclaim the freed LLM pages before the image
  // model's load spike — otherwise the brief overlap causes a short stutter.
  try {
    await generationLifecycle.waitForMemoryReclaim()
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
        const { state, event } = reduceProgress(progress, progressBuffer, params.steps)
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
        if (generationLifecycle.isCancelled()) {
          reject(new Error(IMAGE_CANCELLED_MESSAGE))
        } else if (code === 0) {
          // stash the resolved seed for the caller via closure
          ;(params as ImageGenParams & { _seed?: number })._seed = progress.resolvedSeed
          resolve()
        } else {
          reject(new Error(`Image generation failed (exit ${String(code)}): ${log.slice(-400)}`))
        }
      })
    })

    if (!fs.existsSync(outPath)) throw new Error('Image generation produced no output file.')
    const b64 = fs.readFileSync(outPath).toString('base64')
    const finalSeed = (params as ImageGenParams & { _seed?: number })._seed ?? seed
    return {
      dataUrl: `data:image/png;base64,${b64}`,
      path: outPath,
      seed: finalSeed,
      model: path.basename(model)
    }
  } finally {
    generationLifecycle.finish()
    currentChild = null
    fs.promises.unlink(previewPath).catch(() => {})
    // LLM warm-back-up happens once in the generateImage() wrapper's finally
    // (covers both this sd-cli path and the mflux path).
  }
}

/** Image generation as a ManagedRuntime for the shared residency seam. Only the
 *  RESIDENT sd-server holds memory between images; evict stops it so another
 *  modality can reclaim the RAM. warm/release are no-ops — the server lazily
 *  re-spawns on the next eligible resident generation (ensureUp), and the one-shot
 *  sd-cli/mflux paths hold nothing between jobs. */
export const imageRuntime: ManagedRuntime = {
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
