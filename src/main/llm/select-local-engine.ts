import fs from 'node:fs'
import path from 'node:path'
import { binRoots, exe } from '../runtime-env'
import { gpuDeviceAvailable } from './gpu-device-probe'
import { prioritizeBackend, type BackendPreference } from '../../shared/backend-preferences'

/** Dedicated decision and grounding models use the same GPU priority as chat. */
export async function selectLocalEngine(preference: BackendPreference = 'auto'): Promise<string | undefined> {
  const platform = process.platform
  const base = ['llama-cuda', 'llama', 'llama-cpu', '']
  const directories = preference === 'cpu'
    ? ['llama-cpu', ...base.filter((directory) => directory !== 'llama-cpu')]
    : prioritizeBackend(base, preference, (directory) =>
    directory === 'llama-cpu' ? 'cpu' : directory === 'llama-cuda' ? 'cuda' : platform === 'darwin' ? 'metal' : 'vulkan'
    )
  for (const directory of directories) {
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
