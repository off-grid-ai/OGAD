import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface PendingModelCleanup {
  source: string
  destination: string
  name: string
  size: number
  sourceMtimeMs?: number // Absent in older journals, which require a source hash.
  sha256: string
}

export function readPendingModelCleanup(profile: string): PendingModelCleanup[] {
  try {
    const value = JSON.parse(fs.readFileSync(choiceFile(profile), 'utf8'))
    return Array.isArray(value?.pendingCleanup) ? value.pendingCleanup : []
  } catch {
    return []
  }
}

const choiceFile = (profile: string): string => path.join(profile, 'model-storage.json')
const scanFile = (profile: string): string => path.join(profile, 'model-scan-folders.json')

export function readModelStorageChoice(profile: string): string | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(choiceFile(profile), 'utf8'))
    const directory =
      typeof value === 'string' ? value : (value as { modelsDir?: unknown } | null)?.modelsDir
    return typeof directory === 'string' && path.isAbsolute(directory) ? directory : null
  } catch {
    return null
  }
}

export function saveModelStorageChoice(
  profile: string,
  directory: string,
  pendingCleanup = readPendingModelCleanup(profile)
): void {
  const resolved = fs.realpathSync(directory)
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Select a folder.')
  fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK)
  const probe = path.join(resolved, `.offgrid-write-test-${randomUUID()}`)
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' })
  } finally {
    if (fs.existsSync(probe)) fs.unlinkSync(probe)
  }
  const target = choiceFile(profile)
  const temp = `${target}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify({ modelsDir: resolved, pendingCleanup }), { mode: 0o600 })
    fs.renameSync(temp, target)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}

export function readModelScanFolders(profile: string): string[] {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(scanFile(profile), 'utf8'))
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && path.isAbsolute(item))
      : []
  } catch {
    return []
  }
}

export function addModelScanFolder(profile: string, directory: string): string[] {
  const resolved = fs.realpathSync(directory)
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Select a folder.')
  fs.accessSync(resolved, fs.constants.R_OK)
  const folders = [...new Set([...readModelScanFolders(profile), resolved])]
  fs.writeFileSync(scanFile(profile), JSON.stringify(folders), { mode: 0o600 })
  return folders
}

export function removeModelScanFolder(profile: string, directory: string): string[] {
  const folders = readModelScanFolders(profile).filter((item) => item !== directory)
  fs.writeFileSync(scanFile(profile), JSON.stringify(folders), { mode: 0o600 })
  return folders
}
