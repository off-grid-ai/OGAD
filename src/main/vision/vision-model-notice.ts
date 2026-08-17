/**
 * The vision rail is model-agnostic - it will run on whatever model is loaded -
 * but it grounds clicks far better on a GUI-grounding model (UI-TARS and kin).
 * So when a computer-use task runs on a model that is not a grounder, we WARN
 * rather than block: the task still runs, the user just sees why it may misfire
 * and what to load instead.
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
  if (!isGrounderModel(model.id)) {
    return `The current model can see the screen but is not a grounding model, so computer use may click the wrong place. ${RECOMMEND}`
  }
  return null
}

/**
 * The grounder nudge to show for a QUEUED computer_task, given the model and
 * whether the accessibility rail can drive this task. AX-first tiering means a
 * task an AX-rich app can drive needs NO grounder - so we must NOT nudge for one
 * there, or we would contradict the feature on exactly the case it is built for.
 * The warning is only honest when the task will actually fall to the vision rail.
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
