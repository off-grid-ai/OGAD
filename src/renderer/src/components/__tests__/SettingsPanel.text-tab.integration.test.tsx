// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsPanel } from '../SettingsPanel'

afterEach(cleanup)

describe('Desktop Settings tabs', () => {
  it('opens the text model controls from the Text tab', async () => {
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getLlmSettings: async () => ({}),
      getModelCatalog: async () => ({ models: [] }),
      getActiveModel: async () => null,
      getSettings: async () => ({}),
      getTranscriptionInfo: async () => null,
      listTools: async () => [],
      mcpList: async () => []
    }

    render(<SettingsPanel embedded initialTab="tools" onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Text' }))

    expect(screen.getByText('Current model')).toBeTruthy()
    expect(screen.getByText('Temperature')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Model' })).toBeNull()
  })
})
