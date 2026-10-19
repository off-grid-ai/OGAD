// The models a strategy runs, two ways: the task projection (what Tasks and a run name) and the
// shared role map (what the Models screens mark active). They must name the same roles.
import { describe, expect, it } from 'vitest'
import {
  getComputerUseActiveModelProjection,
  type VisionTaskModelStrategyDependencies
} from '../vision-task-model-strategy'
import {
  strategyTaskRoles,
  type ComputerUseModelStrategy
} from '../../../shared/computer-use-settings'
import { remoteVisionModelId } from '../../../shared/remote-vision-server'

const STRATEGIES: ComputerUseModelStrategy[] = [
  'same_as_chat',
  'separate_specialist',
  'text_plus_specialist',
  'decision_plus_specialist',
  'decision_plus_reasoning'
]

const dependencies = (strategy: ComputerUseModelStrategy): VisionTaskModelStrategyDependencies =>
  ({
    strategy: () => strategy,
    activeArtifacts: () => null,
    activeRemote: () => null,
    selectedChatId: () => 'chat/reasoner',
    selectedSpecialistId: () => 'vision/specialist',
    selectedDecisionId: () => 'decision/selector',
    resolveIdentity: async (modelId: string) => ({ modelId, modelName: modelId })
  }) as unknown as VisionTaskModelStrategyDependencies

describe('task role models', () => {
  it.each(STRATEGIES)('%s: the projection and the role map name the same roles', async (s) => {
    const projection = await getComputerUseActiveModelProjection(dependencies(s))
    const projected = projection.models
      .filter((model) => model.role !== 'reasoner')
      .map((model) => (model.role === 'grounding_specialist' ? 'grounding' : model.role))
    expect(projected).toEqual(strategyTaskRoles(s))
  })

  it('a decision model from a remote server reads as remote even when the server is gone', async () => {
    // The role points at a remote-vision model whose server is offline or removed, so the live
    // server lookup finds nothing. The id itself is still remote — the card must not call it local.
    const deps = {
      ...dependencies('decision_plus_specialist'),
      selectedDecisionId: () => remoteVisionModelId('ghost-server', 'jaredpalmer/kev-4b')
    } as unknown as VisionTaskModelStrategyDependencies
    const projection = await getComputerUseActiveModelProjection(deps)
    const decision = projection.models.find((model) => model.role === 'decision')
    expect(decision?.remote).toBe(true)
  })
})
