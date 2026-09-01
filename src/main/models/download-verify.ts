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
import { downloadedArtifactChecksumError, transferredArtifactIntegrityError } from '@offgrid/models'

/** Reason a just-downloaded file must NOT be promoted to installed, or null if it
 *  passes. Checks the byte count (when the server reported a length) and, for a
 *  GGUF, the magic header + minimum size. */
export function downloadIntegrityError(
  name: string,
  written: number,
  total: number,
  partPath: string
): string | null {
  let storedBytes = 0
  let firstFourBytes: Uint8Array | undefined
  try {
    storedBytes = fs.statSync(partPath).size
    if (/\.gguf$/i.test(name)) {
      const fd = fs.openSync(partPath, 'r')
      const prefix = Buffer.alloc(4)
      try {
        fs.readSync(fd, prefix, 0, 4, 0)
      } finally {
        fs.closeSync(fd)
      }
      firstFourBytes = prefix
    }
  } catch {
    // The shared policy reports a missing/truncated artifact from these empty probes.
  }
  return transferredArtifactIntegrityError({
    name,
    writtenBytes: written,
    responseTotalBytes: total,
    storedBytes,
    firstFourBytes
  })
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
export async function sha256IntegrityError(
  name: string,
  partPath: string,
  expectedSha256: string | undefined
): Promise<string | null> {
  if (!expectedSha256) return null
  let actual: string
  try {
    actual = await sha256File(partPath)
  } catch (e) {
    return downloadedArtifactChecksumError({
      name,
      expectedSha256,
      readError: (e as Error).message
    })
  }
  return downloadedArtifactChecksumError({ name, expectedSha256, actualSha256: actual })
}
