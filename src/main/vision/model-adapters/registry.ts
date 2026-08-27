import type { VisionModelAdapter, VisionModelArtifacts } from './types'
import { generalVisionOperatorAdapter } from './general-vision-operator'
import { uiMateAdapter } from './ui-mate'
import { uiTarsAdapter } from './ui-tars'

const adapters: readonly VisionModelAdapter[] = [
  uiMateAdapter,
  generalVisionOperatorAdapter,
  uiTarsAdapter
]

/**
 * The adapter for a run, honouring the user's model strategy.
 *
 * "Same as Chat" means the resident chat model is driving, and a chat model is a general
 * tool-calling VLM — so the general operator is right for it whatever it happens to be called.
 * Family matching cannot answer this: the general adapter recognises models by name
 * (gemma-4, qwen3.x), so selecting any OTHER chat model fell through to the ui-tars adapter, which
 * declares `matches: () => true` and is also the fallback. Holo3.1-4B was then driven with the
 * UI-TARS prompt and parser, and since it does not emit that DSL, EVERY step failed with
 * "UI-TARS action did not parse.; re-observing" until the step budget ran out - 32 identical lines
 * and no progress.
 *
 * Strategy is a user decision, so it outranks a guess based on the model's name.
 */
export function resolveVisionModelAdapterForStrategy(
  model: VisionModelArtifacts,
  strategy: 'same_as_chat' | 'separate_specialist'
): VisionModelAdapter {
  if (strategy === 'same_as_chat') {
    generalVisionOperatorAdapter.assertCapabilities(model)
    return generalVisionOperatorAdapter
  }
  return resolveVisionModelAdapter(model)
}

/** Model-family selection is owned here; VisionHost has no parser-name branches. */
export function resolveVisionModelAdapter(model: VisionModelArtifacts): VisionModelAdapter {
  const adapter = adapters.find((candidate) => candidate.matches(model)) ?? uiTarsAdapter
  adapter.assertCapabilities(model)
  return adapter
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
