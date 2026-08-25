// Pure inference-settings math, extracted from llm.ts so the mode presets, the
// user-set sampling payload, and the launch-vs-live change decision are a single
// source of truth and unit-testable without Electron/fs. No side effects, no imports
// beyond the shared model-sizing types (which are themselves pure).

import type { KvCacheType, PerformanceMode } from '../model-sizing'

// Friendly presets that decide how much of the machine the local model uses.
// Conservative leaves lots of headroom (safest on small / busy machines); Extreme
// pushes context/memory for max capability. The RAM clamp still applies on top, so
// even Extreme can't overcommit into a freeze. Context is a CEILING, not a
// fill-the-RAM target: a big context means a big KV cache (the bulk of the server's
// memory), so defaults stay modest. Conservative also quantizes the KV cache (q8_0)
// to roughly halve it.
export const MODE_PRESETS: Record<
  PerformanceMode,
  { ctxSize: number; kvCacheType: KvCacheType; flashAttn: boolean }
> = {
  conservative: { ctxSize: 8192, kvCacheType: 'q8_0', flashAttn: true },
  balanced: { ctxSize: 16384, kvCacheType: 'f16', flashAttn: false },
  extreme: { ctxSize: 65536, kvCacheType: 'f16', flashAttn: false }
}

/** The launch-time fields a mode preset governs. These are the ones a user can ALSO
 *  set granularly (KV control, context slider, flash-attn toggle), so the preset and
 *  the granular control contend for the same keys. `userExplicit` records which the
 *  user has pinned, so a preset never clobbers a pinned choice. */
export type PresetField = 'ctxSize' | 'kvCacheType' | 'flashAttn'

/** The launch-time state a mode preset merges into. */
export interface PresetState {
  ctxSize: number
  kvCacheType: KvCacheType
  flashAttn: boolean
}

/** Apply a performance-mode preset by MERGING, not clobbering: a field the user has
 *  explicitly pinned (`userExplicit`) keeps its current value; every other field takes
 *  the preset value. This is the fix for the "explicit q8_0 reverts to f16 on every
 *  restart / mode re-pick" bug — the mode preset and the granular KV control both own
 *  kvCacheType/flashAttn/ctxSize, and before this the preset always won and persisted
 *  the clobber. Pure: no side effects, returns a fresh state.
 *
 * Note the invariant restored by the caller (kept out here to keep this a pure merge):
 * a quantized KV cache requires flash-attn. That coupling lives at the call site so
 * this function stays a plain field-wise merge that's trivially testable. */
export function applyModePreset(
  current: PresetState,
  mode: PerformanceMode,
  userExplicit: ReadonlySet<PresetField>
): PresetState {
  const p = MODE_PRESETS[mode]
  return {
    ctxSize: userExplicit.has('ctxSize') ? current.ctxSize : p.ctxSize,
    kvCacheType: userExplicit.has('kvCacheType') ? current.kvCacheType : p.kvCacheType,
    flashAttn: userExplicit.has('flashAttn') ? current.flashAttn : p.flashAttn
  }
}

/** The tunable inference state that the sampling/launch math reads. Matches the
 *  private fields on LLMService so it can pass `this` straight in. */
export interface SamplingState {
  topP: number | undefined
  topK: number | undefined
  minP: number | undefined
  repeatPenalty: number | undefined
}

/** Sampling params to merge into a request payload - ONLY those the user actually
 *  set (undefined = let llama.cpp use its default). */
export function samplingPayload(s: SamplingState): Record<string, number> {
  const p: Record<string, number> = {}
  if (typeof s.topP === 'number') p.top_p = s.topP
  if (typeof s.topK === 'number') p.top_k = s.topK
  if (typeof s.minP === 'number') p.min_p = s.minP
  if (typeof s.repeatPenalty === 'number') p.repeat_penalty = s.repeatPenalty
  return p
}

/** The launch-time settings a patch is compared against to decide whether a respawn
 *  is needed. */
