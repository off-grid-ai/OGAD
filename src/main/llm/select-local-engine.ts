import fs from 'node:fs'
import path from 'node:path'
import { binRoots, exe } from '../runtime-env'
import { gpuDeviceAvailable } from './gpu-device-probe'

/** Dedicated decision and grounding models use the same GPU priority as chat. */
export async function selectLocalEngine(): Promise<string | undefined> {
  const platform = process.platform
  for (const directory of ['llama-cuda', 'llama', 'llama-cpu', '']) {
    if (platform !== 'win32' && platform !== 'linux' && directory === 'llama-cuda') continue
    for (const root of binRoots()) {
      const candidate = path.join(root, directory, exe('llama-server'))
      if (!fs.existsSync(candidate)) continue
      if (platform === 'win32' || platform === 'linux') {
        const backend =
          directory === 'llama-cuda' ? 'CUDA' : directory === 'llama' ? 'Vulkan' : null
        if (backend && !(await gpuDeviceAvailable(candidate, backend, platform))) continue
      }
      console.log(`[Local model] selected engine=${directory || 'legacy'}`)
      return candidate
    }
  }
  return undefined
}
