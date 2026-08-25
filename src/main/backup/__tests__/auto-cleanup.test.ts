import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_CLEANUP_INTERVAL_MS,
  cleanupDue,
  folderDeliver,
  runAutoCleanup
} from '../auto-cleanup'

let userData: string
let temp: string
let archiveDir: string

const writeOldCapture = (name: string, content = 'png', ageDays = 40): void => {
  const dir = path.join(userData, 'captures')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  const t = new Date(Date.now() - ageDays * 86_400_000)
  fs.utimesSync(p, t, t)
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-auto-ud-'))
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-auto-tmp-'))
  archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-auto-arc-'))
})
afterEach(() => {
  for (const d of [userData, temp, archiveDir]) fs.rmSync(d, { recursive: true, force: true })
})

describe('cleanupDue', () => {
  it('is due on first ever run, after the interval, and not before', () => {
    const now = 1_800_000_000_000
    expect(cleanupDue(null, now)).toBe(true)
    expect(cleanupDue(now - AUTO_CLEANUP_INTERVAL_MS - 1, now)).toBe(true)
    expect(cleanupDue(now - AUTO_CLEANUP_INTERVAL_MS + 60_000, now)).toBe(false)
  })
})

describe('folderDeliver', () => {
  const stage = (content: string): string => {
    const dir = fs.mkdtempSync(path.join(temp, 'stage-'))
    const p = path.join(dir, 'a.zip')
    fs.writeFileSync(p, content)
    return p
  }

  it('copies into the folder, verifies the size, and removes staging', async () => {
    const staged = stage('ZIPBYTES')
    const result = await folderDeliver(archiveDir)(staged, 'offgrid-captures.zip')
    expect(result.canceled).toBe(false)
    expect(fs.readFileSync(result.path!, 'utf8')).toBe('ZIPBYTES')
    expect(fs.existsSync(staged)).toBe(false)
  })

  it('never overwrites an earlier archive - collisions get a suffix', async () => {
    fs.writeFileSync(path.join(archiveDir, 'offgrid-captures.zip'), 'EARLIER')
    const result = await folderDeliver(archiveDir)(stage('NEWER'), 'offgrid-captures.zip')
    expect(path.basename(result.path!)).toBe('offgrid-captures-2.zip')
    expect(fs.readFileSync(path.join(archiveDir, 'offgrid-captures.zip'), 'utf8')).toBe('EARLIER')
  })

  it('an unwritable destination throws (which the orchestration treats as: do not prune)', async () => {
    const file = path.join(temp, 'not-a-dir')
    fs.writeFileSync(file, 'x')
    await expect(folderDeliver(file)(stage('Z'), 'a.zip')).rejects.toThrow()
  })
})

describe('runAutoCleanup', () => {
  it('does nothing when retention is off', async () => {
    const clear = vi.fn(async () => ({ success: true }))
    const result = await runAutoCleanup({
      config: { retentionDays: 0, archiveDir: null },
      userDataDir: userData,
      clear
    })
    expect(result.status).toBe('off')
    expect(clear).not.toHaveBeenCalled()
  })

  it('with no archive folder it is a plain rolling window - prune, no ZIP', async () => {
    writeOldCapture('old.png')
    const clear = vi.fn(async () => ({ success: true }))
    const result = await runAutoCleanup({
      config: { retentionDays: 30, archiveDir: null },
      userDataDir: userData,
      clear
    })
    expect(result).toMatchObject({ status: 'cleared', archivedFiles: 0 })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(archiveDir)).toEqual([])
  })

  it('with a folder it archives the old captures, then prunes', async () => {
    writeOldCapture('old.png', 'OLDPNG')
    writeOldCapture('fresh.png', 'FRESH', 1) // inside the window - not archived
    const clear = vi.fn(async () => ({ success: true }))
    const result = await runAutoCleanup({
      config: { retentionDays: 30, archiveDir },
      userDataDir: userData,
      tempDir: temp,
      clear
    })
    expect(result.status).toBe('cleared')
    expect(result.archivedFiles).toBe(1)
    const zip = await JSZip.loadAsync(fs.readFileSync(result.archivePath!))
    expect(await zip.file('captures/old.png')!.async('string')).toBe('OLDPNG')
    expect(zip.file('captures/fresh.png')).toBeNull()
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('a failed archive means nothing is pruned (fail closed)', async () => {
    writeOldCapture('old.png')
    const file = path.join(temp, 'blocked')
    fs.writeFileSync(file, 'x') // archiveDir points at a FILE - copy will fail
    const clear = vi.fn(async () => ({ success: true }))
    const result = await runAutoCleanup({
      config: { retentionDays: 30, archiveDir: file },
      userDataDir: userData,
      tempDir: temp,
      clear
    })
    expect(result.status).toBe('failed')
    expect(clear).not.toHaveBeenCalled()
  })

  it('nothing older than the window archives nothing and still reports cleared', async () => {
    writeOldCapture('fresh.png', 'F', 2)
    const clear = vi.fn(async () => ({ success: true }))
    const result = await runAutoCleanup({
      config: { retentionDays: 30, archiveDir },
      userDataDir: userData,
      tempDir: temp,
      clear
    })
    expect(result).toMatchObject({ status: 'cleared', archivedFiles: 0 })
    expect(fs.readdirSync(archiveDir)).toEqual([]) // no empty ZIPs accumulating
    expect(clear).toHaveBeenCalledTimes(1)
  })
})
