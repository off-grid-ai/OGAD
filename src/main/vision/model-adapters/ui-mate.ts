import { assertUIMateModelCapabilities, UI_MATE_GGUF_REPOSITORIES } from './ui-mate/capabilities'
import {
  buildCanonicalVisionOperatorRequest,
  parseGeneralVisionOperatorResponse
} from './general-vision-operator'
import type { VisionModelAdapter } from './types'

/** UI-Mate keeps its paired-artifact and image-alignment requirements. Runtime
 * decisions use the same strict single-action contract as every model family. */
export const uiMateAdapter: VisionModelAdapter = {
  id: 'ui-mate',
  screenshotResizeFactor: 32,
  browserCaptureScope: 'page',
  requiresLoadCapabilityGate: true,
  matches(model) {
    return (
      UI_MATE_GGUF_REPOSITORIES.some(
        (repository) => model.id.toLowerCase() === repository.toLowerCase()
      ) || /^tencent_UI-Mate-(?:9B|27B)-/i.test(model.primaryFile)
    )
  },
  assertCapabilities(model) {
    assertUIMateModelCapabilities({
      repositoryId: model.id,
      primaryFile: model.primaryFile,
      projectorFile: model.projectorFile,
      availableFiles: model.availableFiles
    })
  },
  buildRequest: buildCanonicalVisionOperatorRequest,
  parseResponse: parseGeneralVisionOperatorResponse
}
