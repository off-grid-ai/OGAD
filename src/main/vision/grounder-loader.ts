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
import { llm } from '../llm'
import {
  getActiveModel,
  listInstalled,
  loadComputerUseModel,
  setActiveModel
} from '../models-manager'
import { getActiveModal } from '../active-models'
import { isGrounderActive } from './vision-model-notice'
import { resolveGrounderPlan } from './grounder-plan'
import { runRestoredModelSwap } from './grounder-swap'
import { getComputerUseSettings } from '../computer-use-settings'
import {
  activateRemoteVisionModel,
  deactivateRemoteVisionModel,
  getActiveRemoteVisionServer
} from './remote-vision-server'
import type { ComputerUseModelStrategy } from '../../shared/computer-use-settings'
import {
  currentRemoteScreenTaskSession,
  runWithRemoteScreenTaskSession
} from '../actions/remote-screen-session'

const DEFAULT_GROUNDER_MODEL_ID = 'mradermacher/UI-TARS-1.5-7B-GGUF'

/** The saved Computer Use choice, or the current catalog default. */
export function selectedGrounderModelId(): string {
  return getActiveModal('computer_use') ?? DEFAULT_GROUNDER_MODEL_ID
}

async function grounderInstalled(modelId: string): Promise<boolean> {
  return (await listInstalled()).includes(modelId)
}

export interface GrounderTiming {
  /** True when a grounder was already loaded, so no swap was paid. */
  skippedSwap: boolean
  swapInMs: number
  runMs: number
  swapOutMs: number
}

/** The wall-clock a swap adds on top of the task run. */
export function grounderSwapOverheadMs(t: GrounderTiming): number {
  return t.swapInMs + t.swapOutMs
}

async function loadGrounder(id: string): Promise<void> {
  const loaded = await loadComputerUseModel(id)
  if (!loaded.success) throw new Error(loaded.error ?? 'The Computer Use model could not load.')
  // reloadModel() (inside setActiveModel) is lazy; restart() forces the new
  // server up NOW so the load cost lands in the swap phase, not the first step.
  await llm.restart()
}

async function restoreChatModel(previousId: string): Promise<void> {
  const restored = await setActiveModel(previousId)
  if (!restored.success) {
    throw new Error(restored.error ?? 'The chat model could not be restored.')
  }
  await llm.restart()
}

interface GrounderRemoteSelection {
  id: string
  model: string
}

interface GrounderActiveModel {
  id: string
  vision: boolean
}

export interface GrounderRunnerDependencies {
  modelStrategy(): ComputerUseModelStrategy
  selectedModelId(): string
  installed(modelId: string): Promise<boolean>
  activeModel(): GrounderActiveModel | null
  activeModelId(): string | null
  activeRemote(): GrounderRemoteSelection | null
  isGrounder(model: GrounderActiveModel): boolean
  load(modelId: string): Promise<void>
  restoreLocal(modelId: string): Promise<void>
  suspendRemote(): void
  restoreRemote(selection: GrounderRemoteSelection): void
}

const productionGrounderDependencies: GrounderRunnerDependencies = {
  modelStrategy: () =>
    currentRemoteScreenTaskSession()?.modelStrategy ?? getComputerUseSettings().modelStrategy,
  selectedModelId: selectedGrounderModelId,
  installed: grounderInstalled,
  activeModel: () => llm.activeModelInfo(),
  activeModelId: getActiveModel,
  activeRemote: () => {
    const session = currentRemoteScreenTaskSession()
    return session ? session.activeServer : getActiveRemoteVisionServer()
  },
  isGrounder: isGrounderActive,
  load: loadGrounder,
  restoreLocal: restoreChatModel,
  suspendRemote: deactivateRemoteVisionModel,
  restoreRemote(selection) {
    if (!activateRemoteVisionModel(selection.id, selection.model)) {
      throw new Error('The remote chat model could not be restored.')
    }
  }
}

async function directRun<T>(
  task: () => Promise<T>,
  now: () => number
): Promise<{ result: T; timing: GrounderTiming }> {
  const startRun = now()
  const result = await task()
  return {
    result,
    timing: { skippedSwap: true, swapInMs: 0, runMs: now() - startRun, swapOutMs: 0 }
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
  return async <T>(task: () => Promise<T>, now: () => number = Date.now) => {
    if (dependencies.modelStrategy() === 'same_as_chat') return directRun(task, now)

    const grounderId = dependencies.selectedModelId()
    const active = dependencies.activeModel()
    const alreadyGrounder = active?.id === grounderId && dependencies.isGrounder(active)
    const plan = resolveGrounderPlan(alreadyGrounder, await dependencies.installed(grounderId))
    if (plan === 'missing-grounder') {
      throw new Error(
        `The selected Computer Use model is not downloaded: ${grounderId}. Download it before starting Web Use.`
      )
    }

    const previousLocalId = dependencies.activeModelId()
    const previousRemote = dependencies.activeRemote()
    const loadSelected = plan === 'swap-in-grounder'
    const suspendRemote = previousRemote !== null

    if (!loadSelected && !suspendRemote) return directRun(task, now)

    const swapped = await runRestoredModelSwap({
      swapIn: async () => {
        if (suspendRemote) dependencies.suspendRemote()
        if (loadSelected) await dependencies.load(grounderId)
      },
      run: task,
      // With no prior resident model there is nothing to restore: the callback
      // no-ops and the selected specialist stays resident after the run. A remote
      // reasoner does not need the prior local chat model either. Keep the local
      // specialist resident between grounded actions and restore only the remote
      // transport; otherwise every task step pays two multi-GB model reloads.
      restore: async () => {
        if (loadSelected && previousLocalId && !previousRemote) {
          await dependencies.restoreLocal(previousLocalId)
        }
        if (previousRemote) dependencies.restoreRemote(previousRemote)
      },
      now
    })
    return { result: swapped.result, timing: { skippedSwap: false, ...swapped.timing } }
  }
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
