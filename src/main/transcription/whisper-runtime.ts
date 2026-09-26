import fs from 'fs'
import path from 'path'
import { binRoots, exe } from '../runtime-env'
import { existing } from './bin-resolution'

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

/** Prefer accelerated Whisper, with a separate CPU runtime as the safe fallback. */
export function findWhisperBinary(name: 'whisper-cli' | 'whisper-server'): string | null {
  const gpuAvailable =
    process.platform === 'win32'
      ? hasWindowsNvidiaDriver()
      : process.platform === 'linux'
        ? hasLinuxGpuDevice()
        : true
  const accelerated = gpuAvailable ? ['whisper', 'whisper-cpu'] : ['whisper-cpu', 'whisper']
  // macOS and older packages keep the resident binary in its own directory.
  const directories = name === 'whisper-server' ? ['whisper-server', ...accelerated] : accelerated
  return existing(
    binRoots().flatMap((root) =>
      directories.map((directory) => path.join(root, directory, exe(name)))
    )
  )
}
