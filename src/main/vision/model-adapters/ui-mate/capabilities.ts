import path from 'node:path'

/**
 * GGUF artifact source:
 * https://huggingface.co/bartowski/tencent_UI-Mate-9B-GGUF/tree/main
 * The repository states that either listed projector pairs with every quant.
 */
export const UI_MATE_GGUF_REPOSITORY = 'bartowski/tencent_UI-Mate-9B-GGUF'

const PRIMARY_PATTERN = /^tencent_UI-Mate-9B-(?!calibration|imatrix|mmproj).+\.gguf$/i
const PROJECTOR_PATTERN = /^mmproj-tencent_UI-Mate-9B-(?:f16|bf16)\.gguf$/i

export interface UIMateModelArtifacts {
  repositoryId: string
  primaryFile: string
  projectorFile?: string | null
  /** Installed filenames. Both required artifacts must be in this list. */
  availableFiles: readonly string[]
}

export interface ValidatedUIMateModelArtifacts {
  repositoryId: typeof UI_MATE_GGUF_REPOSITORY
  primaryFile: string
  projectorFile: string
}

/** Fail before inference when UI-Mate vision is not fully and correctly installed. */
export function assertUIMateModelCapabilities(
  artifacts: UIMateModelArtifacts
): ValidatedUIMateModelArtifacts {
  if (artifacts.repositoryId.toLowerCase() !== UI_MATE_GGUF_REPOSITORY.toLowerCase()) {
    throw new Error(`UI-Mate requires ${UI_MATE_GGUF_REPOSITORY}.`)
  }
  const primaryFile = path.basename(artifacts.primaryFile)
  if (!PRIMARY_PATTERN.test(primaryFile)) {
    throw new Error('UI-Mate requires a tencent_UI-Mate-9B GGUF model file.')
  }
  if (!artifacts.projectorFile) {
    throw new Error('UI-Mate requires its matching mmproj vision file.')
  }
  const projectorFile = path.basename(artifacts.projectorFile)
  if (!PROJECTOR_PATTERN.test(projectorFile)) {
    throw new Error('UI-Mate requires an f16 or bf16 tencent_UI-Mate-9B mmproj file.')
  }
  const installed = new Set(artifacts.availableFiles.map((file) => path.basename(file)))
  if (!installed.has(primaryFile)) throw new Error(`UI-Mate model file is missing: ${primaryFile}`)
  if (!installed.has(projectorFile)) {
    throw new Error(`UI-Mate mmproj file is missing: ${projectorFile}`)
  }
  return {
    repositoryId: UI_MATE_GGUF_REPOSITORY,
    primaryFile,
    projectorFile
  }
}
