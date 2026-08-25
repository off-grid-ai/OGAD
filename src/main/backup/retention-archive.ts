// Archive-before-delete for the file-centric data categories (captures, meetings,
// images): collect exactly the files the category delete would remove, stage them
// into one ZIP with a manifest, deliver it to a user-chosen destination, and only
// then let the real delete run. Fail closed - a canceled or failed archive means
// nothing is deleted.
//
// Electron-free on purpose: everything here takes plain paths and injected deps
// (the save-dialog sink, clearCategory) so the ordering contract is unit-testable
// against real temp dirs. The Electron wiring lives in retention-archive-ipc.ts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { CATEGORY_DIRS, type DataCategoryId } from '../data-categories'

export interface DoomedFile {
  absPath: string
  /** Path inside the ZIP, `<dirName>/<relative path>` so multi-dir categories stay distinct. */
  zipKey: string
  bytes: number
}

/**
 * The files `clearCategory(category, olderThanDays)` would remove. Mirrors the delete's
 * exact semantics (data-privacy clearDirs/clearDirsOlderThan): the age cutoff applies to
 * TOP-LEVEL entries by mtime, and an old top-level directory is removed whole - so an old
 * day-directory contributes every file under it. Symlinks are never followed (same rule
 * as the backup archive: no symlinks in an archive).
 */
export function collectCategoryFiles(
  userDataDir: string,
  category: DataCategoryId,
  olderThanDays?: number
): DoomedFile[] {
  const cutoff = olderThanDays && olderThanDays > 0 ? Date.now() - olderThanDays * 86_400_000 : null
  const out: DoomedFile[] = []
  for (const dirName of CATEGORY_DIRS[category]) {
    const root = path.join(userDataDir, dirName)
    let entries: string[]
    try {
      entries = fs.readdirSync(root)
    } catch {
      continue // missing dir - nothing to archive there
    }
    for (const name of entries) {
      const fp = path.join(root, name)
      let st: fs.Stats
      try {
        st = fs.lstatSync(fp)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (cutoff !== null && st.mtimeMs >= cutoff) continue
      if (st.isDirectory()) collectUnder(fp, `${dirName}/${name}`, out)
      else if (st.isFile()) out.push({ absPath: fp, zipKey: `${dirName}/${name}`, bytes: st.size })
    }
  }
  return out
}

function collectUnder(dir: string, keyPrefix: string, out: DoomedFile[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const fp = path.join(dir, entry.name)
    const key = `${keyPrefix}/${entry.name}`
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) collectUnder(fp, key, out)
    else if (entry.isFile()) {
      try {
        out.push({ absPath: fp, zipKey: key, bytes: fs.statSync(fp).size })
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
}

export interface RetentionManifest {
  surface: 'offgrid-desktop-retention'
  category: DataCategoryId
  olderThanDays: number | null
  /** Everything in the archive is older than this instant (null = full clear). */
  cutoffIso: string | null
  createdIso: string
  fileCount: number
  totalBytes: number
  note: string
}

export interface StagedArchive {
  zipPath: string
  suggestedName: string
  manifest: RetentionManifest
}

/**
 * Stream the doomed files into one ZIP (STORE - the corpus is mostly PNG/media that
 * does not recompress, and it can be ~1GB, so never buffer it) plus a manifest.json.
 */
export async function stageRetentionArchive(
  files: DoomedFile[],
  opts: { category: DataCategoryId; olderThanDays?: number; tempDir?: string }
): Promise<StagedArchive> {
  const now = new Date()
  const cutoff =
    opts.olderThanDays && opts.olderThanDays > 0
      ? new Date(now.getTime() - opts.olderThanDays * 86_400_000)
      : null
  const manifest: RetentionManifest = {
    surface: 'offgrid-desktop-retention',
    category: opts.category,
    olderThanDays: opts.olderThanDays && opts.olderThanDays > 0 ? opts.olderThanDays : null,
    cutoffIso: cutoff ? cutoff.toISOString() : null,
    createdIso: now.toISOString(),
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    note: 'Files archived by Off Grid AI Desktop before a category delete. Database rows and search vectors for this category were deleted, not archived.'
  }
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  for (const file of files) {
    zip.file(file.zipKey, fs.createReadStream(file.absPath))
  }
  const stageDir = await fs.promises.mkdtemp(
    path.join(opts.tempDir ?? os.tmpdir(), 'offgrid-retention-')
  )
  const day = now.toISOString().slice(0, 10)
  const suggestedName = cutoff
    ? `offgrid-${opts.category}-before-${cutoff.toISOString().slice(0, 10)}.zip`
    : `offgrid-${opts.category}-all-${day}.zip`
  const zipPath = path.join(stageDir, suggestedName)
  await new Promise<void>((resolve, reject) => {
    zip
      .generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'STORE' })
      .pipe(fs.createWriteStream(zipPath))
      .on('finish', () => resolve())
      .on('error', reject)
  })
  return { zipPath, suggestedName, manifest }
}

export interface ArchiveDelivery {
  canceled: boolean
  path?: string
}

/** The injected seams: today's sink is the save dialog; Phase 2's scheduled cleanup
 *  swaps `deliver` for a fixed-folder copy with no dialog - same orchestration. */
export interface ArchiveClearDeps {
  collect: () => DoomedFile[]
  stage: (files: DoomedFile[]) => Promise<StagedArchive>
  deliver: (zipPath: string, suggestedName: string) => Promise<ArchiveDelivery>
  clear: () => Promise<{ success: boolean }>
}

export type ArchiveClearResult =
  | { status: 'cleared'; archivedFiles: number; archivePath?: string }
  | { status: 'canceled' }
  | { status: 'failed'; error: string }

/**
 * The ordering contract: delete runs ONLY after the archive is confirmed delivered.
 * Cancel or any archive failure leaves every file in place. Zero doomed files skips
 * the archive (nothing file-based to lose) and clears directly.
 */
export async function archiveThenClear(deps: ArchiveClearDeps): Promise<ArchiveClearResult> {
  try {
    const files = deps.collect()
    if (files.length === 0) {
      const cleared = await deps.clear()
      return cleared.success
        ? { status: 'cleared', archivedFiles: 0 }
        : { status: 'failed', error: 'Nothing to archive, but the delete failed.' }
    }
    const staged = await deps.stage(files)
    const delivery = await deps.deliver(staged.zipPath, staged.suggestedName)
    if (delivery.canceled) return { status: 'canceled' }
    const cleared = await deps.clear()
    return cleared.success
      ? { status: 'cleared', archivedFiles: files.length, archivePath: delivery.path }
      : { status: 'failed', error: 'The archive was saved, but the delete failed.' }
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}
