import { llm } from '../llm'
import { getComputerUseSettings } from '../computer-use-settings'
import { DECIDER_2B, listInstalled, loadComputerUseModel } from '../models-manager'

export function selectedDecisionModelId(): string {
  return getComputerUseSettings().decisionModelId ?? DECIDER_2B.id
}

/** Run one AX decision phase with the selected Decision model, then return the
 * shared llama.cpp process to the saved Chat model before vision recovery. */
export async function withDecisionModel<T>(task: () => Promise<T>): Promise<T> {
  const modelId = selectedDecisionModelId()
  if (!(await listInstalled()).includes(modelId)) {
    throw new Error(
      `The selected Decision model is not downloaded: ${modelId}. Download it from the Computer Use catalog first.`
    )
  }
  const alreadyLoaded = llm.activeModelInfo()?.id === modelId
  if (!alreadyLoaded) {
    const loaded = await loadComputerUseModel(modelId)
    if (!loaded.success) {
      throw new Error(loaded.error ?? 'The Decision model could not load.')
    }
    await llm.restart()
  }
  try {
    return await task()
  } finally {
    if (!alreadyLoaded) {
      llm.restoreSelectedModel()
      await llm.restart()
    }
  }
}

/** Temporarily yield the shared llama.cpp process to the saved reasoning model
 * while an active Decision-model AX loop performs one visual recovery action. */
export async function withReasoningModel<T>(task: () => Promise<T>): Promise<T> {
  const modelId = selectedDecisionModelId()
  const decisionModelLoaded = llm.activeModelInfo()?.id === modelId
  if (!decisionModelLoaded) return task()
  llm.restoreSelectedModel()
  await llm.restart()
  try {
    return await task()
  } finally {
    const loaded = await loadComputerUseModel(modelId)
    if (!loaded.success) {
      throw new Error(loaded.error ?? 'The Decision model could not resume.')
    }
    await llm.restart()
  }
}
