import fs from 'node:fs'
import path from 'node:path'

const choiceFile = (profile: string): string => path.join(profile, 'model-storage.json')
const scanFile = (profile: string): string => path.join(profile, 'model-scan-folders.json')

export function readModelStorageChoice(profile: string): string | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(choiceFile(profile), 'utf8'))
    return typeof value === 'string' && path.isAbsolute(value) ? value : null
  } catch {
    return null
  }
}

export function saveModelStorageChoice(profile: string, directory: string): void {
  const resolved = fs.realpathSync(directory)
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Select a folder.')
  fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK)
  const probe = path.join(resolved, `.offgrid-write-test-${process.pid}`)
  try {
    fs.writeFileSync(probe, '')
  } finally {
    if (fs.existsSync(probe)) fs.unlinkSync(probe)
  }
  const target = choiceFile(profile)
  const temp = `${target}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(resolved), { mode: 0o600 })
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
