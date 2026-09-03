import type fs from 'fs'
import path from 'path'
import type {
  ArtifactOrigin,
  ArtifactVerification,
  ArtifactVerificationFilePort
} from '@offgrid/models'
import { artifactVerification } from '../composition/artifact-verification'

/** The subset of `fs` this check needs — injected so the read path is testable
 *  against a real temp file (or a fake) without importing node fs into callers'
 *  test setups. */
export interface GgufFs {
  statSync(p: string): { size: number }
  openSync(p: string, flags: string): number
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number
  closeSync(fd: number): void
}

/** Node filesystem adapter. It contains no artifact-validity decisions. */
export function desktopArtifactVerificationFiles(nativeFs: typeof fs): ArtifactVerificationFilePort {
  return {
    async stat(candidate) {
      try {
        const value = nativeFs.lstatSync(candidate)
        return {
          exists: true,
          isFile: value.isFile() && !value.isSymbolicLink(),
          sizeBytes: value.size
        }
      } catch {
        return { exists: false, isFile: false, sizeBytes: 0 }
      }
    },
    async readPrefix(candidate, bytes) {
      const handle = nativeFs.openSync(candidate, 'r')
      const prefix = Buffer.alloc(bytes)
      try {
        const read = nativeFs.readSync(handle, prefix, 0, bytes, 0)
        return Uint8Array.from(prefix.subarray(0, read))
      } finally {
        nativeFs.closeSync(handle)
      }
    },
    async remove(candidate) {
      nativeFs.rmSync(candidate, { force: true })
    }
  }
}

export function verifyArtifactFile(
  candidate: string,
  nativeFs: typeof fs,
  origin: ArtifactOrigin,
  removeInvalid = false,
  expectedBytes?: number
): Promise<ArtifactVerification> {
  return artifactVerification(nativeFs).verify({
    path: candidate,
    name: path.basename(candidate),
    origin,
    removeInvalid,
    expectedBytes
  })
}
