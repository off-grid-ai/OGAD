// MLX image runtime (mflux) — Apple-Silicon-native FLUX / FLUX.2 / Z-Image with
// LoRA. This is the second image runtime alongside sd-cli (stable-diffusion.cpp).
// It exists because sd.cpp cannot merge a LoRA into our quantized GGUF models
// (the merge needs f16); mflux runs full/MLX-quantized models and supports LoRA
// natively. Python/MLX is bundled (fully offline) at resources/bin/mflux/ — see
// scripts/build-mflux-env.sh. Apple Silicon only.
import { app } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Mirror imagegen.ts binRoots(): packaged → process.resourcesPath/bin, dev →
// app source + cwd.
function binRoots(): string[] {
  return app.isPackaged
    ? [path.join(process.resourcesPath, 'bin')]
    : [path.join(app.getAppPath(), 'resources', 'bin'), path.join(process.cwd(), 'resources', 'bin')];
}

/** The bundled standalone python3 inside the mflux env, or null if not present. */
export function findMfluxPython(): string | null {
  for (const r of binRoots()) {
    const p = path.join(r, 'mflux', 'bin', 'python3');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** MLX requires Apple Silicon; the env must be bundled. */
export function mfluxAvailable(): boolean {
  return process.arch === 'arm64' && !!findMfluxPython();
}

/** Where mflux downloads/caches model weights (its HF_HOME). */
export function mfluxCacheDir(): string {
  return path.join(app.getPath('userData'), 'mflux-cache');
}

// Entry point that handles every base model via --base-model. Invoked with -m
// (relocatable) because the console-script shebangs hardcode an absolute path.
const MFLUX_ENTRY = 'mflux.models.flux.cli.flux_generate';

export interface MfluxModelDef {
  /** Catalog/UI id, e.g. "mlx/z-image-turbo". */
  id: string;
  label: string;
  /** Value for mflux --model: a built-in alias (schnell) OR a HF repo id for a
   *  pre-quantized third-party model. */
  modelArg: string;
  /** Value for --base-model: the architecture hint (required when modelArg is a
   *  third-party repo so mflux knows how to load it). */
  baseModelArg?: string;
  /** HF repo to pre-download + cache-check (usually === modelArg when it's a repo). */
  hfRepo: string;
  /** If the repo is already quantized, don't pass -q (would double-quantize). */
  preQuantized?: boolean;
  defaultSteps: number;
  /** schnell-family ignores guidance; dev/others use it. */
  defaultGuidance?: number;
  defaultSize: number;
  supportsLora: boolean;
}

// The MLX models we expose. Z-Image-Turbo is the shippable default: Apache-2.0,
// NON-gated on HF (Tongyi-MAI/Z-Image-Turbo), fast, LoRA-capable. FLUX.1-schnell
// is omitted by default because black-forest-labs gated the repo (HF login/token
// required) — incompatible with the offline/no-login product. It can be re-added
// behind an opt-in HF-token setting later (set `gated: true`).
// PARKED (2026-06-23): the MLX route is disabled. The only viable on-device MLX
// LoRA model is Z-Image (FLUX is gated), and even the pre-quantized 8-bit repo is
// ~13GB (full bf16 is ~33GB) — too large to ship for Z-Image's thin LoRA value.
// The runtime plumbing (mflux.ts, the imagegen branch, ipc download/installed) is
// kept dormant; re-enable by repopulating this array (e.g. if a small non-gated
// model or an un-gated FLUX appears). Empty ⇒ MLX is invisible/inert everywhere.
export const MFLUX_MODELS: MfluxModelDef[] = [];

export function isMfluxModelId(id: string | undefined): boolean {
  return !!id && MFLUX_MODELS.some((m) => m.id === id);
}

export function getMfluxModel(id: string | undefined): MfluxModelDef | undefined {
  return MFLUX_MODELS.find((m) => m.id === id);
}

/** HF cache dir name for a repo id, e.g. "models--Tongyi-MAI--Z-Image-Turbo". */
function hfCacheName(repo: string): string {
  return 'models--' + repo.replace(/\//g, '--');
}

/** Whether an MLX model's weights are already downloaded (a complete snapshot). */
export function isMfluxModelCached(modelId: string): boolean {
  const def = getMfluxModel(modelId);
  if (!def) return false;
  const snapRoot = path.join(mfluxCacheDir(), 'hub', hfCacheName(def.hfRepo), 'snapshots');
  try {
    for (const rev of fs.readdirSync(snapRoot)) {
      // model_index.json is the manifest; its presence means the snapshot resolved.
      if (fs.existsSync(path.join(snapRoot, rev, 'model_index.json'))) return true;
    }
  } catch { /* not downloaded */ }
  return false;
}

/** Pre-download an MLX model's weights into the cache (so the Models screen can
 *  "Download" it ahead of first use). Streams coarse Fetching-N/M progress. */
export function downloadMfluxModel(modelId: string, onProgress?: (pct: number) => void): Promise<void> {
  const def = getMfluxModel(modelId);
  if (!def) return Promise.reject(new Error(`Unknown MLX model: ${modelId}`));
  const py = findMfluxPython();
  if (!py) return Promise.reject(new Error('MLX runtime not installed.'));
  if (isMfluxModelCached(modelId)) { onProgress?.(100); return Promise.resolve(); }

  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      py,
      ['-c', `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(def.hfRepo)})`],
      { cwd: path.dirname(py), env: mfluxEnv() },
    );
    let log = '';
    const capture = (d: Buffer): void => {
      const s = d.toString();
      log += s;
      // huggingface_hub prints "Fetching 13 files:  46%|… | 6/13 …".
      const m = /Fetching\s+\d+\s+files:\s+(\d+)%/.exec(s) || /\|\s*(\d+)\/(\d+)\s/.exec(s);
      if (m && onProgress) {
        const pct = m[2] ? Math.round((parseInt(m[1], 10) / parseInt(m[2], 10)) * 100) : parseInt(m[1], 10);
        if (Number.isFinite(pct)) onProgress(pct);
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && isMfluxModelCached(modelId)) { onProgress?.(100); resolve(); }
      else reject(new Error(`MLX model download failed (exit ${code}). ${log.slice(-400)}`));
    });
  });
}

