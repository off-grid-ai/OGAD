// Composition root: the shared artifact verifier over Desktop's node fs (and sha256 when a
// download supplies one).
import type fs from 'fs'
import { ArtifactVerificationService, type ArtifactVerificationFilePort } from '@offgrid/models'

let desktopFiles: ((nativeFs: typeof fs) => ArtifactVerificationFilePort) | null = null

export function registerDesktopArtifactVerificationFiles(
  files: (nativeFs: typeof fs) => ArtifactVerificationFilePort
): void {
  if (desktopFiles) throw new Error('Desktop artifact-verification files are already registered.')
  desktopFiles = files
}

export function artifactVerification(
  nativeFs: typeof fs,
  sha256?: (path: string) => Promise<string>
): ArtifactVerificationService {
  if (!desktopFiles) throw new Error('Desktop artifact-verification files are not registered.')
  return new ArtifactVerificationService({
    ...desktopFiles(nativeFs),
    ...(sha256 ? { sha256 } : {})
  })
}
