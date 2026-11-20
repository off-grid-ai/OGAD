// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
  it('shows the stored group state after a partial save fails', async () => {
    const stored = [
      { name: 'calendar_create_event', description: 'Create an event.', enabled: true },
      { name: 'calendar_list_events', description: 'List events.', enabled: true }
    ]
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getLlmSettings: async () => ({}),
      getModelCatalog: async () => ({ models: [] }),
      getActiveModel: async () => null,
      getSettings: async () => ({}),
      getTranscriptionInfo: async () => null,
      listTools: async () => stored.map((tool) => ({ ...tool })),
      setToolEnabled: async (name: string, enabled: boolean) => {
        if (name === 'calendar_list_events') throw new Error('Save failed')
        stored.find((tool) => tool.name === name)!.enabled = enabled
      },
      mcpList: async () => []
    }
    const user = userEvent.setup()
    const view = render(<SettingsPanel embedded initialTab="tools" onClose={() => {}} />)
    await user.click(await screen.findByRole('switch', { name: 'Enable Calendar tools' }))
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Enable Calendar tools' }).getAttribute('aria-checked')).toBe('mixed')
    )
    view.unmount()
    render(<SettingsPanel embedded initialTab="tools" onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /^Calendar/ }))
    expect(screen.getByRole('switch', { name: 'Enable calendar_create_event' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Enable calendar_list_events' }).getAttribute('aria-checked')).toBe('true')
  })

  it('turns all chat tools off from the side panel', async () => {
    const saved: Array<[string, unknown]> = []
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getLlmSettings: async () => ({}),
      getModelCatalog: async () => ({ models: [] }),
      getActiveModel: async () => null,
      getSettings: async () => ({ toolsEnabled: true }),
      getTranscriptionInfo: async () => null,
      listTools: async () => [],
      mcpList: async () => [],
      saveSetting: async (key: string, value: unknown) => {
        saved.push([key, value])
      }
    }

    render(<SettingsPanel embedded initialTab="tools" onClose={() => {}} />)
    const toggle = await screen.findByRole('switch', { name: 'Enable tools' })
    await userEvent.click(toggle)

    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(saved).toContainEqual(['toolsEnabled', false])
  })

  it('shows and saves the maximum tool-call setting', async () => {
    let settings = { maxToolCalls: 25 }
    const saved: Array<{ maxToolCalls?: number }> = []
    const setLlmSettings = async (patch: { maxToolCalls?: number }): Promise<{ maxToolCalls: number; }> => {
      saved.push(patch)
      settings = { ...settings, ...patch }
      return settings
    }
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
    expect(slider.getAttribute('aria-valuenow')).toBe('25')
    const user = userEvent.setup()
    slider.focus()
    // 25 -> 42 is seventeen one-call steps with the arrow key.
    await user.keyboard('{ArrowRight>17/}')
    expect(slider.getAttribute('aria-valuenow')).toBe('42')
    expect(saved).toEqual([])
    await user.tab()

    await waitFor(() => expect(saved).toEqual([{ maxToolCalls: 42 }]))
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
    await userEvent.click(screen.getByRole('radio', { name: 'tasks' }))

    expect(screen.getByText('Task settings content')).toBeTruthy()
  })

  it('groups related tools and keeps group and individual control', async () => {
    const saved: Array<[string, boolean]> = []
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getLlmSettings: async () => ({}),
      getModelCatalog: async () => ({ models: [] }),
      getActiveModel: async () => null,
      getSettings: async () => ({}),
      getTranscriptionInfo: async () => null,
      listTools: async () => [
        {
          name: 'computer_use',
          description: 'Control the Mac.',
          enabled: true
        },
        {
          name: 'web_use',
          description: 'Browse the web.',
          enabled: true
        },
        {
          name: 'calendar_create_event',
          description: 'Create a calendar event.',
          enabled: true
        },
        {
          name: 'calendar_list_events',
          description: 'List calendar events.',
          enabled: true
        },
        {
          name: 'calculator',
          description: 'Evaluate basic arithmetic.',
          enabled: true
        }
      ],
      setToolEnabled: async (name: string, enabled: boolean) => {
        saved.push([name, enabled])
      },
      mcpList: async () => []
    }

    render(<SettingsPanel embedded initialTab="tools" onClose={() => {}} />)

    expect(await screen.findByRole('heading', { name: 'Assistant' })).toBeTruthy()
    expect(await screen.findByRole('heading', { name: 'Calendar' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Utilities' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Enable computer_use' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /^Assistant/ }))

    expect(screen.getByRole('switch', { name: 'Enable computer_use' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Enable web_use' })).toBeTruthy()

    await userEvent.click(screen.getByRole('switch', { name: 'Enable Calendar tools' }))

    await waitFor(() =>
      expect(saved).toEqual([
        ['calendar_create_event', false],
        ['calendar_list_events', false]
      ])
    )
    expect(screen.getByText('0 of 2 on')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /^Calendar/ }))
    await userEvent.click(screen.getByRole('switch', { name: 'Enable calendar_create_event' }))

    await waitFor(() =>
      expect(saved).toEqual([
        ['calendar_create_event', false],
        ['calendar_list_events', false],
        ['calendar_create_event', true]
      ])
    )
    expect(screen.getByText('1 of 2 on')).toBeTruthy()
    expect(
      screen.getByRole('switch', { name: 'Enable Calendar tools' }).getAttribute('aria-checked')
    ).toBe('mixed')
  })
})
