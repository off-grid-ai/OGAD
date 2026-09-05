// Composition root: the shared artifact verifier over Desktop's node fs (and sha256 when a
// download supplies one).
import type fs from 'fs'
import { ArtifactVerificationService } from '@offgrid/models'
import { desktopArtifactVerificationFiles } from '../models/artifact-verification-files'

export function artifactVerification(
  nativeFs: typeof fs,
  sha256?: (path: string) => Promise<string>
): ArtifactVerificationService {
  return new ArtifactVerificationService({
    ...desktopArtifactVerificationFiles(nativeFs),
    ...(sha256 ? { sha256 } : {})
  })
}
