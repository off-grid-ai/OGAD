import fs from 'fs'
import path from 'path'
import { binRoots, exe } from '../runtime-env'

/** The backend selected by the native image binary that completed the run. */
export function imageBackendForRuntime(
  platform: NodeJS.Platform,
  binaryPath: string
): 'Metal' | 'CUDA' | 'Vulkan' | 'CPU' {
  const directory = binaryPath.replace(/\\/g, '/').split('/').at(-2) ?? ''
  if (directory.endsWith('-cuda')) return 'CUDA'
  if (directory.endsWith('-cpu')) return 'CPU'
  return platform === 'darwin' ? 'Metal' : 'Vulkan'
}

/** Windows needs the system Vulkan loader before the GPU image binary can start. */
export function hasWindowsVulkanLoader(
  windowsDir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows'
): boolean {
  return fs.existsSync(path.join(windowsDir, 'System32', 'vulkan-1.dll'))
}

/** NVIDIA's Windows display driver installs this CUDA API library. */
export function hasWindowsCudaDriver(
  windowsDir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows'
): boolean {
  return fs.existsSync(path.join(windowsDir, 'System32', 'nvcuda.dll'))
}

/**
 * Resolve an image runtime. Windows prefers the Vulkan build when its loader is
 * installed, then uses the separately packaged CPU build. Linux and macOS keep
 * their existing `sd` runtime; the Linux Vulkan build contains CPU kernels too.
 */
export function findSdBinary(name: 'sd-cli' | 'sd-server'): string | null {
  let directories = ['sd', 'sd-cpu']
  if (process.platform === 'win32') {
    directories = hasWindowsCudaDriver()
      ? ['sd-cuda', 'sd', 'sd-cpu']
      : hasWindowsVulkanLoader()
        ? ['sd', 'sd-cpu']
        : ['sd-cpu', 'sd']
  }
  for (const root of binRoots()) {
    for (const directory of directories) {
      const candidate = path.join(root, directory, exe(name))
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}
