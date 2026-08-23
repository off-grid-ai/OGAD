// Pure stdout/stderr progress parsing for the one-shot sd-cli path. No fs / no
// electron — the I/O shell (imagegen.ts) reads the preview PNG and calls the
// onProgress callback; this module only turns a chunk of the binary's output
// into (updated state + optional progress event). Kept as a reducer so the
// denoise->decode phase transition is testable without spawning a process.

export interface ProgressState {
  /** Seed parsed from the binary's output ("seed N"). Starts at the fallback. */
  resolvedSeed: number
  /** Once a sampling pass reaches its total, a fresh "1/N" is the VAE decode. */
  samplingDone: boolean
  /** Last step seen — a drop below it after sampling marks the decode phase. */
  prevStep: number
  /** Current phase for the UI ("Decoding" vs a confusing second 0->N count). */
  phase: 'sampling' | 'decoding'
}

export interface ProgressEvent {
  step: number
  total: number
  secPerStep: number
  phase: 'sampling' | 'decoding'
}

/** Initial reducer state. seed = the caller's fallback (e.g. -1 or a fixed seed). */
export function initialProgressState(seed: number): ProgressState {
  return { resolvedSeed: seed, samplingDone: false, prevStep: 0, phase: 'sampling' }
}

// Sampling step lines look like "12/28 - 1.26s/it" (loading lines use MB/s, so
// the s/it anchor only matches real denoising steps).
const STEP_RE = /(\d+)\/(\d+)\s*-\s*([\d.]+)s\/it/g
const SEED_RE = /seed\s+(-?\d+)/i

/** Feed one output chunk. Returns the next state and, if the chunk contained a
 *  step line, the progress event for the LAST step in it (the binary can emit
 *  several per chunk; only the newest matters for a monotonic UI). */
export function reduceProgress(
  prev: ProgressState,
  chunk: string,
  expectedTotal?: number
): { state: ProgressState; event?: ProgressEvent } {
  let resolvedSeed = prev.resolvedSeed
  const sm = chunk.match(SEED_RE)
  if (sm) resolvedSeed = parseInt(sm[1]!, 10)

  // Find the last "N/N - Xs/it" in the chunk.
  const re = new RegExp(STEP_RE.source, 'g')
  let last: RegExpExecArray | null = null
  for (let mm = re.exec(chunk); mm; mm = re.exec(chunk)) last = mm

  // Newer sd.cpp builds render a terminal progress bar without the old
  // "- Xs/it" suffix. Match that form only when its total is the requested
  // sampling-step count, so model-loading counters cannot become image progress.
  if (!last && expectedTotal && !/(?:MB|MiB)\/s/i.test(chunk)) {
    const ratioRe = /(\d+)\/(\d+)/g
    for (let mm = ratioRe.exec(chunk); mm; mm = ratioRe.exec(chunk)) {
      if (Number(mm[2]) === expectedTotal) last = mm
    }
  }

  if (!last) {
    return { state: { ...prev, resolvedSeed } }
  }

  const step = parseInt(last[1]!, 10)
  const total = parseInt(last[2]!, 10)
  const secPerStep = last[3] ? parseFloat(last[3]) : 0
  let samplingDone = prev.samplingDone
  let phase = prev.phase
  if (!samplingDone) {
    if (step >= total) samplingDone = true
  } else if (step < prev.prevStep) {
    phase = 'decoding'
  }
  const state: ProgressState = { resolvedSeed, samplingDone, prevStep: step, phase }
  if (step === prev.prevStep && phase === prev.phase) return { state }
  return { state, event: { step, total, secPerStep, phase } }
}
