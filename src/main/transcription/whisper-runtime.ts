import path from 'path'
import { nativeLibraryEnv } from '../native-library-env'
import { nativeLadder, type NativeStep } from '../backend-facts'
export { hasWindowsNvidiaDriver, hasLinuxNvidiaDriver } from '../backend-facts'

export async function findWhisperBinary(
  name: 'whisper-cli' | 'whisper-server'
): Promise<string | null> {
  return (await findWhisperBinaries(name))[0]?.path ?? null
}

export async function findWhisperBinaries(
  name: 'whisper-cli' | 'whisper-server'
): Promise<NativeStep[]> {
  const steps = await nativeLadder('stt', name)
  if (!steps.length) throw new Error('No transcription engine is installed for this choice.')
  return steps
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
