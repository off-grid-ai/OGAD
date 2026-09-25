/** Grounding runtime selection.
 *
 * Remote specialists use their saved server. Local specialists use a dedicated,
 * resident llama-server, so grounding never replaces the reasoning model. The
 * exported swap runner remains as a pure lifecycle seam for existing replay tests.
 */
import { getActiveModal } from '../active-models'
import { resolveGrounderPlan } from './grounder-plan'
import { runRestoredModelSwap } from './grounder-swap'
import { getComputerUseSettings } from '../computer-use-settings'
import { getRemoteVisionServerForModel } from './remote-vision-server'
import type { ComputerUseModelStrategy } from '../../shared/computer-use-settings'
import {
  currentRemoteScreenTaskSession,
  runWithRemoteScreenTaskSession
} from '../actions/remote-screen-session'
import { grounderRuntime } from './grounder-runtime'

const DEFAULT_GROUNDER_MODEL_ID = 'mradermacher/UI-TARS-1.5-7B-GGUF'

/** The saved Computer Use choice, or the current catalog default. */
export function selectedGrounderModelId(): string {
  return (
    getComputerUseSettings().groundingModelId ??
    getActiveModal('computer_use') ??
    DEFAULT_GROUNDER_MODEL_ID
  )
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
    // An exact match proves this is the selected Computer Use package. Downloaded package IDs are
    // opaque, so the catalog-name heuristic cannot identify them as grounders after they load.
    const alreadyGrounder = active?.id === grounderId && active.vision
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
      restore: async () => {
        // A remote reasoner does not need the resident local Chat model. Keep the lazily loaded
        // specialist resident so later delegated actions do not pay another model reload.
        if (loadSelected && !previousRemote) {
          await dependencies.restoreLocal(previousLocalId ?? '')
        }
        if (previousRemote) dependencies.restoreRemote(previousRemote)
      },
      now
    })
    return { result: swapped.result, timing: { skippedSwap: false, ...swapped.timing } }
  }
}

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
  const remoteGrounder = getRemoteVisionServerForModel(selectedGrounderModelId(), 'grounding')
  if (remoteGrounder) {
    return runWithRemoteScreenTaskSession(
      {
        taskKind: screenTask?.taskKind ?? 'computer_use',
        modelStrategy: screenTask?.modelStrategy ?? getComputerUseSettings().modelStrategy,
        activeServer: remoteGrounder
      },
      () => directRun(task, now)
    )
  }
  const localGrounder = await grounderRuntime.connection(selectedGrounderModelId())
  return runWithRemoteScreenTaskSession(
    {
      taskKind: screenTask?.taskKind ?? 'computer_use',
      modelStrategy: screenTask?.modelStrategy ?? getComputerUseSettings().modelStrategy,
      activeServer: localGrounder
    },
    () => directRun(task, now)
  )
}
