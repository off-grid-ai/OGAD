/**
 * On-demand grounder swap (R5 tier 3): load the selected Computer Use model for a
 * computer_task, then restore the chat model. There is ONE llama-server (one
 * `llm` singleton), so "load the grounder" means reload it with the model's GGUF
 * and projector, then reload the chat model - the image-gen evict pattern, applied
 * to the model itself.
 *
 * This is the EXPENSIVE tier: a multi-GB reload each way (~seconds), and the chat
 * model is unavailable while the grounder is loaded. The router only reaches here
 * when the cheaper rails (accessibility) cannot drive the surface. The swap is
 * timed and broken out (swap-in / run / swap-out) so a computer_task's cost is
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
import { getActiveRemoteVisionServer } from './remote-vision-server'

/** Migration default for people who used computer tasks before the Computer Use catalog existed. */
export const GROUNDER_MODEL_ID = 'mradermacher/UI-TARS-1.5-7B-GGUF'

/** The saved Computer Use choice, with the established UI-TARS model as the migration default. */
function selectedGrounderModelId(): string {
  return getActiveModal('computer_use') ?? GROUNDER_MODEL_ID
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

/**
 * Run `task` with the grounder loaded. If a grounder is already active, runs it
 * directly (no swap). Restores the previous chat model on the way out, even if
 * the task throws. Returns the task result plus the timing breakdown.
 */
export async function withGrounder<T>(
  task: () => Promise<T>,
  now: () => number = Date.now
): Promise<{ result: T; timing: GrounderTiming }> {
  if (
    getActiveRemoteVisionServer() ||
    getComputerUseSettings().modelStrategy === 'same_as_chat'
  ) {
    const startRun = now()
    const result = await task()
    return {
      result,
      timing: { skippedSwap: true, swapInMs: 0, runMs: now() - startRun, swapOutMs: 0 }
    }
  }
  const grounderId = selectedGrounderModelId()
  const active = llm.activeModelInfo()
  const alreadyGrounder = active?.id === grounderId && isGrounderActive(active)
  const plan = resolveGrounderPlan(alreadyGrounder, await grounderInstalled(grounderId))
  if (plan === 'fallback-active-model') {
    console.warn(
      `[grounder] ${grounderId} is not downloaded - running computer use on the active model; grounding may be less accurate. Download the grounder for precise clicks.`
    )
  }
  const willSwap = plan === 'swap-in-grounder'
  const previousId = getActiveModel()

  if (!willSwap) {
    const startRun = now()
    const result = await task()
    return {
      result,
      timing: { skippedSwap: true, swapInMs: 0, runMs: now() - startRun, swapOutMs: 0 }
    }
  }

  if (!previousId) {
    const swapStartedAt = now()
    await loadGrounder(grounderId)
    const swapInMs = now() - swapStartedAt
    const runStartedAt = now()
    const result = await task()
    return {
      result,
      timing: { skippedSwap: false, swapInMs, runMs: now() - runStartedAt, swapOutMs: 0 }
    }
  }

  const swapped = await runRestoredModelSwap({
    swapIn: () => loadGrounder(grounderId),
    run: task,
    restore: () => restoreChatModel(previousId),
    now
  })
  return { result: swapped.result, timing: { skippedSwap: false, ...swapped.timing } }
}
