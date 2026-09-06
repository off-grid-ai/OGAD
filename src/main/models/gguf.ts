import type fs from 'fs'
import path from 'path'
import type { ArtifactOrigin, ArtifactVerification } from '@offgrid/models'
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
