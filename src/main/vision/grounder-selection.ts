// Which grounding specialist Web Use and Computer Use share: the Tasks choice, else the Computer
// Use pick from the Models screen, else the default. Kept apart from the grounder runtime so the
// model manager can read it without loading the runtime.

import { getActiveModal } from '../active-models'
import { getComputerUseSettings } from '../computer-use-settings'

export const DEFAULT_GROUNDER_MODEL_ID = 'mradermacher/UI-TARS-1.5-7B-GGUF'

export function selectedGrounderModelId(): string {
  return (
    getComputerUseSettings().groundingModelId ??
    getActiveModal('computer_use') ??
    DEFAULT_GROUNDER_MODEL_ID
  )
}
