import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import {
  DownloadAbortedError,
  NonRecoverableDownloadError,
  planResumedTransfer,
  type DownloadFilePort,
  type DownloadTransferPort,
  type DownloadTransferStopDisposition
} from '@offgrid/models'
import { pumpToFile } from './download-pump'
import { verifyDownloadedPart } from './download-verify'

export interface DesktopModelDownloadPorts {
  files: DownloadFilePort
  transfers: DownloadTransferPort
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/**
 * A native abort identifies ITSELF: `fetch` and the response body reader both reject with an
 * `AbortError` when the signal fires. Classifying on that name - and never on `signal.aborted` -
 * is the whole point of the frozen contract. The signal only says a stop was REQUESTED; the
 * error's name says the transport actually stopped for it.
 *
 * That distinction is not academic here. This transfer does more than move bytes: after the
 * abortable part it verifies integrity and promotes the file into place. Asking the signal
 * reported every one of those outcomes - a corrupt artifact our own verifier caught, a failed
 * rename - as the person's own cancellation whenever a cancel happened to be in flight.
 *
 * A write fault (ENOSPC, EIO) is not named `AbortError`, so it stays the fault it is.
 */
function isNativeAbort(error: unknown): boolean {
  return (error as { name?: string } | undefined)?.name === 'AbortError'
}

/**
 * The transfer port's two reporting rules, in one place so both abortable steps obey the same
 * one: a stop is reported ONLY as `DownloadAbortedError`, and every other rejection is passed
 * through UNCHANGED so its `code` still reaches the downstream classifier. It always throws.
 */
function reportTransferRejection(error: unknown): never {
  if (isNativeAbort(error)) throw new DownloadAbortedError()
  throw error
}

async function sha256(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = fs.createReadStream(filePath)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

/** How many reported-but-unconsumed completions the transfer port remembers; see `stop()`. */
const COMPLETED_TRANSFER_MEMORY = 64

/** Raw Node filesystem and HTTP adapters for Shared's authoritative coordinator. */
export function createNodeModelDownloadPorts(
  modelsDir: string,
  expectedSha256For?: (destination: string) => string | undefined
): DesktopModelDownloadPorts {
  // Active transfers, keyed by id, carrying the retention policy an explicit `stop()` chose for
  // them. The coordinator calls `stop()` BEFORE it aborts the signal, so a `delete-partial` stop
  // cannot remove the `.part` on the spot - the write stream is still open on it. The policy is
  // recorded here and applied once the transfer actually settles with a rejection.
  const activeTransfers = new Map<string, DownloadTransferStopDisposition | undefined>()
  // Completed transfer ids exist for ONE reason: a `stop()` that races a completion must answer
  // `completed`, never `not-found`. That race closes within moments of the completion, so the
  // memory is bounded: an id is forgotten when a `stop()` consumes it, and the oldest ids are
  // evicted once more than COMPLETED_TRANSFER_MEMORY completions have been reported without a
  // matching stop. A long session therefore holds at most that many ids, not one per download.
  const completedTransfers = new Set<string>()
  const removePartial = async (filePath: string): Promise<void> => {
    await fs.promises.rm(`${filePath}.part`, { force: true })
  }
  const rememberCompleted = (id: string): void => {
    completedTransfers.add(id)
    for (const oldest of completedTransfers) {
      if (completedTransfers.size <= COMPLETED_TRANSFER_MEMORY) break
      completedTransfers.delete(oldest)
    }
  }
  return {
    files: {
      pathFor: (localName) => path.join(modelsDir, localName),
      exists: async (filePath) => {
        try {
          return (await fs.promises.stat(filePath)).isFile()
        } catch (error) {
          if (isMissing(error)) return false
          throw error
        }
      },
      size: async (filePath) => {
        try {
          return (await fs.promises.stat(filePath)).size
        } catch (error) {
          if (isMissing(error)) return 0
          throw error
        }
      },
      partialSize: async (filePath) => {
        try {
          return (await fs.promises.stat(`${filePath}.part`)).size
        } catch (error) {
          if (isMissing(error)) return 0
          throw error
        }
      },
      readPrefix: async (filePath, bytes) => {
        const handle = await fs.promises.open(filePath, 'r')
        try {
          const buffer = Buffer.alloc(bytes)
          const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
          return buffer.subarray(0, bytesRead)
        } finally {
          await handle.close()
        }
      },
      sha256,
      removePartial,
      remove: async (filePath) => {
        await Promise.all([
          fs.promises.rm(filePath, { force: true }),
          fs.promises.rm(`${filePath}.part`, { force: true })
        ])
      }
    },
    transfers: {
      start(input) {
        activeTransfers.set(input.id, undefined)
        return (async () => {
          const partPath = `${input.destination}.part`
          await fs.promises.mkdir(path.dirname(partPath), { recursive: true })
          let partialBytes = 0
          try {
            partialBytes = (await fs.promises.stat(partPath)).size
          } catch (error) {
            if (!isMissing(error)) throw error
          }
          const resumeFrom = input.resume ? partialBytes : 0
          let response: Response
          try {
            response = await fetch(input.url, {
              signal: input.signal,
              headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined
            })
          } catch (error) {
            // This used to rethrow `new Error(modelDownloadFailureMessage(error))`, which flattened
            // the cause: it erased the `name` that identified an abort - the reason the lane had to
            // guess from the signal at all - and dropped the `code` that classifies ENOSPC and
            // network conditions. The coordinator still renders one stable message from it.
            reportTransferRejection(error)
          }
          if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status} for ${path.basename(input.destination)}`)
          }
          const transfer = planResumedTransfer({
            partialBytes: resumeFrom,
            responseStatus: response.status,
            responseBytes: Number(response.headers.get('content-length') ?? 0)
          })
          input.onStarted?.(input.id)
          let writtenBytes = transfer.writtenBytes
          const output = fs.createWriteStream(partPath, transfer.append ? { flags: 'a' } : {})
          try {
            await pumpToFile(response.body.getReader(), output, (bytes) => {
              writtenBytes += bytes
              input.onProgress({ bytesDownloaded: writtenBytes, totalBytes: transfer.totalBytes })
            })
          } catch (error) {
            // The abort that matters in practice arrives HERE, not at the header fetch: a person
            // cancels while bytes are moving, and the body reader rejects with `AbortError`. Left
            // unclassified it reached the lane as an ordinary fault, so a real cancel of an active
            // download reported `failed`. A write fault keeps its own error and its `code`.
            reportTransferRejection(error)
          }
          const integrityError = await verifyDownloadedPart({
            name: path.basename(input.destination),
            writtenBytes,
            responseTotalBytes: transfer.totalBytes,
            partPath,
            expectedBytes: input.expectedBytes,
            expectedSha256: expectedSha256For?.(input.destination)
          })
          if (integrityError) throw new NonRecoverableDownloadError(integrityError)
          await fs.promises.rename(partPath, input.destination)
          return { transferId: input.id }
        })().then(
          (result) => {
            // A completion that won the race against a stop keeps its promoted file whatever the
            // stop asked for; there is no `.part` left to retain or discard after the rename.
            activeTransfers.delete(input.id)
            rememberCompleted(input.id)
            return result
          },
          async (error) => {
            // `pumpToFile` has already ended and flushed the write stream by the time a rejection
            // reaches here, so removing the `.part` now cannot race a late write.
            const disposition = activeTransfers.get(input.id)
            activeTransfers.delete(input.id)
            if (disposition === 'delete-partial') await removePartial(input.destination)
            throw error
          }
        )
      },
      async stop(input) {
        if (activeTransfers.has(input.transferId)) {
          activeTransfers.set(input.transferId, input.disposition)
          return { outcome: 'stopped' }
        }
        if (completedTransfers.delete(input.transferId)) return { outcome: 'completed' }
        return { outcome: 'not-found' }
      }
    }
  }
}