export interface LaunchState {
  ctxSize: number
  kvCacheType: KvCacheType
  flashAttn: boolean
  gpuLayers: number
  threads: number | undefined
  batchSize: number | undefined
}

/** The fully-resolved launch inputs the arg-builder needs. `ctxSize` is already the
 *  EFFECTIVE (RAM-clamped) value — the clamp itself is impure (reads host RAM + weight
 *  file sizes) and stays in LLMService; everything here is a pure function of these
 *  inputs so the terminal artifact (the args array handed to llama-server) is testable. */
export interface LaunchArgsInput {
  modelPath: string
  mmProjPath: string // empty string = text-only (no --mmproj)
  port: number
  effectiveCtxSize: number // already RAM-clamped
  gpuLayers: number
  flashAttn: boolean
  kvCacheType: KvCacheType
  threads: number | undefined
  batchSize: number | undefined
  // Floor on image tokens. GUI-grounding (Qwen-VL / UI-TARS) models need >=1024
  // or they ground inaccurately (llama.cpp warns); undefined = engine default.
  imageMinTokens?: number
}

/** Build the exact argv passed to `llama-server`. Pure: same inputs → same args, no I/O.
 *  This is the single source of truth for launch args, so the KV-cache / flash-attn
 *  coupling (a quantized KV cache forces `--flash-attn on` and sets both -k/-v cache
 *  types) is asserted directly against what the engine actually receives. */
export function buildLaunchArgs(i: LaunchArgsInput): string[] {
  const args = ['-m', i.modelPath]
  if (i.mmProjPath) {
    args.push('--mmproj', i.mmProjPath)
  }
  args.push(
    '--port',
    String(i.port),
    '--host',
    '127.0.0.1',
    '-c',
    String(i.effectiveCtxSize),
    '-ngl',
    String(i.gpuLayers)
  )
  // FlashAttention: faster + lower memory. Required for a quantized KV cache.
  if (i.flashAttn || i.kvCacheType !== 'f16') {
    args.push('--flash-attn', 'on')
  }
  // Quantized KV cache (q8_0/q4_0) shrinks the per-token memory footprint — the single
  // biggest lever against memory-overcommit freezes on big contexts.
  if (i.kvCacheType !== 'f16') {
    args.push('--cache-type-k', i.kvCacheType, '--cache-type-v', i.kvCacheType)
  }
  if (typeof i.threads === 'number') {
    args.push('-t', String(i.threads))
  }
  if (typeof i.batchSize === 'number') {
    args.push('-b', String(i.batchSize))
  }
  // Grounding models (UI-TARS / Qwen-VL) need a minimum image-token budget or
  // clicks land in the wrong place; only set when a projector is present.
  if (i.mmProjPath && typeof i.imageMinTokens === 'number') {
    args.push('--image-min-tokens', String(i.imageMinTokens))
  }
  return args
}

/** Whether a settings patch changes any LAUNCH-TIME arg (context, KV-cache type,
 *  flash-attn, GPU layers, threads, batch) and therefore needs a server respawn.
 *  `modeChanged` forces true (a mode switch always rewrites launch args). A field
 *  only counts when present in the patch AND different from current. */
export function launchArgsChanged(
  patch: {
    ctxSize?: number
    kvCacheType?: KvCacheType
    flashAttn?: boolean
    gpuLayers?: number
    threads?: number
    batchSize?: number
  },
  current: LaunchState,
  modeChanged: boolean
): boolean {
  return (
    modeChanged ||
    (typeof patch.ctxSize === 'number' && patch.ctxSize !== current.ctxSize) ||
    (patch.kvCacheType !== undefined && patch.kvCacheType !== current.kvCacheType) ||
    (typeof patch.flashAttn === 'boolean' && patch.flashAttn !== current.flashAttn) ||
    (typeof patch.gpuLayers === 'number' && patch.gpuLayers !== current.gpuLayers) ||
    (typeof patch.threads === 'number' && patch.threads !== current.threads) ||
    (typeof patch.batchSize === 'number' && patch.batchSize !== current.batchSize)
  )
}
