import type fs from 'node:fs'
import type { ArtifactVerificationFilePort } from '@offgrid/models'

/** Node filesystem adapter. Shared owns every artifact-validity decision. */
export function desktopArtifactVerificationFiles(
  nativeFs: typeof fs
): ArtifactVerificationFilePort {
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
