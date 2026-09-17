// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ModelPicker } from '../ModelPicker'

afterEach(() => cleanup())

describe('<ModelPicker/> use model details', () => {
  it('shows separate Computer Use and Web Use model strategies', async () => {
    window.api = {
      getModelCatalog: async () => ({ models: [] }),
      getInstalledModels: async () => [],
      getActiveModel: async () => null,
      getActiveModalities: async () => ({}),
      getActiveModelIds: async () => [],
      getComputerUseActiveModels: async () => ({
        strategy: 'text_plus_specialist',
        strategyLabel: 'Reasoning + Specialist',
        models: [
          {
            role: 'reasoner',
            modelId: 'local/qwen',
            modelName: 'Qwen 3.5 9B',
            remote: false
          },
          {
            role: 'grounding_specialist',
            modelId: 'local/grounder',
            modelName: 'UI Grounder',
            remote: false
          }
        ]
      }),
      getWebUseActiveModels: async () => ({
        strategy: 'same_as_chat',
        strategyLabel: 'Same as Chat',
        models: [
          {
            role: 'reasoner',
            modelId: 'remote/chat',
            modelName: 'Remote Chat Model',
            remote: true
          }
        ]
      })
    } as unknown as Window['api']

    render(<ModelPicker onClose={() => undefined} />)

    const computerUse = await screen.findByRole('region', { name: 'Computer Use' })
    expect(computerUse.textContent).toContain('Reasoning + Specialist')
    expect(computerUse.textContent).toContain('Qwen 3.5 9B')
    expect(computerUse.textContent).toContain('UI Grounder')

    const webUse = screen.getByRole('region', { name: 'Web Use' })
    expect(webUse.textContent).toContain('Same as Chat')
    expect(webUse.textContent).toContain('Remote Chat Model')
    expect(webUse.textContent).toContain('Remote')
  })
})
