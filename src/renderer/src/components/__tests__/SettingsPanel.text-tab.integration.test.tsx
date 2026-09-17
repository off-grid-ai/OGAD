// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

  it('keeps text edits local until the field loses focus', async () => {
    const saved: Array<Record<string, unknown>> = []
    let settings: Record<string, unknown> = { systemPrompt: '' }
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      getLlmSettings: async () => settings,
      setLlmSettings: async (patch: Record<string, unknown>) => {
        saved.push(patch)
        settings = { ...settings, ...patch }
      },
      getModelCatalog: async () => ({ models: [] }),
      getActiveModel: async () => null,
      getSettings: async () => ({}),
      getTranscriptionInfo: async () => null,
      listTools: async () => [],
      mcpList: async () => []
    }

    render(<SettingsPanel embedded onClose={() => {}} />)
    const prompt = await screen.findByPlaceholderText(
      'e.g. You are a concise, technical assistant.'
    )
    const user = userEvent.setup()

    await user.type(prompt, 'Answer briefly.')
    expect(saved).toEqual([])

    await user.tab()
    await waitFor(() => expect(saved).toEqual([{ systemPrompt: 'Answer briefly.' }]))
  })
})
