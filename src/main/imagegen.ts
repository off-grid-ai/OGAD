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
  for (const r of binRoots()) {
    const p = path.join(r, 'coreml-sd', 'coreml-sd');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** A Core ML model is a DIRECTORY of compiled .mlmodelc resources, not a GGUF. */
function isCoreMLModelDir(p: string): boolean {
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
  const EXCLUDE = /qwen3-4b-instruct|gemma|^qwen[^-]|mmproj|^ae\.|ggml-|kokoro|lessac|en_us|[-_.](vae|clip|t5xxl|text_encoder|tokenizer)\b/i;
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
  return [...coreml, ...checkpoints];
}

/** All generated images on disk, newest first (excludes step-preview files). */
export function listGeneratedImages(): { path: string; name: string; mtime: number }[] {
  const dir = path.join(app.getPath('userData'), 'generated-images');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.png$/i.test(f) && !f.startsWith('preview-'))
      .map((f) => {
        const p = path.join(dir, f);
        return { path: p, name: f, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
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

/** Find a companion file (text encoder / vae) in the models dir by pattern. */
function findInModels(re: RegExp): string | null {
  try {
    const f = fs.readdirSync(modelsDir()).find((x) => re.test(x));
    return f ? path.join(modelsDir(), f) : null;
  } catch {
    return null;
  }
}

/** Pick a model: the requested filename if present, else prefer the higher-quality v2.1, else any. */
function resolveModel(preferred?: string): string | null {
  const dir = modelsDir();
  if (preferred) {
    const pp = path.join(dir, preferred);
    if (fs.existsSync(pp)) return pp;
  }
  const sd = listImageModels();
  if (!sd.length) return null;
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
  if (!findSdCli()) return { available: false, models, reason: 'sd-cli binary not found' };
  if (!models.length) return { available: false, models, reason: 'no Stable Diffusion model installed' };
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
}

let running = false;
let currentChild: ChildProcess | null = null;
let cancelled = false;

/** Kill an in-progress generation. Returns true if one was running. */
export function cancelImageGen(): boolean {
  if (currentChild) {
    cancelled = true;
    currentChild.kill('SIGKILL');
    return true;
  }
  return false;
}

export async function generateImage(
  params: ImageGenParams,
  onProgress?: (p: ImageGenProgress & { preview?: string }) => void,
): Promise<ImageGenOutput> {
  if (running) throw new Error('An image is already generating — please wait for it to finish.');
  if (!params.prompt?.trim()) throw new Error('A prompt is required.');

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
  const modelGb = coreml ? 0 : (fs.statSync(model).size / 1e9) * 1.4;
  const budgetGb = totalGb - reserveGb;
  if (modelGb > budgetGb) {
    throw new Error(
      `Not enough memory to run ${path.basename(model)} (~${modelGb.toFixed(1)}GB) on this ${totalGb.toFixed(0)}GB machine. ` +
      `Pick a lighter image model (e.g. SDXL-Lightning or SD 1.5) in the image options.`
    );
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
      '-W', String(params.width ?? 1024),
      '-H', String(params.height ?? 1024),
      '--steps', String(params.steps ?? 8),
      '--cfg-scale', String(params.cfgScale ?? 1.0),
      '--sampling-method', 'euler',
      '--offload-to-cpu',
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
    const defaultSize = isTurbo ? 512 : isXL ? 1024 : isV2 ? 768 : 512;
    const defaultSteps = isTurbo ? 4 : isLightning ? (nameStepMatch ? parseInt(nameStepMatch[1], 10) : 4) : 28;
    args = [
      '-M', 'img_gen',
      '-m', model,
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
    if (isXL) args.push('--vae-tiling');
    args.push('-n', params.negativePrompt?.trim() || DEFAULT_NEGATIVE);
    // img2img (not supported by Z-Image gen-only turbo).
    if (params.initImage) {
      args.push('-i', params.initImage, '--strength', String(params.strength ?? 0.75));
    }
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
            let preview: string | undefined;
            try {
              if (fs.existsSync(previewPath)) preview = `data:image/png;base64,${fs.readFileSync(previewPath).toString('base64')}`;
            } catch { /* preview not ready */ }
            onProgress({ step: parseInt(last[1], 10), total: parseInt(last[2], 10), secPerStep: parseFloat(last[3]), preview });
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
