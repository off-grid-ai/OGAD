import fs from 'fs'
import path from 'path'
import { binRoots, exe } from '../runtime-env'
import { nativeLibraryEnv } from '../native-library-env'
import { prioritizeBackend, type BackendPreference } from '../../shared/backend-preferences'

/** NVIDIA's Windows display driver installs this API library. */
export function hasWindowsNvidiaDriver(
  windowsDir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows'
): boolean {
  return fs.existsSync(path.join(windowsDir, 'System32', 'nvcuda.dll'))
}

/** Linux GPU device nodes are created by the active NVIDIA or DRM driver. */
export function hasLinuxGpuDevice(): boolean {
  if (fs.existsSync('/dev/nvidia0')) return true
  try {
    return fs.readdirSync('/dev/dri').some((name) => name.startsWith('renderD'))
  } catch {
    return false
  }
}

/** NVIDIA's Linux device node is available only when its driver is active. */
export function hasLinuxNvidiaDriver(): boolean {
  return fs.existsSync('/dev/nvidia0')
}

/** Prefer accelerated Whisper, with a separate CPU runtime as the safe fallback. */
export function findWhisperBinary(name: 'whisper-cli' | 'whisper-server', preference: BackendPreference = 'auto'): string | null {
  return findWhisperBinaries(name, preference)[0] ?? null
}

/** Keep the CPU binary available when a present GPU driver cannot start Whisper. */
export function findWhisperBinaries(name: 'whisper-cli' | 'whisper-server', preference: BackendPreference = 'auto'): string[] {
  const gpuAvailable =
    process.platform === 'win32'
      ? hasWindowsNvidiaDriver()
      : process.platform === 'linux'
        ? hasLinuxGpuDevice()
        : true
  const accelerated =
    process.platform === 'linux' && hasLinuxNvidiaDriver()
      ? ['whisper-cuda', 'whisper', 'whisper-cpu']
      : gpuAvailable
        ? ['whisper', 'whisper-cpu']
        : ['whisper-cpu', 'whisper']
  // macOS and older packages keep the resident binary in its own directory.
  const directories = name === 'whisper-server' ? ['whisper-server', ...accelerated] : accelerated
  const binaries = directories.flatMap((directory) =>
    binRoots()
      .map((root) => path.join(root, directory, exe(name)))
      .filter((candidate) => fs.existsSync(candidate))
  )
  return prioritizeBackend(binaries, preference, (binary) => {
    const directory = path.basename(path.dirname(binary))
    if (directory === 'whisper-cpu') return 'cpu'
    if (directory === 'whisper-cuda' || (process.platform === 'win32' && directory === 'whisper')) return 'cuda'
    if (process.platform === 'darwin' && directory !== 'whisper-cpu') return 'metal'
    return 'vulkan'
  })
}

/** Let Whisper load the bundled CUDA libraries before the system runtime path. */
export function whisperRuntimeLibraryEnv(
  platform: NodeJS.Platform,
  binary: string,
  inherited: Record<string, string | undefined> = {}
): Record<string, string> {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const binDir = pathApi.dirname(binary)
  const cudaBinary =
    pathApi.basename(binDir) === 'whisper-cuda' ||
    (platform === 'win32' && pathApi.basename(binDir) === 'whisper')
  if (!cudaBinary) {
    return nativeLibraryEnv(platform, binDir, inherited)
  }
  const cudaRuntime = pathApi.join(pathApi.dirname(binDir), 'cuda-runtime')
  if (platform === 'win32') {
    return nativeLibraryEnv(platform, binDir, {
      ...inherited,
      PATH: `${cudaRuntime}${path.win32.delimiter}${inherited.PATH ?? ''}`
    })
  }
  return nativeLibraryEnv(platform, binDir, {
    ...inherited,
    LD_LIBRARY_PATH: inherited.LD_LIBRARY_PATH
      ? `${cudaRuntime}:${inherited.LD_LIBRARY_PATH}`
      : cudaRuntime
  })
}
