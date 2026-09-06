import type {
  ModelControlIntent,
  ModelControlOutcome,
  ModelControlProjection,
  ModelsOperationsSnapshot
} from '@offgrid/application'

/** Thin renderer transport. Shared owns projection, ordering, confirmation, and failures. */
export const modelControlClient = {
  projection: (): Promise<ModelControlProjection> => window.api.getModelControlProjection(),
  observe: (listener: (projection: ModelControlProjection) => void): (() => void) =>
    window.api.onModelControlProjection(listener),
  operations: (): Promise<ModelsOperationsSnapshot> => window.api.getModelOperationsProjection(),
  observeOperations: (listener: (projection: ModelsOperationsSnapshot) => void): (() => void) =>
    window.api.onModelOperationsProjection(listener),
  control: (intent: ModelControlIntent): ModelControlOutcome => window.api.controlModel(intent)
}
