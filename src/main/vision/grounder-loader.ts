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
  ModelAdmissionError,
  runtimeModelRouteId,
  type ModelModality,
  type RuntimeModel
} from '@offgrid/models'
import { llm } from '../llm'
import { getActiveModel, listInstalled, loadComputerUseModel } from '../models-manager'
import { desktopModelServices, type DesktopModelServices } from '../model-service-access'
import { isGrounderActive } from './vision-model-notice'
import { resolveGrounderLoadPlan } from '@offgrid/models'
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
  return desktopModelServices.llm.active('computer_use').model?.id ?? DEFAULT_GROUNDER_MODEL_ID
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

const LLAMA_RUNTIME_RESIDENCY_KEY = 'desktop:llama-server'

export interface GrounderNativeRuntime {
  project(modelId: string): Promise<{ success: boolean; error?: string }>
  restart(): Promise<void>
  unload(): Promise<void>
}

type GrounderModelServices = Pick<
  DesktopModelServices,
  'llm' | 'refresh' | 'residency' | 'routeIdFor' | 'select' | 'unload' | 'warmText'
>

function requireLocalModel(
  services: GrounderModelServices,
  modality: ModelModality,
  modelId: string
): RuntimeModel {
  const routeId = services.routeIdFor(modality, modelId)
  const model = routeId
    ? services.llm
        .list(modality)
        .find((candidate) => (candidate.routeId ?? runtimeModelRouteId(candidate)) === routeId)
    : undefined
  if (!model || model.source !== 'local' || !model.ready) {
    throw new Error(`The selected Computer Use model is not ready: ${modelId}.`)
  }
  return model
}

/** Shared model-control boundary around the Desktop llama-server adapter. */
export function createGrounderLifecycle(
  services: GrounderModelServices,
  native: GrounderNativeRuntime
): Pick<GrounderRunnerDependencies, 'load' | 'restoreLocal'> {
  return {
    async load(modelId, nativeAlreadyLoaded = false) {
      await services.refresh()
      const selected = await services.select('computer_use', modelId)
      if (!selected.success) {
        throw new Error(selected.error ?? 'The Computer Use model could not be selected.')
      }
      await services.refresh()
      const model = requireLocalModel(services, 'computer_use', modelId)
      const routeId = model.routeId ?? runtimeModelRouteId(model)
      const sizeMB = model.peakSizeMB ?? model.residentSizeMB
      if (!sizeMB) throw new Error(`The Computer Use model has no memory footprint: ${modelId}.`)

      // One llama-server process owns both chat and grounding. Remove a tracked
      // text resident before the native adapter projects different model files.
      if (!nativeAlreadyLoaded) await services.unload('text')
      const lease = await services.residency.acquire(
        {
          key: `computer_use:${routeId}`,
          modelId: routeId,
          type: 'computer_use',
          sizeMB,
          residencyKey: LLAMA_RUNTIME_RESIDENCY_KEY
        },
        {
          load: async () => {
            if (nativeAlreadyLoaded) return
            const projected = await native.project(modelId)
            if (!projected.success) {
              throw new Error(projected.error ?? 'The Computer Use model could not load.')
            }
            await native.restart()
          },
          unload: () => native.unload()
        }
      )
      if (!lease.acquired) throw new ModelAdmissionError(model)
      await lease.release()
    },
    async restoreLocal(modelId) {
      await services.unload('computer_use')
      const selected = await services.select('text', modelId)
      if (!selected.success)
        throw new Error(selected.error ?? 'The chat model could not be restored.')
      await services.warmText()
    }
  }
}

const productionGrounderLifecycle = createGrounderLifecycle(desktopModelServices, {
  project: loadComputerUseModel,
  restart: () => llm.restart(),
  unload: async () => {
    await llm.unload()
  }
})

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
  load(modelId: string, nativeAlreadyLoaded?: boolean): Promise<void>
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
  load: productionGrounderLifecycle.load,
  restoreLocal: productionGrounderLifecycle.restoreLocal,
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
    const plan = resolveGrounderLoadPlan({
      activeIsGrounder: alreadyGrounder,
      specialistInstalled: await dependencies.installed(grounderId)
    })
    if (plan === 'missing-grounder') {
      throw new Error(
        `The selected Computer Use model is not downloaded: ${grounderId}. Download it before starting Web Use.`
      )
    }

    const previousLocalId = dependencies.activeModelId()
    const previousRemote = dependencies.activeRemote()
    const loadSelected = plan === 'swap-in-grounder'
    const suspendRemote = previousRemote !== null

    if (!loadSelected && !suspendRemote) {
      // Adopt a native model found after relaunch into the shared residency SSOT.
      await dependencies.load(grounderId, true)
      return directRun(task, now)
    }

    const swapped = await runRestoredModelSwap({
      swapIn: async () => {
        if (suspendRemote) dependencies.suspendRemote()
        await dependencies.load(grounderId, alreadyGrounder)
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
