// Integrity gate run before a finished download is promoted from `<file>.part` to
// its final name (and recorded as installed). Isolated + testable so the check that
// keeps a broken model off disk isn't buried in the download I/O.
//
// D2: the download loop renamed .part -> final with NO verification. A server that
// closed the connection early (flaky CDN / HF mirror), or any short read, left a
// TRUNCATED file that was marked installed + activatable — then llama-server died
// on load with a blank "Chat model Down" (the exact class CLAUDE.md warns about).
import fs from 'fs'
import crypto from 'crypto'
import { artifactVerificationError, type ArtifactVerificationRequest } from '@offgrid/models'
import { artifactVerification } from '../composition/artifact-verification'

/** Reason a just-downloaded file must NOT be promoted to installed, or null if it
 *  passes. Checks the byte count (when the server reported a length) and, for a
 *  GGUF, the magic header + minimum size. */
export interface DownloadedPartVerificationInput {
  name: string
  writtenBytes: number
  responseTotalBytes: number
  partPath: string
  expectedSha256?: string
  expectedBytes?: number
}

export async function verifyDownloadedPart(
  input: DownloadedPartVerificationInput
): Promise<string | null> {
  const request: ArtifactVerificationRequest = {
    path: input.partPath,
    name: input.name,
    origin: 'download',
    writtenBytes: input.writtenBytes,
    responseTotalBytes: input.responseTotalBytes,
    expectedSha256: input.expectedSha256,
    expectedBytes: input.expectedBytes,
    // Only an interrupted stream is safe to resume. A completed file with the
    // wrong manifest size, checksum, or format must restart from byte zero.
    resumeSupported: true,
    removeInvalid: true
  }
  const result = await artifactVerification(fs, sha256File).verify(request)
  return result.valid ? null : artifactVerificationError(request, result)
}

/** Stream a file through SHA-256 and return the lowercase hex digest. */
export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** Content-integrity check: when an expected SHA-256 is known (e.g. HuggingFace's
 *  lfs oid), verify the downloaded bytes match it — catches silent corruption a
 *  byte-count + magic-header check can't (a mirror serving the right length of the
 *  wrong/garbled bytes). Returns null when no hash is known (skip) or it matches;
 *  an error string on mismatch. Case-insensitive compare. */
