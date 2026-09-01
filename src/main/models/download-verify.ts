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
import {
  ArtifactVerificationService,
  artifactVerificationError,
  type ArtifactVerificationRequest
} from '@offgrid/models'
import { desktopArtifactVerificationFiles } from './gguf'

/** Reason a just-downloaded file must NOT be promoted to installed, or null if it
 *  passes. Checks the byte count (when the server reported a length) and, for a
 *  GGUF, the magic header + minimum size. */
export async function verifyDownloadedPart(
  name: string,
  written: number,
  total: number,
  partPath: string,
  expectedSha256?: string
): Promise<string | null> {
  const request: ArtifactVerificationRequest = {
    path: partPath,
    name,
    origin: 'download',
    writtenBytes: written,
    responseTotalBytes: total,
    expectedSha256,
    removeInvalid: true
  }
  const service = new ArtifactVerificationService({
    ...desktopArtifactVerificationFiles(fs),
    sha256: sha256File
  })
  const result = await service.verify(request)
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
