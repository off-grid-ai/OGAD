import path from 'path'

/** Loader search path for a native server and libraries staged in one directory. */
export function nativeLibraryEnv(
  platform: NodeJS.Platform,
  binDir: string,
  inherited: Record<string, string | undefined> = {}
): Record<string, string> {
  if (platform === 'darwin') return { DYLD_LIBRARY_PATH: binDir }
  if (platform === 'linux') {
    return {
      LD_LIBRARY_PATH: inherited.LD_LIBRARY_PATH ? `${binDir}:${inherited.LD_LIBRARY_PATH}` : binDir
    }
  }
  if (platform === 'win32') {
    return { PATH: `${binDir}${path.win32.delimiter}${inherited.PATH ?? ''}` }
  }
  return {}
}
