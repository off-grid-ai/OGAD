import path from 'path'
import { nativeLibraryEnv } from '../native-library-env'
import { nativeLadder, type NativeStep } from '../backend-facts'

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

export async function findSdBinaries(name: 'sd-cli' | 'sd-server'): Promise<NativeStep[]> {
  const steps = await nativeLadder('image', name)
  if (!steps.length) throw new Error('No image engine is installed for this choice.')
  return steps
}

export async function findSdBinary(name: 'sd-cli' | 'sd-server'): Promise<string | null> {
  return (await findSdBinaries(name))[0]?.path ?? null
}

/** CUDA image binaries reuse the CUDA libraries already packaged for llama.cpp. */
export function sdRuntimeLibraryEnv(
  platform: NodeJS.Platform,
  binaryPath: string,
  inherited: Record<string, string | undefined> = {}
): Record<string, string> {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const binDir = pathApi.dirname(binaryPath)
  if (imageBackendForRuntime(platform, binaryPath) !== 'CUDA') {
    return nativeLibraryEnv(platform, binDir, inherited)
  }
  const cudaRuntime = pathApi.join(pathApi.dirname(binDir), 'cuda-runtime')
  if (platform === 'linux') {
    return nativeLibraryEnv(platform, binDir, {
      ...inherited,
      LD_LIBRARY_PATH: inherited.LD_LIBRARY_PATH
        ? `${cudaRuntime}:${inherited.LD_LIBRARY_PATH}`
        : cudaRuntime
    })
  }
  return nativeLibraryEnv(platform, binDir, {
    ...inherited,
    PATH: `${cudaRuntime}${path.win32.delimiter}${inherited.PATH ?? ''}`
  })
}
