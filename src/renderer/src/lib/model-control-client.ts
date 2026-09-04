import type {
  ModelControlIntent,
  ModelControlOutcome,
  ModelControlProjection
} from '@offgrid/application'

/** Thin renderer transport. Shared owns projection, ordering, confirmation, and failures. */
export const modelControlClient = {
  projection: (): Promise<ModelControlProjection> => window.api.getModelControlProjection(),
  control: (intent: ModelControlIntent): ModelControlOutcome => window.api.controlModel(intent)
}
