import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { engineSpawnEnv } from './spawn-env'

const execFileAsync = promisify(execFile)

/** A GPU candidate must name a device for its own backend before it outranks CPU. */
export function hasGpuDevice(output: string, backend: 'CUDA' | 'Vulkan'): boolean {
  const devices = output.split(/Available devices:/i)[1]
  if (!devices) return false
  const deviceLine = new RegExp(`^\\s*${backend}\\d+\\s*:`)
  return devices.split(/\r?\n/).some((line) => {
    if (!deviceLine.test(line)) return false
    return (
      backend === 'CUDA' ||
      !/llvmpipe|lavapipe|softpipe|swiftshader|basic render driver/i.test(line)
    )
  })
}

/** The engine's own model-load log is the proof that layers reached a GPU. */
export function offloadedGpuLayers(output: string): number | null {
  const matches = [...output.matchAll(/\boffloaded\s+(\d+)\/\d+\s+layers to GPU\b/gi)]
  const count = matches.at(-1)?.[1]
  return count === undefined ? null : Number(count)
}

export async function gpuDeviceAvailable(
  serverPath: string,
  backend: 'CUDA' | 'Vulkan',
  platform: NodeJS.Platform,
  inherited: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const binDir = path.dirname(serverPath)
  try {
    const { stdout, stderr } = await execFileAsync(serverPath, ['--list-devices'], {
      timeout: 10_000,
      maxBuffer: 512 * 1024,
      env: { ...inherited, ...engineSpawnEnv({ platform, binDir, currentEnv: inherited }) }
    })
    return hasGpuDevice(`${stdout}\n${stderr}`, backend)
  } catch (error) {
    console.warn(`[LLMService] ${backend} device probe failed for ${serverPath}:`, error)
    return false
  }
}
