import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { NVIDIA_DRIVER_FLOORS, nvidiaDriverMeets } from '@offgrid/models'
import type {
  PerformancePackAsset,
  PerformancePackManifest,
  PerformancePackStatus
} from '../shared/performance-pack'
import { dataDir, resourceFile } from './runtime-env'
import { hasWindowsNvidiaDriver, hasLinuxNvidiaDriver } from './backend-facts'
import { cachedNvidiaDriverVersion } from './nvidia-driver'
import { hasGpuDevice } from './llm/gpu-device-probe'
import { engineSpawnEnv } from './llm/spawn-env'

const execFileAsync = promisify(execFile)
const SHA256 = /^[a-f0-9]{64}$/i
/** A download that receives nothing for this long pauses, so the user can resume it. */
const STALL_MS = 60_000
/** Room left on the drive after the install, so the pack never fills it. */
const SPACE_MARGIN_BYTES = 1024 ** 3
let controller: AbortController | null = null
let task: Promise<void> | null = null
let phase: PerformancePackStatus['phase'] | null = null
let downloadedBytes = 0
let errorMessage: string | undefined
let installedDevice: string | undefined
let notify: ((status: PerformancePackStatus) => void) | undefined

class StalledDownload extends Error {
  constructor() {
    super('The download stalled. Resume it to continue.')
  }
}

