/**
 * On-demand grounder swap (R5 tier 3): load a GUI-grounding model (UI-TARS) for a
 * computer_task, then restore the chat model. There is ONE llama-server (one
 * `llm` singleton), so "load the grounder" means reload it with UI-TARS's gguf +
 * mmproj and reload gemma back after - the image-gen evict pattern, applied to
 * the model itself.
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
import { getActiveModel, setActiveModel } from '../models-manager'
import { isGrounderActive } from './vision-model-notice'
import { installedDownloadedIds } from '../downloaded-models'
import { resolveGrounderPlan } from './grounder-plan'

/** The grounder we swap in. Catalogued (grounder: true); its weights + mmproj
 *  must be downloaded (they are, for the A/B). */
export const GROUNDER_MODEL_ID = 'mradermacher/UI-TARS-1.5-7B-GGUF'

/** True when the dedicated grounder's files are actually on disk - the app's own
 *  installed-model check (the same list the Models screen shows as installed). */
function grounderInstalled(): boolean {
  return installedDownloadedIds(llm.getModelsDir()).includes(GROUNDER_MODEL_ID)
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

async function loadModel(id: string): Promise<void> {
  await setActiveModel(id)
  // reloadModel() (inside setActiveModel) is lazy; restart() forces the new
  // server up NOW so the load cost lands in the swap phase, not the first step.
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
  const alreadyGrounder = isGrounderActive(llm.activeModelInfo())
  const plan = resolveGrounderPlan(alreadyGrounder, grounderInstalled())
  if (plan === 'fallback-active-model') {
    console.warn(
      `[grounder] ${GROUNDER_MODEL_ID} is not downloaded - running computer use on the active model; grounding may be less accurate. Download the grounder for precise clicks.`
    )
  }
  const willSwap = plan === 'swap-in-grounder'
  const previousId = getActiveModel()

  let swapInMs = 0
  if (willSwap) {
    const t0 = now()
    await loadModel(GROUNDER_MODEL_ID)
    swapInMs = now() - t0
  }

  const startRun = now()
  let runMs = 0
  let swapOutMs = 0
  try {
    const result = await task()
    runMs = now() - startRun
    return {
      result,
      timing: { skippedSwap: !willSwap, swapInMs, runMs, swapOutMs }
    }
  } finally {
    if (runMs === 0) {
      runMs = now() - startRun // task threw - still attribute the run time
    }
    if (willSwap && previousId) {
      const t2 = now()
      await loadModel(previousId)
      swapOutMs = now() - t2
    }
  }
}
