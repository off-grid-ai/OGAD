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

const PACK_ORIGIN = 'https://runtime.getoffgridai.co'
const SHA256 = /^[a-f0-9]{64}$/i
const SAFE_VERSION = /^[a-zA-Z0-9._-]+$/

/** The CUDA pack for `platform`, or null when it is malformed or not served from the runtime store. */
export function parsePerformancePackAsset(
  value: unknown,
  platform: 'win32' | 'linux'
): PerformancePackAsset | null {
  const asset = value as Partial<PerformancePackAsset> | null
  if (!asset || typeof asset.url !== 'string' || typeof asset.version !== 'string') return null
  if (!SAFE_VERSION.test(asset.version)) return null
  if (typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256)) return null
  if (!Number.isSafeInteger(asset.bytes) || (asset.bytes as number) <= 0) return null
  try {
    const url = new URL(asset.url)
    if (url.origin !== PACK_ORIGIN || url.pathname !== `/desktop/cuda/${platform}/${asset.version}.tar.gz`) return null
  } catch {
    return null
  }
  return {
    url: asset.url,
    sha256: asset.sha256,
    bytes: asset.bytes as number,
    version: asset.version,
    ...(typeof asset.minDriver === 'string' && /^\d+(\.\d+)*$/.test(asset.minDriver)
      ? { minDriver: asset.minDriver }
      : {}),
    ...(Number.isSafeInteger(asset.extractedBytes) && (asset.extractedBytes as number) > 0
      ? { extractedBytes: asset.extractedBytes as number }
      : {})
  }
}
