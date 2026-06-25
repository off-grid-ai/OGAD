// On-device image generation via stable-diffusion.cpp (the bundled `sd-cli`).
// Mirrors the llm.ts pattern: resolve the binary from resources/bin, pick a
// Stable Diffusion model from the userData models dir, spawn one-shot txt2img/
// img2img, persist the PNG under userData/generated-images, return a data URL.

import { spawn, type ChildProcess } from 'child_process';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { llm } from './llm';
import { isMfluxModelId, mfluxAvailable, getMfluxModel, runMflux, cancelMflux, MFLUX_MODELS } from './mflux';
import { getActiveModal } from './active-models';

function binRoots(): string[] {
  return app.isPackaged
    ? [path.join(process.resourcesPath, 'bin')]
    : [path.join(app.getAppPath(), 'resources', 'bin'), path.join(process.cwd(), 'resources', 'bin')];
}

function findSdCli(): string | null {
  for (const r of binRoots()) {
    const p = path.join(r, 'sd', 'sd-cli');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** The Core ML (ANE) image-gen Swift helper, if bundled. */
function findCoreMLBin(): string | null {
  // Core ML is Apple-Silicon only — never offered off macOS (Windows/Linux use sd).
  if (process.platform !== 'darwin') return null;
  for (const r of binRoots()) {
    const p = path.join(r, 'coreml-sd', 'coreml-sd');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** A Core ML model is a DIRECTORY of compiled .mlmodelc resources, not a GGUF. */
function isCoreMLModelDir(p: string): boolean {
  if (process.platform !== 'darwin') return false; // Core ML is macOS-only
  try {
    if (!fs.statSync(p).isDirectory()) return false;
    return fs.readdirSync(p).some((f) => /\.mlmodelc$/i.test(f));
  } catch {
    return false;
  }
}

function modelsDir(): string {
  return path.join(app.getPath('userData'), 'models');
}

/** All image models on disk: GGUFs, custom .safetensors checkpoints, Core ML dirs. */
export function listImageModels(): string[] {
  const dir = modelsDir();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // Exclude LLM / companion / non-diffusion files so they don't show as pickable
  // image models (gemma/qwen LLMs, the Z-Image Qwen3 encoder + FLUX ae VAE,
  // whisper .bin, TTS .onnx, and standalone VAE/CLIP/T5 components).
  const EXCLUDE = /qwen3-4b-instruct|gemma|^qwen[^-]|mmproj|^ae\.|ggml-|kokoro|lessac|en_us|^clip[_-]?[lg]\b|[-_.](vae|clip|t5xxl|text_encoder|tokenizer)\b/i;
  const isImage = (f: string): boolean => {
    if (EXCLUDE.test(f)) return false;
    // Custom checkpoints (Civitai etc.) ship as a single .safetensors.
    if (/\.safetensors$/i.test(f)) return true;
    if (/\.gguf$/i.test(f)) {
      return /(stable[-_]diffusion|sd[-_]?xl|sdxl|sd[-_]?1|sd[-_]?2|sd[-_]?3|lightning|turbo|flux|z[-_]?image|diffusion|pony|illustrious|animagine|juggernaut|realvis|dreamshaper|epicrealism|noob|absolute|chillout|counterfeit|anything)/i.test(f);
    }
    return false;
  };
  const coreml = files.filter((f) => isCoreMLModelDir(path.join(dir, f)));
  const checkpoints = files.filter(isImage);
  // MLX (mflux) models are virtual ids (mlx/…), not files in the models dir.
  // Appended last so the sd-cli default (Z-Image) stays the preferred pick.
  // mflux fetches its own weights from HF on first use (cached in userData).
  const mlx = mfluxAvailable() ? MFLUX_MODELS.map((m) => m.id) : [];
  return [...coreml, ...checkpoints, ...mlx];
}

/** All generated images on disk, newest first (excludes step-preview files). */
export function listGeneratedImages(scope?: { conversationId?: string; projectId?: string | null }): { path: string; name: string; mtime: number; conversationId?: string; projectId?: string | null }[] {
  const dir = path.join(app.getPath('userData'), 'generated-images');
  try {
    let all = fs
      .readdirSync(dir)
      .filter((f) => /\.png$/i.test(f) && !f.startsWith('preview-'))
      .map((f) => {
        const p = path.join(dir, f);
        // Optional sidecar with chat/project scope, written by the ipc handler.
        let meta: { conversationId?: string; projectId?: string | null } = {};
        try { meta = JSON.parse(fs.readFileSync(`${p}.json`, 'utf8')); } catch { /* no sidecar */ }
        return { path: p, name: f, mtime: fs.statSync(p).mtimeMs, conversationId: meta.conversationId, projectId: meta.projectId ?? null };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (scope?.conversationId) all = all.filter((r) => r.conversationId === scope.conversationId);
    else if (scope?.projectId) all = all.filter((r) => r.projectId === scope.projectId);
    return all;
  } catch {
    return [];
  }
}

/** Delete a generated image from disk. */
export function deleteGeneratedImage(p: string): boolean {
  try {
    // Only allow deleting inside the generated-images dir (safety).
    const dir = path.join(app.getPath('userData'), 'generated-images');
    if (!path.resolve(p).startsWith(path.resolve(dir))) return false;
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

// --- Style-preset thumbnails (generated on-device, cached; never hotlinked) --
function styleThumbDir(): string {
  return path.join(app.getPath('userData'), 'style-thumbs');
}

/** Map of style key -> cached thumbnail path (on-device generated). */
export function listStyleThumbs(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const f of fs.readdirSync(styleThumbDir())) {
      const m = f.match(/^(.+)\.png$/i);
      if (m) out[m[1]] = path.join(styleThumbDir(), f);
    }
  } catch { /* none yet */ }
  return out;
}

/** Generate one style thumbnail on-device (small/fast) and cache it. */
export async function generateStyleThumb(key: string, prompt: string): Promise<string> {
  const out = await generateImage({ prompt, width: 512, height: 512, steps: 6 });
  const dir = styleThumbDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${key.replace(/[^\w-]+/g, '_')}.png`);
  fs.copyFileSync(out.path, dest);
  return dest;
}

// --- LoRA adapters -----------------------------------------------------------
// LoRAs live in userData/models/loras as .safetensors. sd-cli applies them via
// the `--lora-model-dir` flag + `<lora:NAME:WEIGHT>` syntax injected into the
// prompt (NAME = filename without extension). Our checkpoints are quantized, so
// sd-cli auto-selects "at_runtime" apply mode (compatible, slightly slower).
function loraDir(): string {
  return path.join(modelsDir(), 'loras');
}

export interface LoraInfo {
  /** Filename without extension — the NAME used in <lora:NAME:weight>. */
  name: string;
  /** Display label (name with separators tidied). */
  label: string;
  file: string;
  sizeBytes: number;
}

/** List installed LoRA adapters. */
export function listLoras(): LoraInfo[] {
  const dir = loraDir();
  const out: LoraInfo[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(safetensors|ckpt|gguf|pt)$/i.test(f)) continue;
      const name = f.replace(/\.(safetensors|ckpt|gguf|pt)$/i, '');
      let sizeBytes = 0;
      try { sizeBytes = fs.statSync(path.join(dir, f)).size; } catch { /* ignore */ }
      out.push({ name, label: name.replace(/[_-]+/g, ' '), file: path.join(dir, f), sizeBytes });
    }
  } catch { /* dir doesn't exist yet */ }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** Absolute path to the LoRA folder (created on demand) — for "reveal in Finder". */
export function ensureLoraDir(): string {
  const dir = loraDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Download a LoRA .safetensors into the LoRA folder (HF resolve URLs, follows redirects). */
export async function downloadLora(
  url: string,
  filename: string,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const dir = ensureLoraDir();
  const dest = path.join(dir, filename);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  const res = await fetch(url); // Electron main = Node 18+, follows redirects (HF → CDN)
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  let received = 0;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));
      received += value.length;
      if (total && onProgress) onProgress(Math.round((received / total) * 100));
    }
  } finally {
    await new Promise<void>((r) => out.end(r));
  }
  fs.renameSync(tmp, dest);
  return dest;
}

/** Find a companion file (text encoder / vae) in the models dir by pattern. */
function findInModels(re: RegExp): string | null {
  try {
    const f = fs.readdirSync(modelsDir()).find((x) => re.test(x));
    return f ? path.join(modelsDir(), f) : null;
  } catch {
    return null;
  }
}


// A GGUF checkpoint is loadable via `-m` only if it's a FULL pipeline (UNET + VAE
// + text encoder). Many SDXL quants on HF (e.g. animagine-xl, illustrious) ship
// the UNET ONLY — sd.cpp then can't detect the version ("get sd version from file
// failed") and aborts. Those need `--diffusion-model` + separate CLIP + VAE.
// Detect by scanning the tensor-name table (near the file start) for VAE + CLIP
// namespaces. On any read error we assume FULL so models that already work aren't
// regressed. Cached by path+size+mtime. (Z-Image/FLUX are handled separately.)
const ggufFullCache = new Map<string, boolean>();
function ggufIsFullCheckpoint(p: string): boolean {
  if (!/\.gguf$/i.test(p)) return true; // .safetensors checkpoints are full pipelines
  let key: string;
  try {
    const st = fs.statSync(p);
    key = `${p}:${st.size}:${st.mtimeMs}`;
  } catch {
    return true;
  }
  const cached = ggufFullCache.get(key);
  if (cached !== undefined) return cached;
  let full = true;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      // The tensor-name table sits just after the (tiny) KV metadata, well within
      // the first few MB even for 2600-tensor checkpoints.
      const buf = Buffer.alloc(Math.min(4_000_000, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      const s = buf.toString('latin1');
      const hasVae = s.includes('first_stage_model') || s.includes('vae.') || s.includes('.vae');
      const hasClip =
        s.includes('cond_stage_model') || s.includes('conditioner') ||
        s.includes('text_encoder') || s.includes('text_model');
      full = hasVae && hasClip;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    full = true;
  }
  ggufFullCache.set(key, full);
  return full;
}

/** Pick a model: the requested filename if present, else prefer the higher-quality v2.1, else any. */
/** The image model an incoming request would actually load (active pick, else the
 *  resolver's default), as a bare filename — or null if none installed. */
export function activeImageModel(): string | null {
  const m = resolveModel();
  return m ? path.basename(m) : null;
}

function resolveModel(preferred?: string): string | null {
  const dir = modelsDir();
  if (preferred) {
    const pp = path.join(dir, preferred);
    if (fs.existsSync(pp)) return pp;
  }
  const sd = listImageModels();
  if (!sd.length) return null;
  // User-chosen image model is the default when the caller didn't request one.
  const chosen = getActiveModal('image');
  if (chosen) {
    if (fs.existsSync(path.join(dir, chosen))) return path.join(dir, chosen);
    if (sd.includes(chosen)) return path.join(dir, chosen); // mlx/virtual id
  }
  // Preference: Z-Image-Turbo (2026 flagship, fast, great quality/byte) >
  // SDXL-Lightning > SDXL > SD 2.1 > anything else.
  const zimage = sd.find((f) => /z[-_]?image/i.test(f));
  const lightning = sd.find((f) => /lightning/i.test(f));
  const xl = sd.find((f) => /sdxl|xl/i.test(f));
  const v21 = sd.find((f) => /v2-1|v2\.1/i.test(f));
  return path.join(dir, zimage ?? lightning ?? xl ?? v21 ?? sd[0]);
}

// A general-purpose negative prompt that meaningfully lifts quality when the
// caller doesn't supply one. Kept conservative so it doesn't fight most prompts.
const DEFAULT_NEGATIVE =
  'blurry, low quality, low resolution, jpeg artifacts, deformed, disfigured, bad anatomy, extra limbs, watermark, text, signature, grainy, oversaturated';

/** Whether image generation is usable right now (binary + at least one model). */
export function imageGenStatus(): { available: boolean; models: string[]; reason?: string } {
  const models = listImageModels();
  // Available if EITHER runtime is usable: sd-cli (with a model) or MLX/mflux.
  if (!findSdCli() && !mfluxAvailable()) return { available: false, models, reason: 'no image runtime found' };
  if (!models.length) return { available: false, models, reason: 'no image model installed' };
  return { available: true, models };
}

export interface ImageGenParams {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  cfgScale?: number;
  /** Model filename in the models dir; defaults to the preferred installed model. */
  model?: string;
  /** Local path to an init image for img2img. */
  initImage?: string;
  strength?: number;
  /** LoRA adapters to apply: name (filename w/o ext) + weight (e.g. 0.8). */
  loras?: { name: string; weight: number }[];
}

export interface ImageGenOutput {
  dataUrl: string;
  path: string;
  seed: number;
  model: string;
}

export interface ImageGenProgress {
  step: number;
  total: number;
  secPerStep: number;
  // sd-cli prints an "N/N - Xs/it" sequence for the denoising loop AND again for
  // the VAE-tiling decode. Tag which one so the UI shows "Decoding" instead of a
  // confusing second 0→N count.
  phase?: 'sampling' | 'decoding';
}

let running = false;
let currentChild: ChildProcess | null = null;
let cancelled = false;

/** Kill an in-progress generation. Returns true if one was running. */
export function cancelImageGen(): boolean {
  cancelMflux(); // no-op if mflux isn't the active runtime
  if (currentChild) {
    cancelled = true;
    currentChild.kill('SIGKILL');
    return true;
  }
  return running; // mflux gen has no currentChild but sets running
}

export async function generateImage(
  params: ImageGenParams,
  onProgress?: (p: ImageGenProgress & { preview?: string }) => void,
): Promise<ImageGenOutput> {
  if (running) throw new Error('An image is already generating — please wait for it to finish.');
  if (!params.prompt?.trim()) throw new Error('A prompt is required.');

  // --- MLX / mflux runtime branch (FLUX / Z-Image with native LoRA) ----------
  // Self-contained: reuses the single-flight guard + llm.pause()/resume() (so
  // the LLM and image model never coexist on Apple Silicon unified memory), then
  // delegates the spawn to the mflux module. Returns before the sd-cli path.
  if (isMfluxModelId(params.model)) {
    const def = getMfluxModel(params.model)!;
    const outDir = path.join(app.getPath('userData'), 'generated-images');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `img-${String(Date.now())}.png`);
    running = true;
    cancelled = false;
    try { llm.pause(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 2500));
    try {
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
            if (path.isAbsolute(l.name) || l.name.includes('/')) return l;
            const local = path.join(loraDir(), /\.(safetensors|ckpt|gguf|pt)$/i.test(l.name) ? l.name : `${l.name}.safetensors`);
            return fs.existsSync(local) ? { ...l, name: local } : l;
          }),
        },
        outPath,
        (p) => onProgress?.({ step: p.step, total: p.total, secPerStep: p.secPerStep }),
      );
      if (!fs.existsSync(outPath)) throw new Error('MLX generation produced no output file.');
      const b64 = fs.readFileSync(outPath).toString('base64');
      return { dataUrl: `data:image/png;base64,${b64}`, path: outPath, seed: params.seed ?? -1, model: def.label };
    } finally {
      running = false;
      currentChild = null;
      llm.resume();
    }
  }

  // img2img: if the caller didn't pin a size, match the init image's dimensions
  // (rounded to /64). Avoids silently upscaling a 512px input to the model's 1024
  // default — which is much slower and can blow past client timeouts.
  if (params.initImage && (!params.width || !params.height)) {
    try {
      const sharp = (await import('sharp')).default;
      const meta = await sharp(params.initImage).metadata();
      if (meta.width && meta.height) {
        const r64 = (n: number): number => Math.max(256, Math.min(2048, Math.round(n / 64) * 64));
        params.width = params.width ?? r64(meta.width);
        params.height = params.height ?? r64(meta.height);
      }
    } catch {
      /* fall back to model defaults */
    }
  }

  const model = resolveModel(params.model);
  if (!model) throw new Error('No image model installed. Download one from Models.');
  // Core ML models are directories of .mlmodelc resources → routed to the ANE
  // Swift helper; everything else (GGUF) runs on sd-cli.
  const coreml = isCoreMLModelDir(model);
  const cli = coreml ? findCoreMLBin() : findSdCli();
  if (!cli) {
    throw new Error(coreml
      ? 'Core ML helper (coreml-sd) not found in resources/bin/coreml-sd.'
      : 'Image generation binary (sd-cli) not found in resources/bin/sd.');
  }

  // Memory guard (GGUF only) — on Apple Silicon unified memory, an oversized
  // model swaps to disk and FREEZES the machine. Refuse rather than freeze.
  // Core ML runs on the ANE with its own streaming, so it's exempt.
  // Reserve scales with RAM so an 8GB machine isn't blocked outright (a flat
  // 7GB reserve would leave it ~1GB and reject everything).
  const totalGb = os.totalmem() / 1e9;
  const reserveGb = totalGb <= 10 ? 4 : 6;
  const safeSizeGb = (p: string | null | undefined): number => {
    try { return p && fs.existsSync(p) ? fs.statSync(p).size / 1e9 : 0; } catch { return 0; }
  };
  // Z-Image is a 3-model stack (diffusion transformer + Qwen3-4B text encoder +
  // FLUX VAE) all resident at once — the diffusion file alone wildly understates
  // its footprint. Count the encoder + VAE too, or the guard waves through a
  // combo that then overflows unified memory and freezes the box.
  const zImageStack = /z[-_]?image/i.test(path.basename(model));
  const zEncoderGb = zImageStack ? safeSizeGb(findInModels(/qwen3-4b-instruct.*\.gguf$/i)) : 0;
  const zVaeGb = zImageStack ? safeSizeGb(findInModels(/^ae\.(safetensors|sft)$|^ae.*\.gguf$/i)) : 0;
  const modelGb = coreml ? 0 : (safeSizeGb(model) + zEncoderGb + zVaeGb) * 1.4;
  const budgetGb = totalGb - reserveGb;
  if (modelGb > budgetGb) {
    throw new Error(
      `Not enough memory to run ${path.basename(model)} (~${modelGb.toFixed(1)}GB resident) on this ${totalGb.toFixed(0)}GB machine. ` +
      `Pick a lighter image model (e.g. SDXL-Lightning or SD 1.5) in the image options.`
    );
  }

  // LoRA adapters: inject <lora:NAME:WEIGHT> into the prompt (Core ML helper
  // doesn't support LoRA, so skip there). The --lora-model-dir flag is added to
  // the sd-cli args below.
  const loras = (params.loras || []).filter((l) => l.name && Number.isFinite(l.weight));
  if (!coreml && loras.length) {
    // HARD LIMIT: stable-diffusion.cpp can only merge a LoRA into FULL-PRECISION
    // (f16/f32) weights. Our shipped checkpoints are quantized (q8_0 / Q4_K) to
    // save disk, and the LoRA merge then aborts the binary (Metal: unsupported
    // op CPY/ADD; CPU: GGML_ASSERT src1->type == F32). Fail with a clear message
    // instead of crash-aborting. Re-enable once an f16 base model ships.
    if (/[._-]q\d/i.test(path.basename(model))) {
      throw new Error(
        `LoRAs can't be applied to "${path.basename(model)}" — it's a quantized model, and the image engine can only merge a LoRA into a full-precision (f16) model. LoRA support needs a non-quantized base model (not yet shipped).`
      );
    }
    const tags = loras.map((l) => `<lora:${l.name}:${l.weight}>`).join(' ');
    params.prompt = `${params.prompt} ${tags}`;
  }

  const outDir = path.join(app.getPath('userData'), 'generated-images');
  fs.mkdirSync(outDir, { recursive: true });
  const seed = params.seed ?? -1;
  const stamp = String(Date.now());
  const outPath = path.join(outDir, `img-${stamp}.png`);
  const previewPath = path.join(outDir, `preview-${stamp}.png`);

  const base = path.basename(model);
  const isZImage = /z[-_]?image/i.test(base);
  const threads = String(Math.max(1, os.cpus().length - 2));
  // Live preview: write a rough partial image every step ('proj' needs no extra
  // model) so the UI can show the image forming step-by-step.
  const previewArgs = ['--preview', 'proj', '--preview-path', previewPath, '--preview-interval', '1'];

  let args: string[];
  if (coreml) {
    // Core ML (ANE) helper — directory model, prompt → PNG. No preview file.
    args = [
      '--model', model,
      '--prompt', params.prompt,
      '--output', outPath,
      '--steps', String(params.steps ?? 16),
      '--seed', String(seed),
    ];
    if (params.negativePrompt?.trim()) args.push('--negative', params.negativePrompt.trim());
  } else if (isZImage) {
    // Z-Image is a separate stack: diffusion transformer + Qwen3-4B text encoder
    // (--llm) + FLUX VAE (--vae). --offload-to-cpu keeps unified memory light.
    // Distilled turbo model → cfg 1.0, ~8 steps, euler, no negative prompt.
    const llm = findInModels(/qwen3-4b-instruct.*\.gguf$/i);
    const vae = findInModels(/^ae\.(safetensors|sft)$|^ae.*\.gguf$/i);
    if (!llm) throw new Error('Z-Image text encoder (Qwen3-4B-Instruct) not found — download it from Models.');
    if (!vae) throw new Error('Z-Image VAE (ae.safetensors) not found — download it from Models.');
    args = [
      '-M', 'img_gen',
      '--diffusion-model', model,
      '--llm', llm,
      '--vae', vae,
      '-p', params.prompt,
      '-o', outPath,
      // Default 768 (not 1024): a diffusion transformer's cost scales ~with pixel
      // count, so 768² is ~44% less compute/memory than 1024² — the difference
      // between "slow but works" and thrashing unified memory into a freeze.
      '-W', String(params.width ?? 768),
      '-H', String(params.height ?? 768),
      '--steps', String(params.steps ?? 8),
      '--cfg-scale', String(params.cfgScale ?? 1.0),
      '--sampling-method', 'euler',
      // Keep weights + VAE off the Metal device between/at use so the resident
      // footprint (DiT + 4B encoder + VAE) doesn't spike past unified memory.
      '--offload-to-cpu',
      '--vae-on-cpu',
      '--diffusion-fa',
      '-t', threads,
      '-s', String(seed),
      ...previewArgs,
    ];
  } else {
    // Per-model defaults. Distilled few-step models (SDXL-Lightning, *-Turbo)
    // need very low steps, cfg≈1 and euler — ~7× faster at near-SDXL quality.
    const isLightning = /lightning/i.test(base);
    const isTurbo = /turbo/i.test(base);
    const isXL = /sdxl|xl/i.test(base) || isLightning;
    const isV2 = /v2-1|v2\.1/i.test(base);
    const fewStep = isLightning || isTurbo;
    const nameStepMatch = base.match(/(\d+)\s*step/i);
    // SDXL-Lightning's sweet spot is 768 (what our style thumbnails use): great
    // quality, fast, and freeze-safe — full 1024 forces a slow tiled VAE decode.
    // Full (non-distilled) XL stays at 1024 where the extra detail pays off.
    const defaultSize = isTurbo ? 512 : isLightning ? 768 : isXL ? 1024 : isV2 ? 768 : 512;
    const defaultSteps = isTurbo ? 4 : isLightning ? (nameStepMatch ? parseInt(nameStepMatch[1], 10) : 4) : 28;
    // Full checkpoint → load with -m. UNET-only quant → load the diffusion model
    // separately and supply SDXL CLIP-L/CLIP-G + VAE; if those companions aren't
    // installed, fail with a clear message instead of the cryptic sd.cpp abort.
    let modelFlags: string[];
    if (ggufIsFullCheckpoint(model)) {
      modelFlags = ['-m', model];
    } else {
      const clipL = findInModels(/clip[_-]?l.*\.(safetensors|gguf)$/i);
      const clipG = findInModels(/clip[_-]?g.*\.(safetensors|gguf)$/i);
      const sdxlVae = findInModels(/(sdxl[_-]?vae|vae[_-]?sdxl|sdxl.*vae).*\.(safetensors|gguf)$/i);
      if (clipL && clipG && sdxlVae) {
        modelFlags = ['--diffusion-model', model, '--clip_l', clipL, '--clip_g', clipG, '--vae', sdxlVae];
      } else {
        const dir = modelsDir();
        const usable = listImageModels()
          .filter((f) => /z[-_]?image|lightning/i.test(f) || ggufIsFullCheckpoint(path.join(dir, f)))
          .map((f) => path.basename(f));
        throw new Error(
          `"${base}" is a UNET-only model — it has no built-in text encoder or VAE, so it can't generate on its own ` +
          `(it needs SDXL CLIP-L, CLIP-G and a VAE, which aren't installed). ` +
          (usable.length ? `Pick a complete model instead: ${usable.slice(0, 4).join(', ')}.`
                          : `Download a complete checkpoint (e.g. SDXL-Lightning) or Z-Image.`)
        );
      }
    }
    args = [
      '-M', 'img_gen',
      ...modelFlags,
      '-p', params.prompt,
      '-o', outPath,
      '-W', String(params.width ?? defaultSize),
      '-H', String(params.height ?? defaultSize),
      '--steps', String(params.steps ?? defaultSteps),
      '--cfg-scale', String(params.cfgScale ?? (fewStep ? 1.0 : 7)),
      '--sampling-method', fewStep ? 'euler' : 'dpm++2m',
      '--diffusion-fa',
      '-t', threads,
      '-s', String(seed),
      ...previewArgs,
    ];
    // VAE-tiling only when the decode would actually spike memory (large XL
    // images). At ≤768 it's unnecessary and just adds a slow second "decode"
    // pass — exactly what our freeze-safe 768 thumbnail batch skipped.
    const effW = params.width ?? defaultSize;
    const effH = params.height ?? defaultSize;
    if (isXL && Math.max(effW, effH) > 768) args.push('--vae-tiling');
    args.push('-n', params.negativePrompt?.trim() || DEFAULT_NEGATIVE);
    // img2img (not supported by Z-Image gen-only turbo).
    if (params.initImage) {
      args.push('-i', params.initImage, '--strength', String(params.strength ?? 0.75));
    }
  }

  // Point sd-cli at the LoRA folder so the <lora:NAME:weight> tags resolve.
  if (!coreml && loras.length) {
    args.push('--lora-model-dir', loraDir());
  }

  running = true;
  cancelled = false;
  // CRITICAL on Apple Silicon (unified memory): the LLM (gemma) and the image
  // model can't both be resident — together they overflow RAM and the whole
  // system swaps/hangs. Free the LLM first, then give the OS a moment to
  // actually reclaim its pages before we load the (large) image model.
  // pause() frees the server AND blocks the capture pipeline from respawning it
  // mid-generation (which would put both models in memory and freeze the box).
  try { llm.pause(); } catch { /* ignore */ }
  // Give the OS time to actually reclaim the freed LLM pages before the image
  // model's load spike — otherwise the brief overlap causes a short stutter.
  await new Promise((r) => setTimeout(r, 2500));
  try {
    await new Promise<void>((resolve, reject) => {
      // cwd at the binary dir so @executable_path rpath resolves libstable-diffusion.dylib.
      const child = spawn(cli, args, { cwd: path.dirname(cli) });
      currentChild = child;
      let log = '';
      let resolvedSeed = seed;
      // Track the denoise→decode transition: once a sampling pass reaches its
      // total, a fresh "1/N" sequence is the VAE decode, not a second generation.
      let samplingDone = false;
      let prevStep = 0;
      let phase: 'sampling' | 'decoding' = 'sampling';
      const capture = (d: Buffer): void => {
        const s = d.toString();
        log += s;
        const m = s.match(/seed\s+(-?\d+)/i);
        if (m) resolvedSeed = parseInt(m[1], 10);
        // Sampling step lines look like "12/28 - 1.26s/it" (loading lines use
        // MB/s, so the s/it anchor only matches real denoising steps).
        if (onProgress) {
          const stepRe = /(\d+)\/(\d+)\s*-\s*([\d.]+)s\/it/g;
          let last: RegExpExecArray | null = null;
          for (let mm = stepRe.exec(s); mm; mm = stepRe.exec(s)) last = mm;
          if (last) {
            const step = parseInt(last[1], 10);
            const total = parseInt(last[2], 10);
            if (!samplingDone) { if (step >= total) samplingDone = true; }
            else if (step < prevStep) { phase = 'decoding'; }
            prevStep = step;
            let preview: string | undefined;
            try {
              if (fs.existsSync(previewPath)) preview = `data:image/png;base64,${fs.readFileSync(previewPath).toString('base64')}`;
            } catch { /* preview not ready */ }
            onProgress({ step, total, secPerStep: parseFloat(last[3]), preview, phase });
          }
        }
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.on('error', reject);
      child.on('close', (code) => {
        if (cancelled) {
          reject(new Error('Image generation cancelled.'));
        } else if (code === 0) {
          // stash the resolved seed for the caller via closure
          (params as ImageGenParams & { _seed?: number })._seed = resolvedSeed;
          resolve();
        } else {
          reject(new Error(`Image generation failed (exit ${String(code)}): ${log.slice(-400)}`));
        }
      });
    });

    if (!fs.existsSync(outPath)) throw new Error('Image generation produced no output file.');
    const b64 = fs.readFileSync(outPath).toString('base64');
    const finalSeed = (params as ImageGenParams & { _seed?: number })._seed ?? seed;
    return {
      dataUrl: `data:image/png;base64,${b64}`,
      path: outPath,
      seed: finalSeed,
      model: path.basename(model),
    };
  } finally {
    running = false;
    currentChild = null;
    fs.promises.unlink(previewPath).catch(() => {});
    // Resume the LLM (unblock respawns + warm it back up) now that gen is done.
    llm.resume();
  }
}
