import fs from 'node:fs'
import path from 'node:path'
import {
  BACKEND_MODALITIES,
  NVIDIA_DRIVER_FLOORS,
  backendChoicesFor,
  backendLadder,
  nvidiaDriverMeets,
  type BackendFacts,
  type BackendReason,
  type BackendModality,
  type BackendChoice,
  type EngineCandidate,
  type NativeBackend,
  type OnnxDevice
} from '@offgrid/models'
import { binRoots, exe } from './runtime-env'
import { gpuDeviceAvailable } from './llm/gpu-device-probe'
import { performancePackStatus, installedPerformancePackBin } from './performance-pack'
import { getBackendPreference } from './backend-preferences'
import { cachedNvidiaDriverVersion } from './nvidia-driver'
import { onnxCudaVerified } from './onnx-host/onnx-cuda-probe'

const demoted: BackendFacts['demoted'] = {}
const probes = new Map<string, Promise<boolean>>()
/** The installed NVIDIA driver version, as last read (nvidia-driver.ts). */
export function nvidiaDriverVersion(): string | null {
  return cachedNvidiaDriverVersion()
}

export function hasWindowsNvidiaDriver(
  windowsDir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows'
): boolean {
  return fs.existsSync(path.join(windowsDir, 'System32', 'nvcuda.dll'))
}

export function hasLinuxNvidiaDriver(): boolean {
  try {
    return fs.readdirSync('/dev').some((name) => /^nvidia\d+$/.test(name))
  } catch {
    return false
  }
}

function hasLinuxGpuDevice(): boolean {
  if (hasLinuxNvidiaDriver()) return true
  try {
    return fs.readdirSync('/dev/dri').some((name) => name.startsWith('renderD'))
  } catch {
    return false
  }
}

/** Scan paths here; ordering and fallback belong to the shared policy. */
function scanEngineCandidates(
  modality: BackendModality,
  binaryName?: string,
  prism = false
): EngineCandidate[] {
  if (modality === 'tts' || modality === 'embeddings') return []
  const platform = process.platform
  const native = platform === 'darwin' ? 'metal' : 'vulkan'
  const llama = ['llm', 'grounding', 'decision'].includes(modality)
  const prefix = prism ? 'llama-prism' : 'llama'
  const folders: [string, NativeBackend][] = []
  if (llama) {
    if (platform === 'win32' || platform === 'linux') folders.push([`${prefix}-cuda`, 'cuda'])
    folders.push([prefix, native], [`${prefix}-cpu`, 'cpu'])
    if (!prism) folders.push(['', native])
  } else if (modality === 'image') {
    folders.push(['sd-cuda', 'cuda'], ['sd', native], ['sd-cpu', 'cpu'])
  } else {
    folders.push(
      ['whisper-cuda', 'cuda'],
      ['whisper', platform === 'win32' ? 'cuda' : native],
      ['whisper-vulkan', 'vulkan'],
      ['whisper-cpu', 'cpu']
    )
    if (platform === 'darwin' && (!binaryName || binaryName === 'whisper-server')) {
      folders.push(['whisper-server', 'metal'])
    }
  }
  const names = binaryName
    ? [binaryName]
    : llama
      ? ['llama-server']
      : modality === 'image'
        ? ['sd-server', 'sd-cli']
        : ['whisper-cli', 'whisper-server']
  const candidates: EngineCandidate[] = []
  const driver = nvidiaDriverVersion()
  for (const [folder, backend] of folders) {
    for (const root of binRoots()) {
      for (const name of names) {
        const id = path.resolve(root, folder, exe(name))
        if (!fs.existsSync(id) || candidates.some((candidate) => candidate.id === id)) continue
        let reason: EngineCandidate['reason']
        if (backend === 'cuda') {
          const present =
            platform === 'win32'
              ? hasWindowsNvidiaDriver()
              : platform === 'linux' && hasLinuxNvidiaDriver()
          const floor = NVIDIA_DRIVER_FLOORS.cuda12[platform as 'win32' | 'linux']
          if (!present) reason = { code: 'no-device' }
          else if (driver && floor && !nvidiaDriverMeets(driver, floor))
            reason = { code: 'driver-too-old', have: driver, need: floor }
        }
        if (
          modality === 'image' &&
          backend === 'vulkan' &&
          platform === 'win32' &&
          !fs.existsSync(
            path.join(
              process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows',
              'System32',
              'vulkan-1.dll'
            )
          )
        )
          reason = { code: 'no-device' }
        if (modality === 'stt' && backend !== 'cpu' && platform === 'linux' && !hasLinuxGpuDevice())
          reason = { code: 'no-device' }
        candidates.push({ id, backend, usable: !reason, ...(reason ? { reason } : {}) })
      }
    }
  }
  return candidates
}

