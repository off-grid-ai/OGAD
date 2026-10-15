export interface PerformancePackAsset {
  url: string
  sha256: string
  bytes: number
  version: string
  /** Lowest NVIDIA driver the pack's CUDA 12 engines run on (shared NVIDIA_DRIVER_FLOORS otherwise). */
  minDriver?: string
  /** Size once extracted; twice the archive when absent. */
  extractedBytes?: number
}

export interface PerformancePackManifest {
  schemaVersion: 1
  cuda: Partial<Record<'win32' | 'linux', PerformancePackAsset>>
}

type PerformancePackPhase =
  | 'unavailable'
  | 'not-needed'
  | 'available'
  | 'downloading'
  | 'paused'
  | 'failed'
  | 'driver-too-old'
  | 'verifying'
  | 'installing'
  | 'testing'
  | 'installed'

export interface PerformancePackStatus {
  phase: PerformancePackPhase
  bytes: number
  downloadedBytes: number
  version?: string
  error?: string
  /** The GPU the smoke test found after install, e.g. "NVIDIA GeForce RTX 4070". */
  device?: string
  /** The installed NVIDIA driver and the lowest one the pack needs. */
  driver?: string
  minDriver?: string
  /** Disk space the download and install need, and what the drive has free. */
  needBytes?: number
  freeBytes?: number
}
