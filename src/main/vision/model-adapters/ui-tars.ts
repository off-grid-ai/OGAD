import type { VisionModelAdapter, VisionPolicyDecision } from './types'
import {
  buildCanonicalVisionOperatorRequest,
  parseGeneralVisionOperatorResponse
} from './general-vision-operator'

/** UI-TARS keeps its model-family capability gate, but uses the same canonical
 * judge/action decision contract as every other selectable vision model. */
export function parseUiTarsPolicyResponse(
  response: string,
  bounds: Parameters<VisionModelAdapter['parseResponse']>[1],
  coordinateFrame?: Parameters<VisionModelAdapter['parseResponse']>[2]
): VisionPolicyDecision {
  return parseGeneralVisionOperatorResponse(response, bounds, coordinateFrame)
}

export const uiTarsAdapter: VisionModelAdapter = {
  id: 'ui-tars',
  matches: () => true,
  assertCapabilities(model) {
    if (!model.projectorFile || !model.availableFiles.includes(model.projectorFile)) {
      throw new Error('The active computer-use model has no installed vision projector.')
    }
  },
  buildRequest: buildCanonicalVisionOperatorRequest,
  parseResponse: parseUiTarsPolicyResponse
}
