import path from 'path'

/** Loader search path for a native server and libraries staged in one directory. */
export function nativeLibraryEnv(
  platform: NodeJS.Platform,
  binDir: string,
  inherited: Record<string, string | undefined> = {}
): Record<string, string> {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const folder = pathApi.basename(binDir)
  const cudaEnv: Record<string, string> =
    (folder.endsWith('-cuda') || (platform === 'win32' && folder === 'whisper')) &&
    inherited.CUDA_CACHE_MAXSIZE === undefined
      ? { CUDA_CACHE_MAXSIZE: '4294967296' }
      : {}
  if (platform === 'darwin') return { ...cudaEnv, DYLD_LIBRARY_PATH: binDir }
  if (platform === 'linux') {
    return {
      ...cudaEnv,
      LD_LIBRARY_PATH: inherited.LD_LIBRARY_PATH ? `${binDir}:${inherited.LD_LIBRARY_PATH}` : binDir
    }
  }
  if (platform === 'win32') {
    return {
      ...cudaEnv,
      GGML_VK_DISABLE_BFLOAT16: '1',
      PATH: `${binDir}${path.win32.delimiter}${inherited.PATH ?? ''}`
    }
  }
  return cudaEnv
}
