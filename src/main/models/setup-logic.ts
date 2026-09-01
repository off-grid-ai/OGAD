// Pure decision logic for the setup / "Configure for me" surface, extracted from
// setup.ts so it's unit-testable WITHOUT Electron/os/http. No side effects, no IO.
// The size/param math lives in @offgrid/models - this module reuses it and
// never re-derives it.

import type { RecMode } from './setup-types'

/** Normalize a raw performanceMode string (from settings) to a RecMode, defaulting
 *  to 'balanced' for anything that isn't a recognized non-default mode. This is the
 *  one rule both getRecommendation and getSetupPlan used inline - defined once. */
export function normalizeMode(raw?: string | null): RecMode {
  return raw === 'conservative' || raw === 'extreme' ? raw : 'balanced'
}

/** The RAM-budget fraction "Configure for me" spends on chat weights per mode. This
 *  is the recommendChatModel budget knob (distinct from the runtime context budget,
 *  which governs KV/context clamping). */
export function recommendBudgetFraction(mode: RecMode): number {
  return mode === 'conservative' ? 0.3 : mode === 'extreme' ? 0.55 : 0.38
}

/** The RAM budget (bytes) for the chat weights, given machine RAM (GB) and mode. */
export function recommendBudgetBytes(ramGb: number, mode: RecMode): number {
  return ramGb * recommendBudgetFraction(mode) * 1e9
}

// The non-chat baseline "Configure for me" sets up. Binaries ship in the app; only
// these MODELS download. Image is heavy (~4GB) so it's skipped in Conservative.
// Whisper scales with the mode (tiny -> base -> small). TTS is tiny and fixed.
export const STT_MODEL_BY_MODE: Record<RecMode, string> = {
  conservative: 'ggerganov/whisper.cpp/tiny', // ~78MB
  balanced: 'ggerganov/whisper.cpp/base', // ~148MB
  extreme: 'ggerganov/whisper.cpp/small' // ~488MB
}
export const TTS_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX' // text-to-speech, ~82M
export const IMAGE_MODEL_ID = 'offgrid-ai/juggernaut-xl-v9-GGUF' // image gen, ~4.35GB

export type SetupItemKind = 'chat' | 'transcription' | 'voice' | 'image'

/** A baseline extra (non-chat) the setup plan lists for a mode, in order:
 *  speech-to-text, text-to-speech, then image (only outside Conservative). The chat
 *  item is prepended by the caller since it needs an async recommendation. */
export function baselineExtras(
  mode: RecMode
): { kind: SetupItemKind; capability: string; id: string; fallbackName: string }[] {
  const items: { kind: SetupItemKind; capability: string; id: string; fallbackName: string }[] = [
    {
      kind: 'transcription',
      capability: 'Speech-to-text',
      id: STT_MODEL_BY_MODE[mode],
      fallbackName: 'Whisper'
    },
    { kind: 'voice', capability: 'Text-to-speech', id: TTS_MODEL_ID, fallbackName: 'Kokoro TTS' }
  ]
  if (mode !== 'conservative') {
    items.push({
      kind: 'image',
      capability: 'Image generation',
      id: IMAGE_MODEL_ID,
      fallbackName: 'Juggernaut XL v9'
    })
  }
  return items
}

/** Sum the download size (GB) of a plan's not-yet-installed items. */
export function totalDownloadGb(items: { sizeGb: number; installed: boolean }[]): number {
  return items.filter((i) => !i.installed).reduce((s, i) => s + i.sizeGb, 0)
}

export type FitLevel = 'ok' | 'tight' | 'risky'

/** The user-facing copy for a RAM-fit verdict. 'ok' is silent (no warning);
 *  'tight'/'risky' explain the tradeoff in plain terms. Copy contract - guarded by
 *  a test so wording changes are deliberate. No em dashes, no banned words. */
export function fitMessage(level: FitLevel, weightsGb: number, ramGb: number): string {
  if (level === 'ok') return ''
  const w = weightsGb.toFixed(1)
  if (level === 'tight') {
    return `This model's weights are ~${w} GB of your ${ramGb} GB. It'll run, but its context window will be reduced to stay within memory.`
  }
  return `This model's weights are ~${w} GB on a ${ramGb} GB machine - it may run slowly, use heavy swap, or fail to load. Context will be heavily reduced. Consider a smaller model.`
}
