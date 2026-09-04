/**
 * The one owner of diagnostic log I/O.
 *
 * Every IPC request used to be written to disk with a synchronous stat, mkdir, append and chmod,
 * on the Electron main thread, twice per request (started and completed) plus once per captured
 * console call. At a few hundred requests a second that is the main thread doing file I/O instead
 * of serving the renderer, and it shows up as input lag.
 *
 * So appending is now non-blocking and never throws: a caller hands over a line and returns. This
 * owner keeps exactly one write in flight and one coalesced pending batch behind it, holds the log
 * open instead of re-checking it per line, and is hard-bounded in records and bytes. When it
 * overflows it drops the OLDEST lines, counts them, and says so in the log itself. Write failures
 * are reported straight to the process stream — never back through this writer, which would be a
 * loop.
 */
import fs from 'node:fs'
import path from 'node:path'

export type DiagnosticWriterStats = Readonly<{
  /** Lines accepted but not yet written. */
  bufferedRecords: number
  bufferedBytes: number
  /** Lines this writer discarded to stay inside its bounds, for the life of the process. */
  droppedRecords: number
  /** Batches that failed to reach disk, for the life of the process. */
  writeFailures: number
}>

export interface DiagnosticWriter {
  /** Accept one already-formatted line (without its newline). Never throws, never blocks. */
  append(line: string): void
  /** Wait for everything accepted so far to reach disk, giving up after `timeoutMs`. */
  flush(timeoutMs?: number): Promise<void>
  /** Flush, then release the file handle. Idempotent. */
  close(): Promise<void>
  stats(): DiagnosticWriterStats
}

export type DiagnosticWriterOptions = Readonly<{
  /** Resolved per batch so a changed log destination is picked up without a restart. */
  resolvePath: () => string
  /** Rotate to `<path>.previous` once the live file reaches this size. */
  maxLogBytes: number
  maxBufferedRecords: number
  maxBufferedBytes: number
  /** Where a write failure is reported. MUST NOT route back into this writer. */
  reportFailure: (message: string) => void
}>

const DEFAULT_FLUSH_TIMEOUT_MS = 2_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createDiagnosticWriter(options: DiagnosticWriterOptions): DiagnosticWriter {
  let pending: string[] = []
  let pendingBytes = 0
  let droppedRecords = 0
  let droppedSinceNotice = 0
  let writeFailures = 0
  let active: Promise<void> | null = null
  let closed = false

  let handle: fs.promises.FileHandle | null = null
  let handlePath: string | null = null
  let handleBytes = 0

  const dropOldest = (): void => {
    while (
      pending.length > options.maxBufferedRecords ||
      (pendingBytes > options.maxBufferedBytes && pending.length > 1)
    ) {
      const [oldest] = pending.splice(0, 1)
      pendingBytes -= Buffer.byteLength(oldest, 'utf8')
      droppedRecords += 1
      droppedSinceNotice += 1
    }
  }

  const releaseHandle = async (): Promise<void> => {
    const open = handle
    handle = null
    handlePath = null
    handleBytes = 0
    if (!open) return
    try {
      await open.close()
    } catch (error) {
      options.reportFailure(`close failed: ${errorMessage(error)}`)
    }
  }

  const openFor = async (logPath: string): Promise<fs.promises.FileHandle> => {
    if (handle && handlePath === logPath) return handle
    await releaseHandle()
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true })
    // 0o600 applies at creation, which is why the old per-line chmod is gone: the file this
    // writer creates is private from the moment it exists.
    const opened = await fs.promises.open(logPath, 'a', 0o600)
    handle = opened
    handlePath = logPath
    handleBytes = (await opened.stat()).size
    return opened
  }

  const rotateIfNeeded = async (logPath: string): Promise<void> => {
    if (handleBytes < options.maxLogBytes) return
    await releaseHandle()
    const previous = `${logPath}.previous`
    await fs.promises.rm(previous, { force: true })
    await fs.promises.rename(logPath, previous)
  }

  const writeBatch = async (text: string): Promise<void> => {
    const logPath = options.resolvePath()
    await openFor(logPath)
    await rotateIfNeeded(logPath)
    const open = await openFor(logPath)
    await open.write(text, null, 'utf8')
    handleBytes += Buffer.byteLength(text, 'utf8')
  }

  const drain = async (): Promise<void> => {
    while (pending.length > 0) {
      const notice =
        droppedSinceNotice > 0
          ? `${new Date().toISOString()} WARN [diagnostics] records.dropped count=${droppedSinceNotice} totalDropped=${droppedRecords}\n`
          : ''
      droppedSinceNotice = 0
      const batch = notice + pending.join('')
      pending = []
      pendingBytes = 0
      try {
        await writeBatch(batch)
      } catch (error) {
        // The batch is already out of the buffer, which is what keeps a failing disk from
        // growing this writer without bound. Reported, counted, and the handle is dropped so the
        // next batch retries from a fresh open.
        writeFailures += 1
        options.reportFailure(`write failed: ${errorMessage(error)}`)
        await releaseHandle()
      }
    }
  }

  const schedule = (): void => {
    if (active || pending.length === 0) return
    active = drain().finally(() => {
      active = null
      if (pending.length > 0) schedule()
    })
  }

  const settle = async (timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while ((active || pending.length > 0) && Date.now() < deadline) {
      schedule()
      if (!active) break
      await active
    }
    if (active || pending.length > 0) {
      options.reportFailure(
        `flush timed out after ${timeoutMs}ms with ${pending.length} record(s) unwritten`
      )
    }
  }

  return {
    append(line: string): void {
      if (closed) return
      const record = `${line}\n`
      pending.push(record)
      pendingBytes += Buffer.byteLength(record, 'utf8')
      dropOldest()
      schedule()
    },
    flush(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
      return settle(timeoutMs)
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await settle(DEFAULT_FLUSH_TIMEOUT_MS)
      await releaseHandle()
    },
    stats(): DiagnosticWriterStats {
      return {
        bufferedRecords: pending.length,
        bufferedBytes: pendingBytes,
        droppedRecords,
        writeFailures
      }
    }
  }
}
