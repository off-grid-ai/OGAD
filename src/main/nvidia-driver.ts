// The installed NVIDIA driver version. CUDA builds need a minimum driver (shared policy
// NVIDIA_DRIVER_FLOORS); offering them on an older driver ends in an engine that cannot start.

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** "Kernel Module  580.82.07" (also "Open Kernel Module for x86_64  580.82.07") → "580.82.07". */
export function parseLinuxDriverVersion(text: string): string | null {
  return /Kernel Module[^\n]*?\s(\d+\.\d+(?:\.\d+)?)\s/i.exec(text)?.[1] ?? null
}

/** The driver version, 'unknown' when an NVIDIA driver is present but its version cannot be read,
 *  or null when there is no NVIDIA driver. */
export async function readNvidiaDriverVersion(
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  if (platform === 'linux') {
    try {
      return (
        parseLinuxDriverVersion(fs.readFileSync('/proc/driver/nvidia/version', 'utf8')) ?? 'unknown'
      )
    } catch {
      return null
    }
  }
  if (platform === 'win32') {
    const system32 = path.join(
      process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
      'System32'
    )
    if (!fs.existsSync(path.join(system32, 'nvcuda.dll'))) return null
    try {
      const { stdout } = await execFileAsync(
        path.join(system32, 'nvidia-smi.exe'),
        ['--query-gpu=driver_version', '--format=csv,noheader'],
        { timeout: 5_000, windowsHide: true }
      )
      return /^\s*(\d+\.\d+)/.exec(stdout)?.[1] ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }
  return null
}

let cached: string | null | undefined

/** The last read driver version (null until the first read finishes, or with no NVIDIA driver). */
export function cachedNvidiaDriverVersion(): string | null {
  return cached ?? null
}

/** Read the driver again: at startup, on wake and when the GPU settings open. */
export async function refreshNvidiaDriverVersion(): Promise<string | null> {
  cached = await readNvidiaDriverVersion().catch(() => null)
  return cached
}
