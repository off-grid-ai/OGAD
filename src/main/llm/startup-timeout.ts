/**
 * How long a starting llama-server may stay silent before we treat it as stuck.
 * There is no total deadline: each line of load progress starts the quiet period again,
 * and an engine that crashes fails at once. Mapping a large model from a USB drive can
 * produce no output for several minutes, so all engines get ten minutes of silence
 * before the next engine can try.
 */
export function modelStartupQuietLimit(_engineName: string): number {
  return 600_000
}

/** True when the server has written nothing for longer than `quietLimit`. */
export function startupStalled(now: number, lastOutputAt: number, quietLimit: number): boolean {
  return now - lastOutputAt > quietLimit
}