export async function engineCandidates(
  modality: BackendModality,
  binaryName?: string,
  prism = false
): Promise<EngineCandidate[]> {
  return probeCandidates(modality, scanEngineCandidates(modality, binaryName, prism))
}

async function probeCandidates(
  modality: BackendModality,
  candidates: EngineCandidate[]
): Promise<EngineCandidate[]> {
  if (
    !['llm', 'grounding', 'decision'].includes(modality) ||
    !['win32', 'linux'].includes(process.platform)
  )
    return candidates
  return Promise.all(
    candidates.map(async (candidate) => {
      if (!candidate.usable || candidate.backend === 'cpu') return candidate
      let probe = probes.get(candidate.id)
      if (!probe) {
        probe = gpuDeviceAvailable(
          candidate.id,
          candidate.backend === 'cuda' ? 'CUDA' : 'Vulkan',
          process.platform
        )
        probes.set(candidate.id, probe)
      }
      return (await probe)
        ? candidate
        : { ...candidate, usable: false, reason: { code: 'no-device' as const } }
    })
  )
}

/** Availability checks only inspect installed files; launches use nativeLadder. */
export function nativeBinaryInstalled(modality: BackendModality, binaryName: string): boolean {
  return scanEngineCandidates(modality, binaryName).length > 0
}

function runtimeFacts(): BackendFacts {
  const status = performancePackStatus()
  const packBin = installedPerformancePackBin()
  const installed = packBin !== null
  const driver = nvidiaDriverVersion()
  const floor = NVIDIA_DRIVER_FLOORS.cuda13.linux
  const libraries = !!packBin && fs.existsSync(path.join(packBin, 'onnx-cuda', 'libcublasLt.so.13'))
  const onnxCuda: BackendFacts['onnxCuda'] =
    process.platform === 'win32'
      ? onnxCudaVerified()
      : process.platform === 'linux'
        ? !installed || !libraries
          ? { usable: false, reason: { code: 'needs-pack' } }
          : !nvidiaDriverMeets(driver, floor)
            ? {
                usable: false,
                reason: { code: 'driver-too-old', have: driver ?? 'unknown', need: floor }
              }
            : { usable: true }
        : { usable: false, reason: { code: 'no-device' } }
  return {
    platform: process.platform,
    arch: process.arch,
    engines: {},
    nvidiaDriver: driver,
    pack: { offered: status.phase !== 'unavailable' && status.phase !== 'not-needed', installed },
    onnxCuda,
    demoted
  }
}

export async function backendFacts(modality?: BackendModality): Promise<BackendFacts> {
  const facts = runtimeFacts()
  await Promise.all(
    (modality ? [modality] : BACKEND_MODALITIES).map(async (value) => {
      facts.engines[value] = await engineCandidates(value)
    })
  )
  return facts
}

export function demoteBackend(modality: BackendModality, backend: NativeBackend): void {
  const backends = (demoted[modality] ??= [])
  if (!backends.includes(backend)) backends.push(backend)
}
export function clearDemotions(modality?: BackendModality): void {
  for (const value of modality ? [modality] : BACKEND_MODALITIES) delete demoted[value]
}
/** Forget cached device answers after a pack install, a driver change or wake. */
export function invalidateBackendFacts(): void {
  probes.clear()
}
/** One rung of a native engine ladder: the binary, what it was built for, and whether it must run
 *  CPU-only (llama `--device none`, whisper `-ng`, sd `--backend cpu`). */
export interface NativeStep {
  path: string
  backend: NativeBackend
  cpuOnly: boolean
  reason?: BackendReason
}

export async function nativeLadder(
  modality: BackendModality,
  binaryName?: string,
  preference = getBackendPreference(modality),
  prism = false
): Promise<NativeStep[]> {
  const facts = runtimeFacts()
  facts.engines[modality] =
    preference === 'cpu'
      ? scanEngineCandidates(modality, binaryName, prism)
      : await engineCandidates(modality, binaryName, prism)
  return backendLadder(modality, preference, facts).map((step) => ({
    path: step.engine,
    backend: step.backend as NativeBackend,
    cpuOnly: step.cpuOnly,
    reason: step.reason
  }))
}
export function onnxLadder(modality: 'tts' | 'embeddings'): OnnxDevice[] {
  return backendLadder(modality, getBackendPreference(modality), runtimeFacts()).map(
    (step) => step.engine as OnnxDevice
  )
}
export async function backendChoicesForUi(): Promise<Record<BackendModality, BackendChoice[]>> {
  const facts = await backendFacts()
  return Object.fromEntries(
    BACKEND_MODALITIES.map((modality) => [modality, backendChoicesFor(modality, facts)])
  ) as Record<BackendModality, BackendChoice[]>
}
