import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import {
  NonRecoverableDownloadError,
  modelDownloadFailureMessage,
  planResumedTransfer,
  type DownloadFilePort,
  type DownloadTransferPort
} from '@offgrid/models'
import { pumpToFile } from './download-pump'
import { verifyDownloadedPart } from './download-verify'

export interface DesktopModelDownloadPorts {
  files: DownloadFilePort
  transfers: DownloadTransferPort
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

/** Raw Node filesystem and HTTP adapters for Shared's authoritative coordinator. */
export function createNodeModelDownloadPorts(
  modelsDir: string,
  expectedSha256For?: (destination: string) => string | undefined
): DesktopModelDownloadPorts {
  return {
    files: {
      pathFor: (localName) => path.join(modelsDir, localName),
      exists: async (filePath) => {
        try {
          return fs.statSync(filePath).isFile()
        } catch {
          return false
        }
      },
      size: async (filePath) => {
        try {
          return fs.statSync(filePath).size
        } catch {
          return 0
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
      remove: async (filePath) => {
        await Promise.all([
          fs.promises.rm(filePath, { force: true }),
          fs.promises.rm(`${filePath}.part`, { force: true })
        ])
      }
    },
    transfers: {
      async start(input) {
        const partPath = `${input.destination}.part`
        let partialBytes = 0
        try {
          partialBytes = fs.statSync(partPath).size
        } catch {
          /* new transfer */
        }
        const resumeFrom = input.resume ? partialBytes : 0
        let response: Response
        try {
          response = await fetch(input.url, {
            signal: input.signal,
            headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined
          })
        } catch (error) {
          // Translate native transport errors at the adapter boundary. The
          // coordinator and both renderers receive one stable domain message.
          throw new Error(modelDownloadFailureMessage(error))
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
        await pumpToFile(response.body.getReader(), output, (bytes) => {
          writtenBytes += bytes
          input.onProgress({ bytesDownloaded: writtenBytes, totalBytes: transfer.totalBytes })
        })
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
      },
      async cancel() {
        // The coordinator aborts the owning signal. fetch and pump observe that signal.
      }
    }
  }
}
