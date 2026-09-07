import { isGrounderModel } from '@offgrid/models'

export interface ActiveModel {
  id: string
  vision: boolean
}

/** Whether the loaded model is already a usable grounder (a vision model with the
 *  grounder flag). The grounder swap skips the model reload when this is true. */
export function isGrounderActive(model: ActiveModel | null): boolean {
  return model !== null && model.vision && isGrounderModel(model.id)
}
