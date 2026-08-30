import type { ComputerUseModelStrategy } from '../../../shared/computer-use-settings'
import type { VisionModelAdapter, VisionModelArtifacts } from './types'
import { generalVisionOperatorAdapter } from './general-vision-operator'
import { fara15Adapter } from './fara-1-5'
import { holo31Adapter } from './holo-3-1'
import { uiMateAdapter } from './ui-mate'
import { uiTarsAdapter } from './ui-tars'

// Specialists FIRST, each claiming only the models it can actually parse; the general operator
// last because it is the fallback, not a family. Order is the whole contract here.
const adapters: readonly VisionModelAdapter[] = [
  fara15Adapter,
  holo31Adapter,
  uiMateAdapter,
  uiTarsAdapter,
  generalVisionOperatorAdapter
]

/**
 * The adapter for a run, honouring the user's model strategy.
 *
 * "Same as Chat" means the resident chat model is driving, and a chat model is a general
 * tool-calling VLM — so the general operator is right for it even if a specialist's name pattern
 * happens to match. A user's explicit strategy outranks family matching.
 */
export function resolveVisionModelAdapterForStrategy(
  model: VisionModelArtifacts,
  strategy: Exclude<ComputerUseModelStrategy, 'text_plus_specialist'>
): VisionModelAdapter {
  if (strategy === 'same_as_chat') {
    generalVisionOperatorAdapter.assertCapabilities(model)
    return generalVisionOperatorAdapter
  }
  return resolveVisionModelAdapter(model)
}

/** Model-family selection is owned here; VisionHost has no parser-name branches. */
export function resolveVisionModelAdapter(model: VisionModelArtifacts): VisionModelAdapter {
  // Falls back to the GENERAL operator: an unknown model is far more likely to speak native tool
  // calling than a specialist's text DSL, and guessing UI-TARS made unknown models fail on every
  // step instead of merely performing less well.
  const adapter =
    adapters.find((candidate) => candidate.matches(model)) ?? generalVisionOperatorAdapter
  adapter.assertCapabilities(model)
  return adapter
}

/** Select a model protocol without asserting files that are not resident yet.
 * The hybrid strategy uses this only to plan capture geometry. The loaded-model
 * boundary still calls resolveVisionModelAdapter and enforces capabilities. */
export function matchVisionModelAdapter(model: VisionModelArtifacts): VisionModelAdapter {
  return adapters.find((candidate) => candidate.matches(model)) ?? generalVisionOperatorAdapter
}

/** The model-load boundary only enforces families that declare a strict paired-artifact gate. */
export function loadGatedVisionModelAdapter(
  model: VisionModelArtifacts
): VisionModelAdapter | null {
  return (
    adapters.find(
      (candidate) => candidate.requiresLoadCapabilityGate === true && candidate.matches(model)
    ) ?? null
  )
}
