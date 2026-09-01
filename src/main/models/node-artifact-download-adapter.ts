import fs from 'fs'
import path from 'path'
import {
  NonRecoverableDownloadError,
  planResumedTransfer,
  type SequentialDownloadArtifact,
  type SequentialDownloadPorts
} from '@offgrid/models'
import { pumpToFile } from './download-pump'
import { verifyDownloadedPart } from './download-verify'

export interface DesktopDownloadArtifact extends SequentialDownloadArtifact {
  role?: string
}

/** Node/Electron I/O boundary for the shared sequential artifact workflow. */
export function createNodeArtifactDownloadPorts(
  modelsDir: string
): SequentialDownloadPorts<DesktopDownloadArtifact> {
  const destination = (artifact: DesktopDownloadArtifact): string =>
    path.join(modelsDir, artifact.name)
  const partial = (artifact: DesktopDownloadArtifact): string => `${destination(artifact)}.part`

  return {
    isInstalled: async (artifact) => {
      try {
        return fs.statSync(destination(artifact)).size > 0
      } catch {
        return false
      }
    },
    partialBytes: async (artifact) => {
      try {
        return fs.statSync(partial(artifact)).size
      } catch {
        return 0
      }
    },
    transfer: async ({ artifact, resumeFrom, signal, onProgress }) => {
      const response = await fetch(artifact.url, {
        signal,
        headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined
      })
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} for ${artifact.name}`)
      }
      const transfer = planResumedTransfer({
        partialBytes: resumeFrom,
        responseStatus: response.status,
        responseBytes: Number(response.headers.get('content-length') ?? 0)
      })
      let writtenBytes = transfer.writtenBytes
      const output = fs.createWriteStream(partial(artifact), transfer.append ? { flags: 'a' } : {})
      await pumpToFile(response.body.getReader(), output, (bytes) => {
        writtenBytes += bytes
        onProgress(writtenBytes, transfer.totalBytes)
      })
      return { writtenBytes, totalBytes: transfer.totalBytes }
    },
    verifyAndPromote: async (artifact, transfer) => {
      const partPath = partial(artifact)
      const integrityError = await verifyDownloadedPart(
        artifact.name,
        transfer.writtenBytes,
        transfer.totalBytes,
        partPath,
        artifact.sha256
      )
      if (integrityError) throw new NonRecoverableDownloadError(integrityError)
      fs.renameSync(partPath, destination(artifact))
    },
    removePartial: async (artifact) => {
      fs.rmSync(partial(artifact), { force: true })
    }
  }
}