function manifestAsset(): PerformancePackAsset | null {
  const manifestPath = resourceFile('performance-packs.json')
  if (!manifestPath) return null
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Omit<
      PerformancePackManifest,
      'schemaVersion'
    > & { schemaVersion?: number }
    if (manifest.schemaVersion !== 1 || !['win32', 'linux'].includes(process.platform)) return null
    // The pack carries x64 engines only.
    if (process.arch !== 'x64') return null
    const asset = manifest.cuda[process.platform as 'win32' | 'linux']
    if (
      !asset ||
      new URL(asset.url).origin !== 'https://runtime.getoffgridai.co' ||
      new URL(asset.url).pathname !== `/desktop/cuda/${process.platform}/${asset.version}.tar.gz` ||
      !SHA256.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      !/^[a-zA-Z0-9._-]+$/.test(asset.version)
    )
      return null
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

function minDriver(asset: PerformancePackAsset): string {
  return asset.minDriver ?? NVIDIA_DRIVER_FLOORS.cuda12[process.platform as 'win32' | 'linux']
}

/** A known driver below the pack's floor. An unreadable version is not held against the user. */
function driverTooOld(asset: PerformancePackAsset): string | null {
  const driver = cachedNvidiaDriverVersion()
  if (!driver || driver === 'unknown') return null
  return nvidiaDriverMeets(driver, minDriver(asset)) ? null : driver
}

/**
 * Where packs live, newest location first. Windows installs go under Local AppData: Roaming
 * AppData syncs with roaming profiles, and a 7 GB pack would sync at every sign-in. A pack already
 * installed in the older location is still found.
 */
function packParents(): string[] {
  const legacy = path.join(dataDir(), 'performance-packs')
  const local =
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Off Grid AI Desktop', 'performance-packs')
      : null
  return local && local !== legacy ? [local, legacy] : [legacy]
}

function packName(asset: PerformancePackAsset): string {
  return `cuda-${asset.version}-${asset.sha256.slice(0, 12)}`
}

function installedBin(asset: PerformancePackAsset): string | null {
  for (const parent of packParents()) {
    const root = path.join(parent, packName(asset))
    try {
      if (
        fs.readFileSync(path.join(root, 'verified.sha256'), 'utf8').trim() !==
        asset.sha256.toLowerCase()
      )
        continue
      const bin = path.join(root, 'bin')
      if (fs.statSync(bin).isDirectory()) return bin
    } catch {
      // Not installed here.
    }
  }
  return null
}

/** The verified pack's binary root, including before environment activation. */
export function installedPerformancePackBin(): string | null {
  const asset = manifestAsset()
  return asset ? installedBin(asset) : null
}

/** Run once during main-process setup and after installation. */
export function activateInstalledPerformancePack(): void {
  const asset = manifestAsset()
  const bin = asset && installedBin(asset)
  if (bin) process.env.OFFGRID_PERFORMANCE_PACK_BIN = bin
  else delete process.env.OFFGRID_PERFORMANCE_PACK_BIN
}

function freeBytes(dir: string): number | null {
  try {
    const stat = fs.statfsSync(dir)
    return Number(stat.bavail) * Number(stat.bsize)
  } catch {
    return null
  }
}

/** Space the rest of the download, the extracted files and a margin need. */
function neededBytes(asset: PerformancePackAsset, archive: string): number {
  const partial = fs.existsSync(archive) ? Math.min(fs.statSync(archive).size, asset.bytes) : 0
  return asset.bytes - partial + (asset.extractedBytes ?? asset.bytes * 2) + SPACE_MARGIN_BYTES
}

function newInstallTarget(asset: PerformancePackAsset): {
  parent: string
  root: string
  archive: string
} {
  const parent = packParents()[0]!
  const root = path.join(parent, packName(asset))
  return { parent, root, archive: `${root}.tar.gz.part` }
}

/** The nearest existing folder, for a free-space reading before the pack folder exists. */
function existingAncestor(dir: string): string {
  let current = dir
  while (!fs.existsSync(current) && path.dirname(current) !== current)
    current = path.dirname(current)
  return current
}

export function performancePackStatus(): PerformancePackStatus {
  const asset = manifestAsset()
  if (!asset) return { phase: 'unavailable', bytes: 0, downloadedBytes: 0 }
  if (!hasNvidiaDriver()) return { phase: 'not-needed', bytes: 0, downloadedBytes: 0 }
  const driver = cachedNvidiaDriverVersion() ?? undefined
  if (installedBin(asset)) {
    return {
      phase: 'installed',
      bytes: asset.bytes,
      downloadedBytes: asset.bytes,
      version: asset.version,
      ...(installedDevice ? { device: installedDevice } : {}),
      ...(driver ? { driver } : {})
    }
  }
  const tooOld = driverTooOld(asset)
  if (tooOld) {
    return {
      phase: 'driver-too-old',
      bytes: asset.bytes,
      downloadedBytes: 0,
      version: asset.version,
      driver: tooOld,
      minDriver: minDriver(asset)
    }
  }
  const target = newInstallTarget(asset)
  const free = freeBytes(existingAncestor(target.parent))
  return {
    phase: phase ?? 'available',
    bytes: asset.bytes,
    downloadedBytes,
    version: asset.version,
    needBytes: neededBytes(asset, target.archive),
    ...(free === null ? {} : { freeBytes: free }),
    ...(driver ? { driver } : {}),
    ...(errorMessage ? { error: errorMessage } : {})
  }
}

function publish(): void {
  notify?.(performancePackStatus())
}

function setPhase(next: PerformancePackStatus['phase']): void {
  phase = next
  publish()
}

export function onPerformancePackChanged(callback: (status: PerformancePackStatus) => void): void {
  notify = callback
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** One read of the response body, or a stall error when nothing arrives for STALL_MS. */
async function readWithStall<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StalledDownload()), STALL_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Download the rest of the archive. A complete archive is left as it is. */
async function download(
  asset: PerformancePackAsset,
  archive: string,
  signal: AbortSignal
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let existing = fs.existsSync(archive) ? fs.statSync(archive).size : 0
    if (existing > asset.bytes) {
      fs.rmSync(archive, { force: true })
      existing = 0
    }
    downloadedBytes = existing
    if (existing === asset.bytes) return
    const response = await fetch(asset.url, {
      signal,
      headers: existing > 0 ? { Range: `bytes=${existing}-` } : undefined
    })
    // 416: the server has nothing past what is on disk. Start over once.
    if (response.status === 416) {
      fs.rmSync(archive, { force: true })
      continue
    }
    if (!response.ok || !response.body)
      throw new Error(`The download failed (HTTP ${response.status}). Try again.`)
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
      for (;;) {
        const { done, value } = await readWithStall(reader.read())
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
    return
  }
  throw new Error('The download could not be resumed. Try again.')
}

/** Windows ships bsdtar in System32; a GNU tar earlier on PATH (Git for Windows) reads "C:\…" as
 *  a remote host. */
function tarCommand(): string {
  if (process.platform !== 'win32') return 'tar'
  const system = path.join(
    process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
    'System32',
    'tar.exe'
  )
  return fs.existsSync(system) ? system : 'tar'
}

/** Proof that the pack's CUDA engine starts on this GPU: the device it reports, or null. */
async function smokeTest(bin: string): Promise<string | null> {
  const server = path.join(
    bin,
    'llama-cuda',
    process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  )
  const binDir = path.dirname(server)
  try {
    const { stdout, stderr } = await execFileAsync(server, ['--list-devices'], {
      timeout: 30_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        ...engineSpawnEnv({ platform: process.platform, binDir, currentEnv: process.env })
      }
    })
    const output = `${stdout}\n${stderr}`
    if (!hasGpuDevice(output, 'CUDA')) return null
    const devices = output.split(/Available devices:/i)[1] ?? ''
    return /^\s*CUDA0\s*:\s*([^(\r\n]+)/m.exec(devices)?.[1]?.trim() || 'NVIDIA GPU'
  } catch {
    return null
  }
}

async function fetchPack(asset: PerformancePackAsset, signal: AbortSignal): Promise<void> {
  const { parent, root, archive } = newInstallTarget(asset)
  fs.mkdirSync(parent, { recursive: true })
  const free = freeBytes(parent)
  const need = neededBytes(asset, archive)
  if (free !== null && free < need) {
    const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1)
    throw new Error(`Needs ${gb(need)} GB free on this drive; it has ${gb(free)} GB.`)
  }
  await download(asset, archive, signal)

  setPhase('verifying')
  if (
    fs.statSync(archive).size !== asset.bytes ||
    (await digest(archive)) !== asset.sha256.toLowerCase()
  ) {
    fs.rmSync(archive, { force: true })
    downloadedBytes = 0
    throw new Error('The download was damaged. Download it again.')
  }

  setPhase('installing')
  const staging = `${root}.staging`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    // No timeout: 7 GB extracts slowly on some disks. The verified archive stays until the install
    // succeeds, so a retry installs again without downloading again.
    try {
      await execFileAsync(tarCommand(), ['-xzf', archive, '-C', staging], { windowsHide: true })
    } catch {
      throw new Error('Could not install the files. Try again.')
    }
    const bin = path.join(staging, 'bin')
    const server = path.join(
      bin,
      'llama-cuda',
      process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
    )
    if (!fs.statSync(bin).isDirectory() || !fs.statSync(server).isFile()) {
      throw new Error('The performance pack is missing its CUDA chat engine.')
    }
    if (
      process.platform === 'linux' &&
      (!fs.existsSync(path.join(bin, 'onnx-cuda', 'libcublasLt.so.13')) ||
        !fs.existsSync(path.join(bin, 'onnx-cuda', 'libcudnn.so.9')))
    ) {
      throw new Error('The performance pack is missing its CUDA speech libraries.')
    }

    setPhase('testing')
    const device = await smokeTest(bin)
    if (!device)
      throw new Error(
        'The GPU did not start with these files. Update your NVIDIA driver, then try again.'
      )

    fs.writeFileSync(path.join(staging, 'verified.sha256'), `${asset.sha256.toLowerCase()}\n`)
    fs.rmSync(root, { recursive: true, force: true })
    fs.renameSync(staging, root)
    fs.rmSync(archive, { force: true })
    installedDevice = device
    activateInstalledPerformancePack()
    // Engines read the pack at their next spawn; voice and search helpers restart onto it, and
    // Windows tests its ONNX CUDA addon first. No app restart.
    void (async () => {
      const [{ invalidateBackendFacts }, { probeOnnxCuda }, { embeddings }, { ttsOnnxRuntime }] =
        await Promise.all([
          import('./backend-facts'),
          import('./onnx-host/onnx-cuda-probe'),
          import('./embeddings'),
          import('./tts')
        ])
      invalidateBackendFacts()
      await probeOnnxCuda()
      invalidateBackendFacts()
      await Promise.all([embeddings.restart(), ttsOnnxRuntime.restart()])
    })().catch((error: unknown) => console.warn('[performance-pack] helper restart failed', error))
    // The CUDA engine is now available: auto-managed installs move onto it.
    void import('./best-settings')
      .then((m) => {
        m.forgetDetectedMachine()
        return m.ensureBestSettings()
      })
      .catch((error: unknown) => console.warn('[best-settings] CUDA refresh failed', error))
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

export function startPerformancePack(): PerformancePackStatus {
  const asset = manifestAsset()
  if (!asset || !hasNvidiaDriver() || installedBin(asset) || driverTooOld(asset))
    return performancePackStatus()
  if (task !== null) return performancePackStatus()
  phase = 'downloading'
  errorMessage = undefined
  controller = new AbortController()
  const signal = controller.signal
  publish()
  task = fetchPack(asset, signal)
    .then(() => {
      phase = 'installed'
    })
    .catch((error: unknown) => {
      if (signal.aborted) phase = 'paused'
      else if (error instanceof StalledDownload) {
        phase = 'paused'
        errorMessage = error.message
      } else {
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
