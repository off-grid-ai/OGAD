// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../SettingsPanel'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<SettingsPanel/> tool settings', () => {
  it('shows meeting search and toggles it independently', async () => {
    const setToolEnabled = vi.fn(async () => undefined)
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getLlmSettings: async () => ({}),
      getModelCatalog: async () => ({ models: [] }),
      getActiveModel: async () => null,
      getSettings: async () => ({}),
      getTranscriptionInfo: async () => null,
      listTools: async () => [
        {
          name: 'search_meetings',
          description: "Search the user's recorded meetings.",
          enabled: true
        }
      ],
      setToolEnabled,
      mcpList: async () => []
    }

    render(<SettingsPanel embedded initialTab="tools" onClose={() => {}} />)

    expect(await screen.findByText('search_meetings')).toBeTruthy()
    expect(screen.getByText("Search the user's recorded meetings.")).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'On' }))

    await waitFor(() => expect(setToolEnabled).toHaveBeenCalledWith('search_meetings', false))
    expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy()
  })
})
