import { describe, expect, it } from 'vitest'
import { imageBackendForRuntime } from '../sd-runtime'

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
