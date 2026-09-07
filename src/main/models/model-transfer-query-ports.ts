import fs from 'node:fs'
import path from 'node:path'
import {
  CATALOG,
  type ArtifactVerificationFilePort,
  type TransferableModelQueryPorts
} from '@offgrid/models'
import { desktopDownloadedRegistryPorts } from '../downloaded-models'
import { llm } from '../llm'
import { LocalModelRegistry } from './local-model-registry'

function isMissing(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** Artifact names must stay within the library captured for this query. */
function artifactPath(directory: string, name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || name.includes('\0')) {
    throw new Error('The model artifact name is not a library file name.')
  }
  return path.join(directory, name)
}

/** File facts only. Shared decides whether the bytes form a transferable artifact. */
function verificationFiles(directory: string): ArtifactVerificationFilePort {
  const confined = (candidate: string): string => {
    if (path.dirname(candidate) !== directory) {
      throw new Error('The model artifact is outside the active model library.')
    }
    return artifactPath(directory, path.basename(candidate))
  }
  return {
    async stat(candidate) {
      try {
        const entry = await fs.promises.lstat(confined(candidate))
        return {
          exists: true,
          isFile: entry.isFile() && !entry.isSymbolicLink(),
          sizeBytes: entry.size
        }
      } catch (cause) {
        if (isMissing(cause)) return { exists: false, isFile: false, sizeBytes: 0 }
        throw cause
      }
    },
    async readPrefix(candidate, bytes) {
      const handle = await fs.promises.open(
        confined(candidate),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      )
      try {
        const buffer = Buffer.alloc(bytes)
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
        return Uint8Array.from(buffer.subarray(0, bytesRead))
      } finally {
        await handle.close()
      }
    },
    async remove() {
      throw new Error('A model transfer query cannot remove library files.')
    }
  }
}

/** Capture one library root per query; no async step can switch to a different library. */
export function createDesktopModelTransferQueryPorts(
  modelsDir: () => string = () => llm.getModelsDir()
): TransferableModelQueryPorts {
  return {
    snapshot() {
      const directory = path.resolve(modelsDir())
      const registry = desktopDownloadedRegistryPorts(directory)
      return {
        locals: new LocalModelRegistry(directory).read(),
        catalog: CATALOG,
        downloadedRegistry: {
          ...registry,
          fileSize(name) {
            try {
              const entry = fs.lstatSync(artifactPath(directory, name))
              return entry.isFile() && !entry.isSymbolicLink() ? entry.size : 0
            } catch (cause) {
              if (isMissing(cause)) return 0
              throw cause
            }
          }
        },
        files: verificationFiles(directory),
        pathFor: (name) => artifactPath(directory, name)
      }
    }
  }
}