/** Env for the mflux subprocess: cache weights in userData, fast HF transfer. */
function mfluxEnv(): NodeJS.ProcessEnv {
  const dir = mfluxCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  return {
    ...process.env,
    HF_HOME: dir,
    HF_XET_HIGH_PERFORMANCE: '1', // fast Xet transfer (replaces deprecated HF_HUB_ENABLE_HF_TRANSFER)
  };
}

export interface MfluxGenParams {
  prompt: string;
  model: string; // one of MFLUX_MODELS[].id
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  guidance?: number;
  quantize?: 3 | 4 | 5 | 6 | 8; // MLX runtime quantization
  loras?: { name: string; weight: number }[]; // name = local file path or HF repo id
}

export interface MfluxProgress {
  step: number;
  total: number;
  secPerStep: number;
}

/** Build the argv for `python3 <args>` (the -m entry + flags). */
export function buildMfluxArgs(params: MfluxGenParams, outPath: string): string[] {
  const def = getMfluxModel(params.model);
  if (!def) throw new Error(`Unknown MLX model: ${params.model}`);
  const args = [
    '-m', MFLUX_ENTRY,
    // --model: built-in alias OR a HF repo id (pre-quantized). --base-model gives
    // the architecture hint required for third-party repos.
    '--model', def.modelArg,
    '--prompt', params.prompt,
    '--output', outPath,
    '--steps', String(params.steps ?? def.defaultSteps),
    '--width', String(params.width ?? def.defaultSize),
    '--height', String(params.height ?? def.defaultSize),
  ];
  if (def.baseModelArg) args.push('--base-model', def.baseModelArg);
  // Don't re-quantize an already-quantized repo (mflux reads its quant level).
  if (!def.preQuantized) args.push('--quantize', String(params.quantize ?? 8));
  if (typeof params.seed === 'number' && params.seed >= 0) args.push('--seed', String(params.seed));
  const guidance = params.guidance ?? def.defaultGuidance;
  if (typeof guidance === 'number') args.push('--guidance', String(guidance));
  const loras = (params.loras ?? []).filter((l) => l.name && Number.isFinite(l.weight));
  if (def.supportsLora && loras.length) {
    args.push('--lora-paths', ...loras.map((l) => l.name));
    args.push('--lora-scales', ...loras.map((l) => String(l.weight)));
  }
  return args;
}

// tqdm progress lines look like " 50%|█████ | 2/4 [00:05<00:05,  1.20s/it]".
const STEP_RE = /(\d+)\/(\d+)\s*\[[^\]]*?([\d.]+)s\/it/;

export function parseMfluxProgress(s: string): { step: number; total: number; secPerStep: number } | null {
  const m = STEP_RE.exec(s);
  if (m) return { step: parseInt(m[1], 10), total: parseInt(m[2], 10), secPerStep: parseFloat(m[3]) };
  return null;
}

let proc: ChildProcess | null = null;
let cancelled = false;

export function cancelMflux(): void {
  cancelled = true;
  if (proc) { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
}

/**
 * Run an mflux generation. Caller is responsible for the single-flight guard +
 * llm.pause()/resume() (imagegen.ts owns that scaffold and routes here). Returns
 * the output PNG path.
 */
export function runMflux(
  params: MfluxGenParams,
  outPath: string,
  onProgress?: (p: MfluxProgress) => void,
): Promise<string> {
  const py = findMfluxPython();
  if (!py) throw new Error('MLX runtime (mflux) not installed — run scripts/build-mflux-env.sh.');
  if (process.arch !== 'arm64') throw new Error('MLX image generation requires Apple Silicon.');

  const args = buildMfluxArgs(params, outPath);
  const threads = String(Math.max(1, os.cpus().length - 2));
  cancelled = false;

  return new Promise<string>((resolve, reject) => {
    proc = spawn(py, args, {
      cwd: path.dirname(py),
      env: { ...mfluxEnv(), OMP_NUM_THREADS: threads },
    });
    let log = '';
    const capture = (d: Buffer): void => {
      const s = d.toString();
      log += s;
      if (onProgress) {
        const p = parseMfluxProgress(s);
        if (p) onProgress(p);
      }
    };
    proc.stdout?.on('data', capture);
    proc.stderr?.on('data', capture); // tqdm writes to stderr
    proc.on('error', (e) => { proc = null; reject(e); });
    proc.on('close', (code) => {
      proc = null;
      if (cancelled) return reject(new Error('cancelled'));
      if (code === 0 && fs.existsSync(outPath)) return resolve(outPath);
      reject(new Error(`mflux exited ${code}. ${log.slice(-600)}`));
    });
  });
}
