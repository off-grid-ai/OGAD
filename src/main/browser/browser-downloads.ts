import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DownloadItem, Session } from 'electron'
import type { BrowserDownload } from '../../shared/browser-library'

/** The browser's downloads for this run, newest first. Files go to the Downloads folder. */
export class BrowserDownloads {
  private readonly items = new Map<string, { item: DownloadItem; record: BrowserDownload }>()
  private readonly attached = new WeakSet<Session>()
  /**
   * Save paths held by downloads that have not finished, keyed case-insensitively as Chromium
   * keys its own reservations. A download's file may not exist yet, so the filesystem alone
   * would hand two same-name downloads one path, and they would overwrite each other.
   */
  private readonly reserved = new Map<string, string>()

  constructor(
    private readonly directory: () => string,
    private readonly onChange: (downloads: BrowserDownload[]) => void,
    private readonly now: () => number = Date.now
  ) {}

  attach(session: Session): void {
    if (this.attached.has(session)) return
    this.attached.add(session)
    session.on('will-download', (_event, item) => this.track(item))
  }

  list(): BrowserDownload[] {
    return [...this.items.values()]
      .map(({ record }) => ({ ...record }))
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  /** The saved path of a finished download, for open and show-in-folder. */
  savedPath(downloadId: string): string | null {
    const entry = this.items.get(downloadId)
    return entry?.record.state === 'completed' && existsSync(entry.record.savePath)
      ? entry.record.savePath
      : null
  }

  cancel(downloadId: string): void {
    this.items.get(downloadId)?.item.cancel()
  }

  pause(downloadId: string): void {
    const entry = this.items.get(downloadId)
    if (entry?.record.state === 'progressing' && !entry.item.isPaused()) {
      entry.item.pause()
      this.update(downloadId)
    }
  }

  resume(downloadId: string): void {
    const entry = this.items.get(downloadId)
    if (entry?.item.canResume()) {
      entry.item.resume()
      this.update(downloadId)
    }
  }

  /** Drop finished rows from the list. Files stay on disk. */
  clearFinished(): void {
    for (const [id, { record }] of this.items) {
      if (record.state === 'progressing') continue
      this.items.delete(id)
      this.release(id)
    }
    this.emit()
  }

  private track(item: DownloadItem): void {
    const downloadId = randomUUID()
    // Like a normal browser: straight to Downloads, never a save dialog, never overwriting.
    const savePath = uniquePath(
      this.directory(),
      item.getFilename(),
      (file) => this.reserved.has(reservationKey(file)) || existsSync(file)
    )
    this.reserved.set(reservationKey(savePath), downloadId)
    item.setSavePath(savePath)
    const record: BrowserDownload = {
      downloadId,
      url: item.getURL(),
      fileName: path.basename(item.getSavePath()),
      savePath: item.getSavePath(),
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      state: 'progressing',
      paused: false,
      startedAt: this.now()
    }
    this.items.set(downloadId, { item, record })
    item.on('updated', () => this.update(downloadId))
    // An interrupted download that can resume keeps its path, and emits done again when it ends.
    item.on('done', (_event, state) => {
      if (state !== 'interrupted' || !item.canResume()) this.release(downloadId)
      this.update(downloadId)
    })
    this.emit()
  }

  private update(downloadId: string): void {
    const entry = this.items.get(downloadId)
    if (!entry) return
    const { item, record } = entry
    record.receivedBytes = item.getReceivedBytes()
    record.totalBytes = item.getTotalBytes()
    record.savePath = item.getSavePath() || record.savePath
    record.fileName = path.basename(record.savePath) || record.fileName
    record.state = item.getState()
    record.paused = item.isPaused()
    this.emit()
  }

  private release(downloadId: string): void {
    for (const [key, owner] of this.reserved) {
      if (owner === downloadId) this.reserved.delete(key)
    }
  }

  private emit(): void {
    this.onChange(this.list())
  }
}

function reservationKey(file: string): string {
  return path.resolve(file).toLowerCase()
}

/** report.pdf, then report (1).pdf, report (2).pdf - the name Chrome would pick. */
export function uniquePath(
  directory: string,
  fileName: string,
  exists: (file: string) => boolean = existsSync
): string {
  const safe = path.basename(fileName).replace(/[\\/:*?"<>|]/g, '_') || 'download'
  const ext = path.extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  let candidate = path.join(directory, safe)
  for (let n = 1; exists(candidate); n += 1) {
    candidate = path.join(directory, `${stem} (${n})${ext}`)
  }
  return candidate
}
