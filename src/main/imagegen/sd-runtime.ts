import fs from 'fs'
import path from 'path'
import { binRoots, exe } from '../runtime-env'
import { nativeLibraryEnv } from '../native-library-env'

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

/**
 * Resolve an image runtime. Windows uses the compact Vulkan build when its loader
 * is installed, then uses the separately packaged CPU build. Linux and macOS keep
 * their existing `sd` runtime; the Linux Vulkan build contains CPU kernels too.
 */
export function findSdBinaries(name: 'sd-cli' | 'sd-server'): string[] {
  let directories = ['sd', 'sd-cpu']
  if (process.platform === 'win32') {
    directories = hasWindowsVulkanLoader()
      ? ['sd-cuda', 'sd', 'sd-cpu']
      : ['sd-cuda', 'sd-cpu', 'sd']
  }
  const matches: string[] = []
  for (const root of binRoots()) {
    for (const directory of directories) {
      const candidate = path.join(root, directory, exe(name))
      if (fs.existsSync(candidate) && !matches.includes(candidate)) matches.push(candidate)
    }
  }
  return matches
}

export function findSdBinary(name: 'sd-cli' | 'sd-server'): string | null {
  return findSdBinaries(name)[0] ?? null
}

/** CUDA image binaries reuse the CUDA DLLs already packaged for llama.cpp. */
export function sdRuntimeLibraryEnv(
  platform: NodeJS.Platform,
  binaryPath: string,
  inherited: Record<string, string | undefined> = {}
): Record<string, string> {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const binDir = pathApi.dirname(binaryPath)
  if (platform !== 'win32' || imageBackendForRuntime(platform, binaryPath) !== 'CUDA') {
    return nativeLibraryEnv(platform, binDir, inherited)
  }
  const cudaRuntime = pathApi.join(pathApi.dirname(binDir), 'cuda-runtime')
  return nativeLibraryEnv(platform, binDir, {
    ...inherited,
    PATH: `${cudaRuntime}${path.win32.delimiter}${inherited.PATH ?? ''}`
  })
}
