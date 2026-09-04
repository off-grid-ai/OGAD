interface ActiveModels {
  text: string | null
  image: string | null
  speech: string | null
  transcription: string | null
  computer_use: string | null
}

interface BoundaryOptions {
  /**
   * Keep a download intent in flight instead of settling it, which is the real state of a queued
   * download that has not been given any bytes yet. `settleDownloads` releases them.
   */
  holdDownloads?: boolean
}

interface SnapshotInput<Model> {
  kinds: readonly string[]
  models: readonly Model[]
  installed?: readonly string[]
  activeIds?: readonly string[]
  active?: Partial<ActiveModels>
  computerUse?: unknown
}

interface ModelControlSnapshot<Model> {
  kinds: readonly string[]
  models: readonly Model[]
  installed: readonly string[]
  activeIds: readonly string[]
  active: Record<keyof ActiveModels, { modelId: string | null; routeId: string | null; ready: boolean }>
  downloads: readonly unknown[]
  downloadDurability: { status: 'healthy' }
  /**
   * The Computer Use strategy the picker renders. Carried through from the input: it used to be
   * accepted and then dropped, which rendered every Computer Use region as "No Computer Use model
   * is selected" no matter what a fixture supplied.
   */
  computerUse: unknown
}

/** Canonical renderer boundary fixture for the single model-control read contract. */
export function modelControlSnapshot<Model>(
  input: SnapshotInput<Model>
): ModelControlSnapshot<Model> {
  return {
    kinds: input.kinds,
    models: input.models.map((model) => {
      const row = model as Model & { files?: readonly unknown[]; artifacts?: readonly unknown[] }
      return { ...row, artifacts: row.artifacts ?? row.files ?? [] }
    }),
    installed: input.installed ?? [],
    activeIds: input.activeIds ?? [],
    active: {
      text: activeEntry(input.active?.text ?? null),
      image: activeEntry(input.active?.image ?? null),
      speech: activeEntry(input.active?.speech ?? null),
      transcription: activeEntry(input.active?.transcription ?? null),
      computer_use: activeEntry(input.active?.computer_use ?? null)
    },
    downloads: [],
    downloadDurability: { status: 'healthy' },
    computerUse: input.computerUse ?? null
  }
}

function activeEntry(modelId: string | null): {
  modelId: string | null
  routeId: string | null
  ready: boolean
} {
  return { modelId, routeId: modelId, ready: modelId !== null }
}

type Surface = keyof ActiveModels

interface ControlIntent {
  type: string
  modelId?: string | null
  surface?: Surface
  confirmationId?: string
  operationId?: string
}

interface ControlSuccess<Model> {
  status: 'completed' | 'cancelled'
  operationId: string
  projection: ModelControlSnapshot<Model>
}

export interface ModelControlBoundary<Model> {
  /** The read the composer indicator and the drawer still use. */
  getModelControlProjection: () => Promise<ModelControlSnapshot<Model>>
  /** The one write door every model surface goes through. */
  controlModel: (intent: ControlIntent) => Promise<
    { ok: true; value: ControlSuccess<Model> } | { ok: false; failure: { kind: string; message: string } }
  >
  /** What the boundary currently holds, for a test that needs to read it back. */
  projection: () => ModelControlSnapshot<Model>
  /**
   * Every intent that crossed the bridge, in order. This is the renderer's terminal artifact for a
   * command whose effect lands in the main process — not a spy on Off Grid code.
   */
  intents: readonly ControlIntent[]
  /** Drop the recorded intents and return to the projection this boundary was built with. */
  reset: () => void
  /** Complete every download this boundary is holding, in the order they arrived. */
  settleDownloads: () => void
}

/**
 * The model-control boundary as the renderer sees it: one read and one write, backed by state that
 * really changes. Intents are APPLIED here rather than recorded, so a test asserts what the screen
 * shows after an activation or a removal instead of asserting that a function was called.
 *
 * This is a fake of the Electron IPC bridge — the process boundary — and of nothing else. The
 * screens, hooks, projection helpers and formatting under test are all production code.
 */
export function modelControlBoundary<Model extends { id: string }>(
  input: SnapshotInput<Model> & BoundaryOptions
): ModelControlBoundary<Model> {
  let state = modelControlSnapshot(input)
  const intents: ControlIntent[] = []
  const held: Array<() => void> = []
  let operation = 0
  const nextOperationId = (): string => `test-operation-${++operation}`

  const withActive = (surface: Surface, modelId: string | null): void => {
    const active = { ...state.active, [surface]: activeEntry(modelId) }
    const activeIds = Object.values(active)
      .map((entry) => entry.modelId)
      .filter((id): id is string => id !== null)
    state = { ...state, active, activeIds: [...new Set(activeIds)] }
  }

  const controlModel: ModelControlBoundary<Model>['controlModel'] = async (intent) => {
    intents.push(intent)
    switch (intent.type) {
      case 'select':
      case 'activate':
      case 'install-and-activate':
        if (intent.surface) withActive(intent.surface, intent.modelId ?? null)
        if (intent.type !== 'select' && intent.modelId) {
          state = { ...state, installed: [...new Set([...state.installed, intent.modelId])] }
        }
        break
      case 'unload':
        if (intent.surface) withActive(intent.surface, null)
        break
      case 'download': {
        const modelId = intent.modelId
        const install = (): void => {
          if (modelId) state = { ...state, installed: [...new Set([...state.installed, modelId])] }
        }
        if (input.holdDownloads) {
          return new Promise((resolve) => {
            held.push(() => {
              install()
              resolve({
                ok: true,
                value: { status: 'completed', operationId: nextOperationId(), projection: state }
              })
            })
          })
        }
        install()
        break
      }
      case 'remove':
        if (intent.modelId) {
          const removed = intent.modelId
          state = { ...state, installed: state.installed.filter((id) => id !== removed) }
          for (const surface of Object.keys(state.active) as Surface[]) {
            if (state.active[surface].modelId === removed) withActive(surface, null)
          }
        }
        break
      case 'cancel-download':
        return { ok: true, value: { status: 'cancelled', operationId: nextOperationId(), projection: state } }
      default:
        break
    }
    return { ok: true, value: { status: 'completed', operationId: nextOperationId(), projection: state } }
  }

  return {
    getModelControlProjection: async () => state,
    controlModel,
    projection: () => state,
    intents,
    reset: () => {
      state = modelControlSnapshot(input)
      intents.length = 0
      held.length = 0
      operation = 0
    },
    settleDownloads: () => {
      for (const release of held.splice(0)) release()
    }
  }
}
