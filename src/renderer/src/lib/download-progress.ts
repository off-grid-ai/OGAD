import { formatTransferSpeed } from '@offgrid/application'

interface DownloadProgressEstimateInput {
  currentBytes: number
  totalBytes?: number
  bytesPerSecond?: number
}

export function formatStorageBytes(bytes: number): string {
  if (!bytes) return '0 bytes'
  if (bytes < 1_000) return `${bytes} bytes`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${(bytes / 1e9).toFixed(1)} GB`
}

/** Display the canonical byte/rate projection identically on each download surface. */
export function downloadProgressSummary(progress: DownloadProgressEstimateInput): {
  bytes: string
  rate: string
  timeRemaining: string | null
} {
  return {
    bytes:
      progress.totalBytes === undefined
        ? `${formatStorageBytes(progress.currentBytes)} downloaded - Total size unavailable`
        : `${formatStorageBytes(progress.currentBytes)} of ${formatStorageBytes(progress.totalBytes)}`,
    rate:
      progress.bytesPerSecond === undefined
        ? 'Rate unavailable'
        : formatTransferSpeed(progress.bytesPerSecond),
    timeRemaining: downloadTimeRemaining(progress)
  }
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
