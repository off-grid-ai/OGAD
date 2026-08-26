interface DownloadProgressEstimateInput {
  currentBytes: number
  totalBytes?: number
  bytesPerSecond?: number
}

/** A deliberately coarse ETA. Transfer rates move too much to justify second-by-second precision. */
export function downloadTimeRemaining(progress: DownloadProgressEstimateInput): string | null {
  const { currentBytes, totalBytes, bytesPerSecond } = progress
  if (
    !Number.isFinite(currentBytes) ||
    currentBytes < 0 ||
    totalBytes === undefined ||
    !Number.isFinite(totalBytes) ||
    totalBytes <= currentBytes
  ) {
    return null
  }
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return 'estimating time left'
  }
  const seconds = (totalBytes - currentBytes) / bytesPerSecond
  if (seconds < 60) {
    return `~${Math.max(5, Math.ceil(seconds / 5) * 5)} sec left`
  }
  const minutes = seconds / 60
  const roundedMinutes =
    minutes < 10 ? Math.ceil(minutes) : Math.max(10, Math.round(minutes / 5) * 5)
  return `~${roundedMinutes} min left`
}
