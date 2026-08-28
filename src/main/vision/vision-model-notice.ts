/**
 * The vision rail runs with any compatible vision model. A generic vision model
 * is therefore a valid product path and must not produce a specialist-model
 * recommendation. Missing and non-vision models still need a blocking notice.
 *
 * Pure: it takes the active model info (id + whether it can see images) and the
 * grounder check, and returns the notice string or null. The host reads the
 * model from the LLM service and shows the notice on the supervisor overlay.
 */
import { isGrounderModel } from '@offgrid/models'

export interface ActiveModel {
  id: string
  vision: boolean
}

const RECOMMEND =
  'Load a grounding model like UI-TARS 1.5 7B from the Models screen for reliable results.'

export function visionModelNotice(model: ActiveModel | null): string | null {
  if (!model) {
    return `No model is loaded for computer use. ${RECOMMEND}`
  }
  if (!model.vision) {
    return `The current model cannot read the screen, so computer use will not work. ${RECOMMEND}`
  }
  return null
}

/**
 * The compatibility notice to show for a queued computer task. AX-first work
 * does not need a vision model. A task that falls to vision only needs a notice
 * when no usable vision model is loaded.
 *
 * Pure: the host passes the model + the AX-viability it already computed; this
 * returns the notice string or null.
 */
export function grounderNudgeForQueuedTask(
  model: ActiveModel | null,
  axRailWillDrive: boolean
): string | null {
  if (axRailWillDrive) {
    return null
  }
  return visionModelNotice(model)
}

/** Whether the loaded model is already a usable grounder (a vision model with the
 *  grounder flag). The grounder swap skips the model reload when this is true. */
export function isGrounderActive(model: ActiveModel | null): boolean {
  return model !== null && model.vision && isGrounderModel(model.id)
}
