import { describe, expect, it } from 'vitest'
import { imageBackendForRuntime, sdRuntimeLibraryEnv } from '../sd-runtime'

describe('imageBackendForRuntime', () => {
  it.each([
    ['darwin', '/app/bin/sd/sd-cli', 'Metal'],
    ['win32', 'C:\\app\\bin\\sd-cuda\\sd-cli.exe', 'CUDA'],
    ['win32', 'C:\\app\\bin\\sd\\sd-cli.exe', 'Vulkan'],
    ['linux', '/app/bin/sd/sd-cli', 'Vulkan'],
    ['linux', '/app/bin/sd-cpu/sd-cli', 'CPU']
  ] as const)('reports %s %s as %s', (platform, binary, expected) => {
    expect(imageBackendForRuntime(platform, binary)).toBe(expected)
  })
})

describe('sdRuntimeLibraryEnv', () => {
  it('adds the shared CUDA runtime for the Windows CUDA image engine', () => {
    expect(
      sdRuntimeLibraryEnv('win32', 'C:\\app\\bin\\sd-cuda\\sd-cli.exe', {
        PATH: 'C:\\Windows'
      })
    ).toEqual({
      PATH: 'C:\\app\\bin\\sd-cuda;C:\\app\\bin\\cuda-runtime;C:\\Windows'
    })
  })

  it('keeps the normal loader path for Vulkan', () => {
    expect(
      sdRuntimeLibraryEnv('win32', 'C:\\app\\bin\\sd\\sd-cli.exe', {
        PATH: 'C:\\Windows'
      })
    ).toEqual({ PATH: 'C:\\app\\bin\\sd;C:\\Windows' })
  })
})
