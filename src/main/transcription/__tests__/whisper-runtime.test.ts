import { describe, expect, it } from 'vitest'
import { whisperRuntimeLibraryEnv } from '../whisper-runtime'

describe('Whisper CUDA libraries', () => {
  it('loads bundled Linux CUDA libraries before the host path', () => {
    expect(
      whisperRuntimeLibraryEnv('linux', '/app/bin/whisper-cuda/whisper-cli', {
        LD_LIBRARY_PATH: '/host/lib'
      })
    ).toEqual({ LD_LIBRARY_PATH: '/app/bin/whisper-cuda:/app/bin/cuda-runtime:/host/lib' })
  })

  it('uses bundled Windows CUDA libraries for the accelerated Whisper binary', () => {
    expect(
      whisperRuntimeLibraryEnv('win32', 'C:\\app\\bin\\whisper\\whisper-cli.exe', {
        PATH: 'C:\\Windows'
      })
    ).toEqual({ PATH: 'C:\\app\\bin\\whisper;C:\\app\\bin\\cuda-runtime;C:\\Windows' })
  })

  it('does not add CUDA libraries to the CPU binary', () => {
    expect(
      whisperRuntimeLibraryEnv('linux', '/app/bin/whisper-cpu/whisper-cli', {})
    ).toEqual({ LD_LIBRARY_PATH: '/app/bin/whisper-cpu' })
  })
})
