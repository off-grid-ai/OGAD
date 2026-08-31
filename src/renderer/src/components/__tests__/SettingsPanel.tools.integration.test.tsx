// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../SettingsPanel'
import { clearRegisteredSlots, registerSlot, SLOTS } from '../../bootstrap/slotRegistry'

afterEach(() => {
  cleanup()
  clearRegisteredSlots()
  vi.restoreAllMocks()
})

describe('<SettingsPanel/> tool settings', () => {
  it('shows and saves the maximum tool-call setting', async () => {
    let settings = { maxToolCalls: 25 }
    const setLlmSettings = vi.fn(async (patch: { maxToolCalls?: number }) => {
      settings = { ...settings, ...patch }
      return settings
    })
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getLlmSettings: async () => settings,
      setLlmSettings,
      getModelCatalog: async () => ({ models: [] }),
      getActiveModel: async () => null,
      getSettings: async () => ({}),
      getTranscriptionInfo: async () => null,
      listTools: async () => [],
      mcpList: async () => []
    }

    render(<SettingsPanel embedded onClose={() => {}} />)

    const slider = await screen.findByRole('slider', { name: 'Maximum tool calls' })
    expect((slider as HTMLInputElement).value).toBe('25')
    fireEvent.change(slider, { target: { value: '42' } })

    await waitFor(() => expect(setLlmSettings).toHaveBeenCalledWith({ maxToolCalls: 42 }))
    expect(screen.getByText('42')).toBeTruthy()
  })

  it('hosts licensed task settings in the shared Tasks tab', async () => {
    registerSlot(SLOTS.taskSettings, () => <div>Task settings content</div>)
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getLlmSettings: async () => ({}),
      getModelCatalog: async () => ({ models: [] }),
      getActiveModel: async () => null,
      getSettings: async () => ({}),
      getTranscriptionInfo: async () => null,
      listTools: async () => [],
      mcpList: async () => []
    }

    render(<SettingsPanel embedded onClose={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'tasks' }))

    expect(screen.getByText('Task settings content')).toBeTruthy()
  })

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
