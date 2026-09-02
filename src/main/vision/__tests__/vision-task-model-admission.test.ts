import { describe, expect, it } from 'vitest'
import type { RuntimeModel } from '@offgrid/models'
import { computerUseRouteIdFromInventory } from '../vision-task-model-strategy'

function route(thinking: boolean): RuntimeModel {
  return {
    id: 'unsloth/Qwen3.5-0.8B-GGUF',
    routeId: 'model-route:qwen-0.8b',
    name: 'Qwen 3.5 0.8B',
    kind: 'vision',
    modality: 'computer_use',
    source: 'local',
    adapterId: 'desktop.llama.computer-use',
    capabilities: {
      vision: true,
      tools: true,
      computerUse: true,
      thinking
    },
    installed: true,
    ready: true,
    loaded: true
  }
}

describe('Computer Use model admission', () => {
  it('rejects the selected chat model before the task when thinking is required but unsupported', () => {
    expect(() =>
      computerUseRouteIdFromInventory([route(false)], 'unsloth/Qwen3.5-0.8B-GGUF', true)
    ).toThrow('Qwen 3.5 0.8B does not support the required capabilities: thinking.')
  })

  it('admits the exact selected route when loaded-runtime evidence supports thinking', () => {
    expect(computerUseRouteIdFromInventory([route(true)], 'unsloth/Qwen3.5-0.8B-GGUF', true)).toBe(
      'model-route:qwen-0.8b'
    )
  })
})
