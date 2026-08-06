import { describe, it, expect } from 'vitest'
import { sdBinaryCandidates, SD_RUNTIME_DIRS } from '../sd-bin'

// Guards the Vulkan(GPU)->CPU binary ladder for stable-diffusion.cpp on Windows:
// the resolver must prefer the GPU build in sd/ and fall back to the CPU build in
// sd-cpu/, across every bin root, before giving up.
describe('sdBinaryCandidates', () => {
  it('prefers the GPU (sd/) build over the CPU (sd-cpu/) fallback', () => {
    const paths = sdBinaryCandidates(['/root'], 'sd-cli')
    const gpuIdx = paths.findIndex((p) => p.includes(`/sd/`) || p.includes(`\\sd\\`))
    const cpuIdx = paths.findIndex((p) => p.includes('sd-cpu'))
    expect(gpuIdx).toBeGreaterThanOrEqual(0)
    expect(cpuIdx).toBeGreaterThanOrEqual(0)
    expect(gpuIdx).toBeLessThan(cpuIdx) // Vulkan tried before CPU
  })

  it('covers every bin root for each runtime dir', () => {
    const roots = ['/a', '/b']
    const paths = sdBinaryCandidates(roots, 'sd-server')
    expect(paths.length).toBe(roots.length * SD_RUNTIME_DIRS.length)
    for (const root of roots) {
      expect(paths.some((p) => p.startsWith(root))).toBe(true)
    }
  })

  it('names the requested binary in every candidate', () => {
    for (const p of sdBinaryCandidates(['/root'], 'sd-cli')) {
      expect(p).toMatch(/sd-cli(\.exe)?$/)
    }
  })
})
