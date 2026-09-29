import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  PerformancePackAsset,
  PerformancePackManifest,
  PerformancePackStatus
} from '../shared/performance-pack'
import { dataDir, resourceFile } from './runtime-env'
import { hasWindowsNvidiaDriver, hasLinuxNvidiaDriver } from './transcription/whisper-runtime'

const execFileAsync = promisify(execFile)
const SHA256 = /^[a-f0-9]{64}$/i
let controller: AbortController | null = null
let task: Promise<void> | null = null
let phase: PerformancePackStatus['phase'] | null = null
let downloadedBytes = 0
let errorMessage: string | undefined
let installedThisSession = false
let notify: ((status: PerformancePackStatus) => void) | undefined

function manifestAsset(): PerformancePackAsset | null {
  const manifestPath = resourceFile('performance-packs.json')
  if (!manifestPath) return null
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PerformancePackManifest
    if (manifest.schemaVersion !== 1 || !['win32', 'linux'].includes(process.platform)) return null
    const asset = manifest.cuda[process.platform as 'win32' | 'linux']
    if (
      !asset ||
      new URL(asset.url).origin !== 'https://runtime.getoffgridai.co' ||
      new URL(asset.url).pathname !== `/desktop/cuda/${process.platform}/${asset.version}.tar.gz` ||
      !SHA256.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      !/^[a-zA-Z0-9._-]+$/.test(asset.version)
    ) return null
    return asset
  } catch {
    return null
  }
}

function hasNvidiaDriver(): boolean {
  return process.platform === 'win32'
    ? hasWindowsNvidiaDriver()
    : process.platform === 'linux' && hasLinuxNvidiaDriver()
}

function packRoot(asset: PerformancePackAsset): string {
  return path.join(dataDir(), 'performance-packs', `cuda-${asset.version}-${asset.sha256.slice(0, 12)}`)
}

function installedBin(asset: PerformancePackAsset): string | null {
  const root = packRoot(asset)
  const marker = path.join(root, 'verified.sha256')
  try {
    if (fs.readFileSync(marker, 'utf8').trim() !== asset.sha256.toLowerCase()) return null
    const bin = path.join(root, 'bin')
    if (!fs.statSync(bin).isDirectory()) return null
    return bin
  } catch {
    return null
  }
}

/** Run once during main-process setup and after installation. */
export function activateInstalledPerformancePack(): void {
  const asset = manifestAsset()
  const bin = asset && installedBin(asset)
  if (bin) process.env.OFFGRID_PERFORMANCE_PACK_BIN = bin
  else delete process.env.OFFGRID_PERFORMANCE_PACK_BIN
}

export function performancePackStatus(): PerformancePackStatus {
  const asset = manifestAsset()
  if (!asset) return { phase: 'unavailable', bytes: 0, downloadedBytes: 0 }
  if (!hasNvidiaDriver()) return { phase: 'not-needed', bytes: 0, downloadedBytes: 0 }
  if (installedBin(asset)) {
    return {
      phase: 'installed', bytes: asset.bytes, downloadedBytes: asset.bytes,
      version: asset.version, restartRequired: installedThisSession
    }
  }
  const current = phase ?? 'available'
  return {
    phase: current,
    bytes: asset.bytes,
    downloadedBytes,
    version: asset.version,
    ...(errorMessage ? { error: errorMessage } : {})
  }
}

function publish(): void {
  notify?.(performancePackStatus())
}

export function onPerformancePackChanged(callback: (status: PerformancePackStatus) => void): void {
  notify = callback
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function fetchPack(asset: PerformancePackAsset, signal: AbortSignal): Promise<void> {
  const root = packRoot(asset)
  const parent = path.dirname(root)
  fs.mkdirSync(parent, { recursive: true })
  const archive = `${root}.tar.gz.part`
  const existing = fs.existsSync(archive) ? fs.statSync(archive).size : 0
  const response = await fetch(asset.url, {
    signal,
    headers: existing > 0 ? { Range: `bytes=${existing}-` } : undefined
  })
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  const append = existing > 0 && response.status === 206
  if (append && !response.headers.get('content-range')?.startsWith(`bytes ${existing}-`)) {
    throw new Error('The server returned an invalid resume range.')
  }
  const stream = fs.createWriteStream(archive, { flags: append ? 'a' : 'w' })
  downloadedBytes = append ? existing : 0
  publish()
  let lastProgressPublishedAt = Date.now()
  try {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal.aborted) throw signal.reason
      if (!stream.write(value)) {
        await new Promise<void>((resolve, reject) => {
          stream.once('drain', resolve)
          stream.once('error', reject)
        })
      }
      downloadedBytes += value.byteLength
      if (downloadedBytes > asset.bytes) throw new Error('The download is larger than expected.')
      const now = Date.now()
      if (now - lastProgressPublishedAt >= 250 || downloadedBytes === asset.bytes) {
        publish()
        lastProgressPublishedAt = now
      }
    }
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject)
      stream.end(resolve)
    })
  } catch (error) {
    stream.destroy()
    throw error
  }
  if (downloadedBytes !== asset.bytes || (await digest(archive)) !== asset.sha256.toLowerCase()) {
    fs.rmSync(archive, { force: true })
    throw new Error('The downloaded performance files failed the size or hash check.')
  }
  const staging = `${root}.staging`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    await execFileAsync('tar', ['-xzf', archive, '-C', staging], { timeout: 300_000 })
    const bin = path.join(staging, 'bin')
    const server = path.join(bin, 'llama-cuda', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
    if (!fs.statSync(bin).isDirectory() || !fs.statSync(server).isFile()) {
      throw new Error('The performance pack is missing its CUDA chat engine.')
    }
    fs.writeFileSync(path.join(staging, 'verified.sha256'), `${asset.sha256.toLowerCase()}\n`)
    fs.rmSync(root, { recursive: true, force: true })
    fs.renameSync(staging, root)
    fs.rmSync(archive, { force: true })
    installedThisSession = true
    activateInstalledPerformancePack()
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

export function startPerformancePack(): PerformancePackStatus {
  const asset = manifestAsset()
  if (!asset || !hasNvidiaDriver() || installedBin(asset)) return performancePackStatus()
  if (task !== null) return performancePackStatus()
  phase = 'downloading'
  errorMessage = undefined
  controller = new AbortController()
  const signal = controller.signal
  publish()
  task = fetchPack(asset, signal)
    .then(() => { phase = 'installed' })
    .catch((error: unknown) => {
      if (signal.aborted) phase = 'paused'
      else {
        phase = 'failed'
        errorMessage = error instanceof Error ? error.message : String(error)
      }
    })
    .finally(() => {
      controller = null
      task = null
      publish()
    })
  return performancePackStatus()
}

export function pausePerformancePack(): PerformancePackStatus {
  controller?.abort(new Error('Download paused'))
  return performancePackStatus()
}
