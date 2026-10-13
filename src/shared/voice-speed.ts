// Read-aloud playback speed, one rule for the Voice tab and the paired browser.

export const MIN_PLAYBACK_SPEED = 0.5
export const MAX_PLAYBACK_SPEED = 2

/** A stored speed inside the supported range, else normal speed. */
export function playbackSpeed(value: unknown): number {
  return typeof value === 'number' && value >= MIN_PLAYBACK_SPEED && value <= MAX_PLAYBACK_SPEED
    ? value
    : 1
}
