import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  archiveThenClear,
  collectCategoryFiles,
  stageRetentionArchive,
  type ArchiveClearDeps,
  type DoomedFile
} from '../retention-archive'

let userData: string
let temp: string

const write = (rel: string, content = 'x', ageDays = 0): string => {
  const abs = path.join(userData, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  if (ageDays > 0) {
    const t = new Date(Date.now() - ageDays * 86_400_000)
    fs.utimesSync(abs, t, t)
  }
  return abs
}

/** Age a directory itself (clearDirsOlderThan cuts on TOP-LEVEL entry mtime). */
const ageDir = (rel: string, ageDays: number): void => {
  const t = new Date(Date.now() - ageDays * 86_400_000)
  fs.utimesSync(path.join(userData, rel), t, t)
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ret-ud-'))
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ret-tmp-'))
})
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(temp, { recursive: true, force: true })
})

describe('collectCategoryFiles', () => {
  it('collects everything for a full clear, across all of the category dirs', () => {
    write('generated-images/a.png')
    write('artifacts-library/b.html')
    write('style-thumbs/c.png')
    const files = collectCategoryFiles(userData, 'images')
    expect(files.map((f) => f.zipKey).sort()).toEqual([
      'artifacts-library/b.html',
      'generated-images/a.png',
      'style-thumbs/c.png'
    ])
  })

  it('mirrors the retention delete: only top-level entries older than the cutoff', () => {
    write('captures/old.png', 'old', 10)
    write('captures/new.png', 'new', 1)
    const files = collectCategoryFiles(userData, 'captures', 7)
    expect(files.map((f) => f.zipKey)).toEqual(['captures/old.png'])
  })

  it('an old day-directory contributes every file under it, keyed by relative path', () => {
    write('meetings/2026-01-01/audio.m4a', 'a', 1) // fresh file INSIDE an old dir
    ageDir('meetings/2026-01-01', 30)
    const files = collectCategoryFiles(userData, 'meetings', 7)
    expect(files.map((f) => f.zipKey)).toEqual(['meetings/2026-01-01/audio.m4a'])
  })

  it('never follows symlinks and survives a missing category dir', () => {
    const real = write('captures/real.png', 'r', 10)
    fs.symlinkSync(real, path.join(userData, 'captures', 'link.png'))
    const files = collectCategoryFiles(userData, 'captures', 7)
    expect(files.map((f) => f.zipKey)).toEqual(['captures/real.png'])
    expect(collectCategoryFiles(userData, 'images')).toEqual([]) // dirs never created
  })
})

describe('stageRetentionArchive', () => {
  it('stages a ZIP holding the files plus an accurate manifest', async () => {
    write('captures/old.png', 'PNGDATA', 10)
    const files = collectCategoryFiles(userData, 'captures', 7)
    const staged = await stageRetentionArchive(files, {
      category: 'captures',
      olderThanDays: 7,
      tempDir: temp
    })
    expect(staged.suggestedName).toMatch(/^offgrid-captures-before-\d{4}-\d{2}-\d{2}\.zip$/)

    const zip = await JSZip.loadAsync(fs.readFileSync(staged.zipPath))
    expect(await zip.file('captures/old.png')!.async('string')).toBe('PNGDATA')
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    expect(manifest).toMatchObject({
      surface: 'offgrid-desktop-retention',
      category: 'captures',
      olderThanDays: 7,
      fileCount: 1,
      totalBytes: 'PNGDATA'.length
    })
    expect(Date.parse(manifest.cutoffIso)).toBeLessThan(Date.now())
  })

  it('names a full clear archive by the day it was made', async () => {
    const staged = await stageRetentionArchive([], { category: 'images', tempDir: temp })
    expect(staged.suggestedName).toMatch(/^offgrid-images-all-\d{4}-\d{2}-\d{2}\.zip$/)
    expect(staged.manifest.cutoffIso).toBeNull()
  })
})

describe('archiveThenClear (the ordering contract)', () => {
  const doomed: DoomedFile[] = [{ absPath: '/tmp/x', zipKey: 'captures/x', bytes: 1 }]
  const staged = { zipPath: '/tmp/z.zip', suggestedName: 'z.zip', manifest: {} as never }

  const deps = (over: Partial<ArchiveClearDeps>): ArchiveClearDeps => ({
    collect: () => doomed,
    stage: vi.fn(async () => staged),
    deliver: vi.fn(async () => ({ canceled: false, path: '/ssd/z.zip' })),
    clear: vi.fn(async () => ({ success: true })),
    ...over
  })

  it('clears only after a confirmed delivery, reporting where the archive went', async () => {
    const d = deps({})
    const result = await archiveThenClear(d)
    expect(result).toEqual({ status: 'cleared', archivedFiles: 1, archivePath: '/ssd/z.zip' })
    expect(d.clear).toHaveBeenCalledTimes(1)
  })

  it('a canceled save dialog deletes nothing', async () => {
    const d = deps({ deliver: vi.fn(async () => ({ canceled: true })) })
    expect(await archiveThenClear(d)).toEqual({ status: 'canceled' })
    expect(d.clear).not.toHaveBeenCalled()
  })

  it('an archive failure deletes nothing', async () => {
    const d = deps({
      stage: vi.fn(async () => {
        throw new Error('disk full')
      })
    })
    expect(await archiveThenClear(d)).toEqual({ status: 'failed', error: 'disk full' })
    expect(d.clear).not.toHaveBeenCalled()
  })

  it('a delivery failure deletes nothing', async () => {
    const d = deps({
      deliver: vi.fn(async () => {
        throw new Error('destination unwritable')
      })
    })
    expect(await archiveThenClear(d)).toEqual({
      status: 'failed',
      error: 'destination unwritable'
    })
    expect(d.clear).not.toHaveBeenCalled()
  })

  it('zero doomed files skips the dialog and clears directly', async () => {
    const d = deps({ collect: () => [] })
    expect(await archiveThenClear(d)).toEqual({ status: 'cleared', archivedFiles: 0 })
    expect(d.stage).not.toHaveBeenCalled()
    expect(d.deliver).not.toHaveBeenCalled()
    expect(d.clear).toHaveBeenCalledTimes(1)
  })

  it('reports honestly when the archive saved but the delete failed', async () => {
    const d = deps({ clear: vi.fn(async () => ({ success: false })) })
    const result = await archiveThenClear(d)
    expect(result.status).toBe('failed')
  })
})
