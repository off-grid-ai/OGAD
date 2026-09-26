import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ probe: vi.fn(), exists: vi.fn(() => true) }))
vi.mock('node:fs', () => ({ default: { existsSync: mocks.exists } }))
vi.mock('../../runtime-env', () => ({ binRoots: () => ['/bundle'], exe: () => 'llama-server' }))
vi.mock('../gpu-device-probe', () => ({ gpuDeviceAvailable: mocks.probe }))
import { selectLocalEngine } from '../select-local-engine'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('prefers a usable CUDA engine on Windows', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  mocks.probe.mockResolvedValue(true)
  expect(await selectLocalEngine()).toBe('/bundle/llama-cuda/llama-server')
})
it('uses Vulkan when CUDA has no device', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  mocks.probe.mockImplementation(async (_path, backend) => backend === 'Vulkan')
  expect(await selectLocalEngine()).toBe('/bundle/llama/llama-server')
})
it('preserves the Metal engine on macOS', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  expect(await selectLocalEngine()).toBe('/bundle/llama/llama-server')
  expect(mocks.probe).not.toHaveBeenCalled()
})
