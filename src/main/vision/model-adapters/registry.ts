import type { VisionModelAdapter, VisionModelArtifacts } from './types'
import { uiMateAdapter } from './ui-mate'
import { uiTarsAdapter } from './ui-tars'

const adapters: readonly VisionModelAdapter[] = [uiMateAdapter, uiTarsAdapter]

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
