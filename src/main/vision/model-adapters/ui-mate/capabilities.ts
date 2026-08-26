import path from 'node:path'

/**
 * GGUF artifact source:
 * https://huggingface.co/bartowski/tencent_UI-Mate-9B-GGUF/tree/main
 * https://huggingface.co/bartowski/tencent_UI-Mate-27B-GGUF/tree/main
 * Both sizes use the same official UI-Mate harness and Qwen3.5 vision architecture. Each quant
 * repository states that either projector pairs with every quant of that size.
 */
export const UI_MATE_GGUF_REPOSITORY = 'bartowski/tencent_UI-Mate-9B-GGUF'
export const UI_MATE_27B_GGUF_REPOSITORY = 'bartowski/tencent_UI-Mate-27B-GGUF'
export const UI_MATE_GGUF_REPOSITORIES = [
  UI_MATE_GGUF_REPOSITORY,
  UI_MATE_27B_GGUF_REPOSITORY
] as const

const PRIMARY_PATTERN = /^tencent_UI-Mate-(9B|27B)-(?!calibration|imatrix|mmproj).+\.gguf$/i
const PROJECTOR_PATTERN = /^mmproj-tencent_UI-Mate-(9B|27B)-(?:f16|bf16)\.gguf$/i
const PORTABLE_PACKAGE_PATTERN = /^model-package-v1:[a-f0-9]{64}$/i

export interface UIMateModelArtifacts {
  repositoryId: string
  primaryFile: string
  projectorFile?: string | null
  /** Installed filenames. Both required artifacts must be in this list. */
  availableFiles: readonly string[]
}

export interface ValidatedUIMateModelArtifacts {
  repositoryId: (typeof UI_MATE_GGUF_REPOSITORIES)[number]
  primaryFile: string
  projectorFile: string
}

/** Fail before inference when UI-Mate vision is not fully and correctly installed. */
export function assertUIMateModelCapabilities(
  artifacts: UIMateModelArtifacts
): ValidatedUIMateModelArtifacts {
  const primaryFile = path.basename(artifacts.primaryFile)
  const primarySize = PRIMARY_PATTERN.exec(primaryFile)?.[1]
  if (!primarySize) {
    throw new Error('UI-Mate requires a tencent_UI-Mate 9B or 27B GGUF model file.')
  }
  const expectedRepository =
    primarySize.toLowerCase() === '27b' ? UI_MATE_27B_GGUF_REPOSITORY : UI_MATE_GGUF_REPOSITORY
  const repositoryMatches =
    artifacts.repositoryId.toLowerCase() === expectedRepository.toLowerCase() ||
    PORTABLE_PACKAGE_PATTERN.test(artifacts.repositoryId)
  if (!repositoryMatches) {
    throw new Error(`UI-Mate ${primarySize} requires ${expectedRepository}.`)
  }
  if (!artifacts.projectorFile) {
    throw new Error('UI-Mate requires its matching mmproj vision file.')
  }
  const projectorFile = path.basename(artifacts.projectorFile)
  const projectorSize = PROJECTOR_PATTERN.exec(projectorFile)?.[1]
  if (!projectorSize || projectorSize.toLowerCase() !== primarySize.toLowerCase()) {
    throw new Error(`UI-Mate ${primarySize} requires its matching f16 or bf16 mmproj file.`)
  }
  const installed = new Set(artifacts.availableFiles.map((file) => path.basename(file)))
  if (!installed.has(primaryFile)) throw new Error(`UI-Mate model file is missing: ${primaryFile}`)
  if (!installed.has(projectorFile)) {
    throw new Error(`UI-Mate mmproj file is missing: ${projectorFile}`)
  }
  return {
    repositoryId: expectedRepository,
    primaryFile,
    projectorFile
  }
}
