import { describe, expect, it } from 'vitest'
import { nativeLibraryEnv } from '../native-library-env'

describe('nativeLibraryEnv', () => {
  it('uses the macOS loader path only on macOS', () => {
    expect(nativeLibraryEnv('darwin', '/app/bin')).toEqual({ DYLD_LIBRARY_PATH: '/app/bin' })
  })

  it('uses the Linux loader path and keeps an existing search path', () => {
    expect(nativeLibraryEnv('linux', '/app/bin')).toEqual({ LD_LIBRARY_PATH: '/app/bin' })
    expect(nativeLibraryEnv('linux', '/app/bin', { LD_LIBRARY_PATH: '/usr/local/lib' })).toEqual({
      LD_LIBRARY_PATH: '/app/bin:/usr/local/lib'
    })
  })

  it('uses the Windows executable path only on Windows', () => {
    expect(nativeLibraryEnv('win32', 'C:\\app\\bin', { PATH: 'C:\\Windows' })).toEqual({
      PATH: 'C:\\app\\bin;C:\\Windows'
    })
  })
})
