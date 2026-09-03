/**
 * On-demand grounder swap (R5 tier 3): load the selected Computer Use model for a
 * computer_use, then restore the chat model. There is ONE llama-server (one
 * `llm` singleton), so "load the grounder" means reload it with the model's GGUF
 * and projector, then reload the chat model - the image-gen evict pattern, applied
 * to the model itself.
 *
 * This is the EXPENSIVE tier: a multi-GB reload each way (~seconds), and the chat
 * model is unavailable while the grounder is loaded. The router only reaches here
 * when the cheaper rails (accessibility) cannot drive the surface. The swap is
 * timed and broken out (swap-in / run / swap-out) so a computer_use's cost is
 * attributable - which is what the AX-vs-grounder A/B compares.
 *
 * Native/engine glue over the tested decision (isGrounderActive) - it reloads
 * llama-server and needs a real model on disk, so it is excluded from in-process
 * coverage; the A/B run exercises it.
 */
import {
  createGrounderApplicationService,
  type GrounderApplicationPort,
  type GrounderRunTiming
} from '@offgrid/models'
import type { ModelsFacade } from '@offgrid/application'
import { llm } from '../llm'
import { isGrounderActive } from './vision-model-notice'
import { getComputerUseSettings } from '../computer-use-settings'
import { getActiveRemoteVisionServer } from './remote-vision-server'
import {
  currentRemoteScreenTaskSession,
  runWithRemoteScreenTaskSession
} from '../actions/remote-screen-session'
import { desktopModels, modelsFailureMessage } from '../composition/application-access'

const DEFAULT_GROUNDER_MODEL_ID = 'mradermacher/UI-TARS-1.5-7B-GGUF'

/** The saved Computer Use choice, or the current catalog default. */
export function selectedGrounderModelId(): string {
  return desktopModels.snapshot().active.computer_use?.model?.id ?? DEFAULT_GROUNDER_MODEL_ID
}

async function grounderInstalled(modelId: string): Promise<boolean> {
  await desktopModels.refresh()
  return desktopModels.lookup(modelId)?.ready ?? false
}

export type GrounderTiming = GrounderRunTiming

/** The wall-clock a swap adds on top of the task run. */
export function grounderSwapOverheadMs(t: GrounderTiming): number {
  return t.swapInMs + t.swapOutMs
}

/** Shared model-control boundary around the Desktop llama-server adapter. */
export function createGrounderLifecycle(
  models: Pick<ModelsFacade, 'refresh' | 'select' | 'load' | 'unload' | 'prepare'>
): Pick<GrounderRunnerDependencies, 'load' | 'restoreLocal'> {
  return {
    async load(modelId) {
      await models.refresh()
      const selected = await models.select({ modality: 'computer_use', modelId })
      if (!selected.ok) {
        throw new Error(modelsFailureMessage(selected.failure))
      }
      const loaded = await models.load({ modality: 'computer_use', modelId })
      if (!loaded.ok) throw new Error(modelsFailureMessage(loaded.failure))
    },
    async restoreLocal(modelId) {
      const unloaded = await models.unload({ modality: 'computer_use' })
      if (!unloaded.ok) throw new Error(modelsFailureMessage(unloaded.failure))
      const selected = await models.select({ modality: 'text', modelId })
      if (!selected.ok) throw new Error(modelsFailureMessage(selected.failure))
      const prepared = await models.prepare('text')
      if (!prepared.ok) throw new Error(modelsFailureMessage(prepared.failure))
    }
  }
}

const productionGrounderLifecycle = createGrounderLifecycle(desktopModels)

export interface GrounderRemoteSelection {
  id: string
  model: string
}

export type GrounderRunnerDependencies = GrounderApplicationPort<GrounderRemoteSelection>

const productionGrounderDependencies: GrounderRunnerDependencies = {
  strategy: () =>
    currentRemoteScreenTaskSession()?.modelStrategy ?? getComputerUseSettings().modelStrategy,
  selectedModelId: selectedGrounderModelId,
  installed: grounderInstalled,
  activeModel: () => llm.activeModelInfo(),
  activeModelId: () => desktopModels.activeModelId('text'),
  activeRemote: () => {
    const session = currentRemoteScreenTaskSession()
    return session ? session.activeServer : getActiveRemoteVisionServer()
  },
  isGrounder: isGrounderActive,
  load: productionGrounderLifecycle.load,
  restoreLocal: productionGrounderLifecycle.restoreLocal,
  // The canonical text selection is the only record of an active remote; nothing to suspend.
  suspendRemote: () => undefined,
  restoreRemote(selection) {
    if (!desktopModels.remoteModelRoute(selection.id, selection.model, 'text')) {
      throw new Error('The remote chat model could not be restored.')
    }
  }
}

/** Build the lifecycle once so production and the model-boundary integration
 * harness exercise the same remote/local restore path. */
export function createGrounderRunner(
  dependencies: GrounderRunnerDependencies
): <T>(
  task: () => Promise<T>,
  now?: () => number
) => Promise<{ result: T; timing: GrounderTiming }> {
  return createGrounderApplicationService(dependencies)
}

const runWithProductionGrounder = createGrounderRunner(productionGrounderDependencies)

/**
 * Run `task` with the grounder loaded. If a grounder is already active, runs it
 * directly (no swap). Restores the previous chat model on the way out, even if
 * the task throws. Returns the task result plus the timing breakdown.
 */
export async function withGrounder<T>(
  task: () => Promise<T>,
  now: () => number = Date.now
): Promise<{ result: T; timing: GrounderTiming }> {
  const screenTask = currentRemoteScreenTaskSession()
  if (!screenTask) return runWithProductionGrounder(task, now)
  // A remote Chat reasoner remains bound to the outer task session. The grounding specialist is
  // local, so its nested request must not inherit that remote transport or rewrite the saved active
  // server while the task swaps the resident local model.
  return runWithRemoteScreenTaskSession({ ...screenTask, activeServer: null }, () =>
    runWithProductionGrounder(task, now)
  )
}
