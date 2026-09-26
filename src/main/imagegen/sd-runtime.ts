import fs from 'fs'
import path from 'path'
import { binRoots, exe } from '../runtime-env'

/** Windows needs the system Vulkan loader before the GPU image binary can start. */
export function hasWindowsVulkanLoader(
  windowsDir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows'
): boolean {
  return fs.existsSync(path.join(windowsDir, 'System32', 'vulkan-1.dll'))
}

/**
 * Resolve an image runtime. Windows prefers the Vulkan build when its loader is
 * installed, then uses the separately packaged CPU build. Linux and macOS keep
 * their existing `sd` runtime; the Linux Vulkan build contains CPU kernels too.
 */
export function findSdBinary(name: 'sd-cli' | 'sd-server'): string | null {
  const directories =
    process.platform === 'win32' && !hasWindowsVulkanLoader() ? ['sd-cpu', 'sd'] : ['sd', 'sd-cpu']
  for (const root of binRoots()) {
    for (const directory of directories) {
      const candidate = path.join(root, directory, exe(name))
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}
