import fs from 'node:fs'
import path from 'node:path'
import { hasCheckpointExtension, stripCheckpointExtension } from '@offgrid/models'
import { nodeDownloadBridge } from '../composition/node-download-bridge'
import { modelsDir } from '../runtime-env'
import { resolveExistingOwnedEntry, resolveOwnedDestination } from './owned-path'

export function loraDir(): string {
  return path.join(modelsDir(), 'loras')
}

export interface LoraInfo {
  name: string
  label: string
  file: string
  sizeBytes: number
}

export function listLoras(): LoraInfo[] {
  const dir = loraDir()
  const out: LoraInfo[] = []
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!hasCheckpointExtension(file)) continue
      const ownedFile = resolveExistingOwnedEntry(dir, file)
      if (!ownedFile) continue
      const name = stripCheckpointExtension(file)
      let sizeBytes = 0
      try {
        sizeBytes = fs.statSync(ownedFile).size
      } catch {
        /* ignore */
      }
      out.push({ name, label: name.replace(/[_-]+/g, ' '), file: ownedFile, sizeBytes })
    }
  } catch {
    /* dir does not exist yet */
  }
  return out.sort((left, right) => left.label.localeCompare(right.label))
}

export function ensureLoraDir(): string {
  const dir = loraDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export async function downloadLora(
  url: string,
  filename: string,
  onProgress?: (percentage: number) => void
): Promise<string> {
  const dir = ensureLoraDir()
  const destination = resolveOwnedDestination(dir, filename)
  if (!destination || !hasCheckpointExtension(filename)) throw new Error('Invalid LoRA filename.')
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) return destination
  const bridge = nodeDownloadBridge(dir)
  await bridge.download(url, destination, {
    onProgress: (written, total) => {
      if (total > 0) onProgress?.(Math.round((written / total) * 100))
    }
  })
  return destination
}
