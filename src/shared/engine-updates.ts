// Engine updates: newer inference engines published to the runtime store between app releases.
//
// The store holds one signed index per platform and every engine file once, named by its SHA-256.
// An engine is a set of files laid out under one bin root (for example `llama-cuda/llama-server`
// and `cuda-runtime/libcudart.so.12`), so the app installs it as its own folder and searches it
// before the CUDA pack. Engines are programs the app runs, so the index must carry a valid
// signature from the publishing key before any file is trusted.
//
// Pure: parsing, signature verification and file planning. The download and install live in
// src/main/engine-updates.ts.
import { createPublicKey, verify } from 'node:crypto'

const ENGINE_STORE_ORIGIN = 'https://runtime.getoffgridai.co'

/** The Ed25519 key that signs every published engine index (SPKI, base64 DER). */
export const ENGINE_SIGNING_PUBLIC_KEY =
  'MCowBQYDK2VwAyEA1hU10iVoH2X3GLlKKCR5WVDkgu2Id3uDHYzU0JMj1Q0='

export type EnginePlatform = 'linux' | 'win32'

export interface EngineFile {
  /** Path under the engine's bin root, always with forward slashes. */
  path: string
  sha256: string
  size: number
  /** POSIX permission bits; 0o755 for executables. */
  mode?: number
}

interface EngineLink {
  path: string
  /** Symlink target, relative to the link's own folder (Linux shared-library versions). */
  target: string
}

export interface EngineRelease {
  /** Stable engine id, e.g. `llama-cuda`. */
  id: string
  /** Upstream build, e.g. `b11551`. */
  version: string
  /** The oldest app version that can run this engine. */
  minAppVersion?: string
  /** The executable used to check the engine starts, relative to the bin root. */
  smokeTest: string
  files: EngineFile[]
  links?: EngineLink[]
}

export interface EngineIndex {
  schemaVersion: 1
  platform: EnginePlatform
  engines: EngineRelease[]
}

type EngineUpdatePhase =
  | 'unsupported'
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'up-to-date'
  | 'failed'

export interface EngineUpdateStatus {
  enabled: boolean
  phase: EngineUpdatePhase
  /** Installed engine versions by id. */
  installed: Record<string, string>
  downloadedBytes: number
  totalBytes: number
  lastCheckedAt?: number
  error?: string
}

const SHA256 = /^[a-f0-9]{64}$/
const SAFE_SEGMENT = /^[A-Za-z0-9._+-]+$/
const SAFE_VERSION = /^[A-Za-z0-9._-]{1,64}$/
const MAX_FILE_BYTES = 4 * 1024 ** 3

/** A relative path that stays inside the engine folder on every platform. */
function safeEnginePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 300) return false
  const segments = value.split('/')
  return segments.every(
    (segment) => SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..'
  )
}

export function engineIndexUrl(platform: EnginePlatform): string {
  return `${ENGINE_STORE_ORIGIN}/desktop/engines/${platform}/index.json`
}

export function engineFileUrl(sha256: string): string {
  return `${ENGINE_STORE_ORIGIN}/desktop/engines/files/${sha256}`
}

/** True only when `signature` (base64) is the publishing key's Ed25519 signature of `body`. */
export function verifyEngineIndexSignature(
  body: Uint8Array,
  signature: string,
  publicKey = ENGINE_SIGNING_PUBLIC_KEY
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki'
    })
    return verify(null, body, key, Buffer.from(signature.trim(), 'base64'))
  } catch {
    return false
  }
}

function parseFile(value: unknown): EngineFile | null {
  const file = value as Partial<EngineFile> | null
  if (!file || !safeEnginePath(file.path)) return null
  if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) return null
  if (!Number.isSafeInteger(file.size) || (file.size as number) < 0) return null
  if ((file.size as number) > MAX_FILE_BYTES) return null
  if (
    file.mode !== undefined &&
    !(Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777)
  ) {
    return null
  }
  return {
    path: file.path,
    sha256: file.sha256,
    size: file.size as number,
    ...(file.mode === undefined ? {} : { mode: file.mode })
  }
}

function parseLink(value: unknown): EngineLink | null {
  const link = value as Partial<EngineLink> | null
  if (!link || !safeEnginePath(link.path)) return null
  // A target is a sibling file name, so a link can never point outside the engine folder.
  if (typeof link.target !== 'string' || !SAFE_SEGMENT.test(link.target)) return null
  if (link.target === '.' || link.target === '..') return null
  return { path: link.path, target: link.target }
}

function parseRelease(value: unknown): EngineRelease | null {
  const release = value as Partial<EngineRelease> | null
  if (!release || typeof release.id !== 'string' || !SAFE_SEGMENT.test(release.id)) return null
  if (typeof release.version !== 'string' || !SAFE_VERSION.test(release.version)) return null
  if (release.minAppVersion !== undefined && typeof release.minAppVersion !== 'string') return null
  if (!safeEnginePath(release.smokeTest)) return null
  if (!Array.isArray(release.files) || release.files.length === 0) return null
  const files = release.files.map(parseFile)
  if (files.some((file) => !file)) return null
  const links = (release.links ?? []).map(parseLink)
  if (links.some((link) => !link)) return null
  const paths = [...files.map((file) => file!.path), ...links.map((link) => link!.path)]
  if (new Set(paths.map((item) => item.toLowerCase())).size !== paths.length) return null
  if (!files.some((file) => file!.path === release.smokeTest)) return null
  return {
    id: release.id,
    version: release.version,
    ...(release.minAppVersion ? { minAppVersion: release.minAppVersion } : {}),
    smokeTest: release.smokeTest,
    files: files as EngineFile[],
    ...(links.length ? { links: links as EngineLink[] } : {})
  }
}

/** The index for `platform`, or null when it is malformed or for another platform. */
export function parseEngineIndex(value: unknown, platform: EnginePlatform): EngineIndex | null {
  const index = value as Partial<EngineIndex> | null
  if (!index || index.schemaVersion !== 1 || index.platform !== platform) return null
  if (!Array.isArray(index.engines)) return null
  const engines = index.engines.map(parseRelease)
  if (engines.some((engine) => !engine)) return null
  if (new Set(engines.map((engine) => engine!.id)).size !== engines.length) return null
  return { schemaVersion: 1, platform, engines: engines as EngineRelease[] }
}

function versionParts(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
}

/** Whether `appVersion` is at least `minimum` (numeric dotted versions; pre-release tags ignored). */
function appVersionAtLeast(appVersion: string, minimum: string): boolean {
  const app = versionParts(appVersion.split('-')[0] ?? appVersion)
  const min = versionParts(minimum.split('-')[0] ?? minimum)
  for (let i = 0; i < Math.max(app.length, min.length); i++) {
    const a = app[i] ?? 0
    const b = min[i] ?? 0
    if (a !== b) return a > b
  }
  return true
}

/** The engines this app should install: compatible and not already installed at that version. */
export function enginesToInstall(
  index: EngineIndex,
  installed: Record<string, string>,
  appVersion: string
): EngineRelease[] {
  return index.engines.filter(
    (engine) =>
      installed[engine.id] !== engine.version &&
      (!engine.minAppVersion || appVersionAtLeast(appVersion, engine.minAppVersion))
  )
}

/** Folder name for one installed engine release. */
export function engineFolderName(platform: EnginePlatform, release: EngineRelease): string {
  return `${platform}-${release.id}-${release.version}`
}
