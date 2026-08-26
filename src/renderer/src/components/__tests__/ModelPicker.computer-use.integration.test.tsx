// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker } from '../ModelPicker'

const CHAT_ID = 'local/qwen'
const SPECIALIST_ID = 'bartowski/tencent_UI-Mate-9B-GGUF'

function renderPicker(strategy: 'same_as_chat' | 'separate_specialist'): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getModelCatalog: vi.fn().mockResolvedValue({
      models: [
        { id: CHAT_ID, name: 'Qwen 3.5 2B', kind: 'text' },
        { id: SPECIALIST_ID, name: 'UI-Mate 9B', kind: 'computer_use' }
      ]
    }),
    getInstalledModels: vi.fn().mockResolvedValue([CHAT_ID, SPECIALIST_ID]),
    getActiveModel: vi.fn().mockResolvedValue(CHAT_ID),
    getActiveModalities: vi.fn().mockResolvedValue({ computer_use: SPECIALIST_ID }),
    getActiveModelIds: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({
      computerUseSettings: { modelStrategy: strategy }
    })
  }
  render(<ModelPicker onClose={vi.fn()} />)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<ModelPicker/> Computer Use model relationship', () => {
  it('shows the active Chat model when Computer Use shares it', async () => {
    renderPicker('same_as_chat')

    const section = await screen.findByRole('region', { name: 'Computer Use' })
    expect(within(section).getByText('Qwen 3.5 2B')).toBeTruthy()
    expect(within(section).getByText('Same as Chat')).toBeTruthy()
    expect(within(section).queryByText('UI-Mate 9B')).toBeNull()
  })

  it('shows the selected specialist separately from the active Chat model', async () => {
    renderPicker('separate_specialist')

    const section = await screen.findByRole('region', { name: 'Computer Use' })
    expect(within(section).getByText('UI-Mate 9B')).toBeTruthy()
    expect(within(section).getByText('Separate specialist')).toBeTruthy()
    expect(within(section).queryByText('Qwen 3.5 2B')).toBeNull()
  })
})
