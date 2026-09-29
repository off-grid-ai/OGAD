export interface PerformancePackAsset {
  url: string
  sha256: string
  bytes: number
  version: string
}

export interface PerformancePackManifest {
  schemaVersion: 1
  cuda: Partial<Record<'win32' | 'linux', PerformancePackAsset>>
}

export type PerformancePackPhase =
  | 'unavailable'
  | 'not-needed'
  | 'available'
  | 'downloading'
  | 'paused'
  | 'failed'
  | 'installed'

export interface PerformancePackStatus {
  phase: PerformancePackPhase
  bytes: number
  downloadedBytes: number
  version?: string
  error?: string
  restartRequired?: boolean
}
