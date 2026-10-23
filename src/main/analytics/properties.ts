import { uploadPickerExtensions } from '../files-classify'

/**
 * Pure value rules from docs/ANALYTICS.md ("Shared value rules" and "Properties on every event").
 * Nothing here reads the machine; callers pass what they measured.
 */

export type AnalyticsValue = string | number | boolean | null
export type AnalyticsProperties = Record<string, AnalyticsValue>

export type SizeBucket = '<1GB' | '1-2GB' | '2-4GB' | '4-8GB' | '>8GB'
export type ContextBucket = '<2k' | '2-8k' | '8-32k' | '>32k'
export type Engine =
  'llama.cpp' | 'mlx' | 'litert' | 'executorch' | 'coreml' | 'onnx' | 'whisper' | 'remote'
export type Backend = 'cpu' | 'gpu' | 'npu' | 'remote'

const GB = 1024 ** 3

export function sizeBucket(bytes: number): SizeBucket {
  if (bytes < GB) return '<1GB'
  if (bytes < 2 * GB) return '1-2GB'
  if (bytes < 4 * GB) return '2-4GB'
  if (bytes < 8 * GB) return '4-8GB'
  return '>8GB'
}

/** Documents are smaller than models, so they get their own coarse buckets. */
export function documentSizeBucket(bytes: number): string {
  const MB = 1024 ** 2
  if (bytes < MB) return '<1MB'
  if (bytes < 10 * MB) return '1-10MB'
  if (bytes < 100 * MB) return '10-100MB'
  return '>100MB'
}

const PUBLIC_FILE_TYPES = new Set(uploadPickerExtensions())

/**
 * A document's type for `document_added`: an extension the app can open, `other` for any other
 * suffix (it can be part of a private name, e.g. `notes.clientsecret`), `none` without one.
 */
export function documentFileType(fileName: string): string {
  const extension = /\.([^./\\]+)$/.exec(fileName)?.[1]?.toLowerCase()
  if (!extension) return 'none'
  return PUBLIC_FILE_TYPES.has(extension) ? extension : 'other'
}

export function contextBucket(tokens: number): ContextBucket {
  if (tokens < 2_000) return '<2k'
  if (tokens < 8_000) return '2-8k'
  if (tokens < 32_000) return '8-32k'
  return '>32k'
}

export function roundMs(ms: number): number {
  return Math.max(0, Math.round(ms))
}

export function roundRate(rate: number): number {
  return Math.round(rate * 10) / 10
}

export function gb(bytes: number): number {
  return Math.round(bytes / 1e9)
}

/** The quantization a GGUF file name carries, e.g. `Q4_K_M`. */
export function quantOf(fileName: string | undefined): string | null {
  if (!fileName) return null
  const match = /(?:^|[-_.])((?:I?Q\d+(?:_[A-Z0-9]+)*)|F16|BF16|F32)(?=[-_.]|$)/i.exec(fileName)
  return match ? match[1]!.toUpperCase() : null
}

/** The accelerator a runtime reported, in the spec's four values. */
export function backendOf(reported: string | null | undefined): Backend | null {
  if (!reported) return null
  const value = reported.toLowerCase()
  if (value.includes('remote')) return 'remote'
  if (value.includes('core ml') || value.includes('coreml') || value.includes('npu')) return 'npu'
  if (/(metal|cuda|vulkan|directml|dml|webgpu|gpu|mps|rocm)/.test(value)) return 'gpu'
  if (value.includes('cpu') || value.includes('wasm')) return 'cpu'
  return null
}

export type DesktopPlatform = 'macos' | 'windows' | 'linux'

export function platformOf(nodePlatform: string): DesktopPlatform {
  if (nodePlatform === 'darwin') return 'macos'
  if (nodePlatform === 'win32') return 'windows'
  return 'linux'
}

/** OS version without the patch level: `15.5`, `10.0.22631` (the build tells Windows 10 from 11). */
export function osVersionOf(platform: DesktopPlatform, systemVersion: string): string {
  const parts = systemVersion.split('.').filter(Boolean)
  return parts.slice(0, platform === 'windows' ? 3 : 2).join('.')
}

/** Language only: `en-US` → `en`. */
export function languageOf(locale: string): string {
  return (locale.split(/[-_]/)[0] ?? '').toLowerCase() || 'unknown'
}

/** A pre-release version (e.g. `0.0.117-beta.1`) is a nightly build. */
export function channelOf(version: string): 'stable' | 'nightly' {
  return version.includes('-') ? 'nightly' : 'stable'
}

/** Coarse codes for a download failure, from our own download messages. */
export function downloadErrorCode(message: string | undefined): string {
  const text = (message ?? '').toLowerCase()
  if (!text) return 'unknown'
  if (text.includes('interrupted')) return 'interrupted'
  if (/(space|enospc|disk full|storage)/.test(text)) return 'storage'
  if (/(checksum|sha256|integrity|corrupt)/.test(text)) return 'integrity'
  if (/(\b40[13]\b|unauthori[sz]ed|forbidden|gated)/.test(text)) return 'http_auth'
  if (/\b404\b|not found/.test(text)) return 'http_not_found'
  if (/\b5\d\d\b/.test(text)) return 'http_server'
  if (/(network|fetch failed|econn|etimedout|enotfound|socket|timed? ?out)/.test(text))
    return 'network'
  return 'unknown'
}

/** Coarse codes for a generation failure. */
export function generationErrorCode(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase()
  if (/(out of memory|oom|insufficient memory|cannot allocate)/.test(text)) return 'out_of_memory'
  if (/(timed? ?out|timeout)/.test(text)) return 'timeout'
  if (/(not downloaded|not found|no model)/.test(text)) return 'model_missing'
  if (/(not ready|paused|stopped|exited|econnrefused|socket hang up)/.test(text))
    return 'engine_unavailable'
  if (/(context|too long|exceeds)/.test(text)) return 'context_exceeded'
  return 'generation_failed'
}
