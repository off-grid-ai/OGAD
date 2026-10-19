import { execFileSync } from 'child_process'
import fs from 'fs'

/**
 * Where the NVIDIA driver installs nvidia-smi. The probe runs it from one of these fixed places,
 * never from a PATH lookup, so a writable directory early on PATH cannot stand in for it.
 */
const NVIDIA_SMI_PATHS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  win32: [
    'C:\\Windows\\System32\\nvidia-smi.exe',
    'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'
  ],
  // /usr/local/nvidia/bin is where GPU containers (RunPod, the NVIDIA container toolkit) mount it.
  linux: ['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi', '/usr/local/nvidia/bin/nvidia-smi']
}

/** The installed nvidia-smi for this platform, or null where the driver put none. */
export function nvidiaSmiPath(
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = fs.existsSync
): string | null {
  return (NVIDIA_SMI_PATHS[platform] ?? []).find((file) => exists(file)) ?? null
}

/**
 * Free and total VRAM of the emptiest NVIDIA GPU, in MB, or null when nvidia-smi is missing or fails. Read
 * once per team-mode launch on a CUDA machine to size llama-server's slots; never on a request.
 */
export function cudaVramMB(): { freeMB: number; totalMB: number } | null {
  const nvidiaSmi = nvidiaSmiPath()
  if (!nvidiaSmi) return null
  try {
    const out = execFileSync(
      nvidiaSmi,
      ['--query-gpu=memory.free,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 2_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const cards = out
      .split(/\r?\n/)
      .map((line) => line.split(',').map((part) => Number(part.trim())))
      .filter(([free, total]) => Number.isFinite(free) && Number.isFinite(total) && total! > 0)
      .map(([free, total]) => ({ freeMB: free!, totalMB: total! }))
    return cards.length ? cards.reduce((a, b) => (b.freeMB > a.freeMB ? b : a)) : null
  } catch {
    return null
  }
}
