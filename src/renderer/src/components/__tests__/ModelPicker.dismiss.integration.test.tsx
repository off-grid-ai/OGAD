// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ModelPicker } from '../ModelPicker'
import { OPEN_MODEL_SETTINGS_PANEL_EVENT } from '@renderer/lib/model-settings-panel'
import { modelControlBoundary } from './harness/model-control-snapshot'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderPicker(onClose = vi.fn()): ReturnType<typeof vi.fn> {
  const computerUse = {
    strategy: 'text_plus_specialist',
    strategyLabel: 'Text + Specialist',
    models: [
      {
        role: 'reasoner',
        modelId: 'remote/reasoner',
        modelName: 'Qwen Reasoner',
        remote: true
      },
      {
        role: 'grounding_specialist',
        modelId: 'local/ui-tars',
        modelName: 'UI-TARS 1.5 7B',
        remote: false
      }
    ]
  }
  const models = [
    {
      id: 'local/qwen',
      name: 'Qwen 3.5 2B',
      kind: 'text',
      files: [{ name: 'qwen.gguf', role: 'primary' }]
    }
  ]
  // One owner for the model-control read and write. `ModelPicker` refreshes through
  // `control({ type: 'refresh' })` on mount, so a fixture without the write door fails the whole
  // load and renders an empty picker.
  const modelControl = modelControlBoundary({
    kinds: ['text'],
    models,
    installed: ['local/qwen'],
    computerUse
  })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getModelControlProjection: modelControl.getModelControlProjection,
    controlModel: modelControl.controlModel,
    getModelCatalog: vi.fn().mockResolvedValue({ models }),
    getInstalledModels: vi.fn().mockResolvedValue(['local/qwen']),
    getActiveModel: vi.fn().mockResolvedValue(null),
    getActiveModalities: vi.fn().mockResolvedValue({}),
    getActiveModelIds: vi.fn().mockResolvedValue([]),
    getComputerUseActiveModels: vi.fn().mockResolvedValue(computerUse)
  }
  render(<ModelPicker onClose={onClose} />)
  return onClose
}

const REMOTE_MODEL_ID = 'remote-vision:home:google%2Fgemma-4'

function renderPickerWithRemote(): ReturnType<typeof modelControlBoundary> {
  const models = [
    {
      id: REMOTE_MODEL_ID,
      name: 'google/gemma-4',
      kind: 'vision',
      files: [],
      remoteServerId: 'home'
    }
  ]
  const modelControl = modelControlBoundary({
    kinds: ['vision'],
    models,
    installed: [REMOTE_MODEL_ID],
    computerUse: { strategy: 'same_as_chat', strategyLabel: 'Same as Chat', models: [] }
  })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getModelControlProjection: modelControl.getModelControlProjection,
    controlModel: modelControl.controlModel,
    getModelCatalog: vi.fn().mockResolvedValue({ models }),
    getInstalledModels: vi.fn().mockResolvedValue([REMOTE_MODEL_ID]),
    getActiveModel: vi.fn().mockResolvedValue(null),
    getActiveModalities: vi.fn().mockResolvedValue({}),
    getActiveModelIds: vi.fn().mockImplementation(async () => modelControl.projection().activeIds),
    getComputerUseActiveModels: vi.fn().mockResolvedValue({
      strategy: 'same_as_chat',
      strategyLabel: 'Same as Chat',
      models: []
    }),
    // Activation assesses fit first through the shared service; a remote model has no
    // local footprint, so the boundary reports "nothing to assess".
    estimateModelFit: vi.fn().mockResolvedValue(null)
  }
  render(<ModelPicker onClose={vi.fn()} />)
  return modelControl
}

describe('<ModelPicker/> dismissal', () => {
  it('describes local and remote text models as one active model selection', async () => {
    renderPicker()
    expect(
      await screen.findByText(
        'Your selected Text & Vision model handles chat and supported vision work. Image, Voice, and Transcription use their selected models.'
      )
    ).toBeTruthy()
    expect(screen.queryByText(/swaps the chat model/i)).toBeNull()
    const computerUse = screen.getByRole('region', { name: 'Computer Use' })
    expect(computerUse.textContent).toContain('Text + Specialist')
    expect(computerUse.textContent).toContain('Reasoner')
    expect(computerUse.textContent).toContain('Qwen Reasoner')
    expect(computerUse.textContent).toContain('Remote')
    expect(computerUse.textContent).toContain('Grounding specialist')
    expect(computerUse.textContent).toContain('UI-TARS 1.5 7B')
    expect(computerUse.textContent).toContain('On device')
  })

  it('shows and activates a saved remote model through the shared model seam', async () => {
    const modelControl = renderPickerWithRemote()
    const button = (await screen.findByText('google/gemma-4')).closest('button')
    expect(button).toBeTruthy()
    fireEvent.click(button as HTMLButtonElement)
    // The saved remote model really holds the Text & Vision route now. `activateModel` was the
    // pre-cutover door for this; the picker issues one `activate` intent through model control.
    await waitFor(() => expect(modelControl.projection().active.text.modelId).toBe(REMOTE_MODEL_ID))
    expect(modelControl.intents).toContainEqual({
      type: 'activate',
      modelId: REMOTE_MODEL_ID,
      surface: 'text'
    })
    expect(await screen.findByText('Remote')).toBeTruthy()
  })

  it('closes on Escape', () => {
    const onClose = renderPicker()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes from the accessible icon control', () => {
    const onClose = renderPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the backdrop is clicked', () => {
    const onClose = renderPicker()
    fireEvent.click(screen.getByTestId('side-panel-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes before opening model settings', () => {
    const sequence: string[] = []
    const onClose = vi.fn(() => sequence.push('close'))
    renderPicker(onClose)
    const opened: Array<{ tab?: string }> = []
    const onOpen = (event: Event): void => {
      sequence.push('open')
      opened.push((event as CustomEvent<{ tab?: string }>).detail)
    }
    window.addEventListener(OPEN_MODEL_SETTINGS_PANEL_EVENT, onOpen, { once: true })

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(opened).toEqual([{ tab: 'model' }])
    expect(sequence).toEqual(['close', 'open'])
  })

  it('does not close when the panel content is clicked', () => {
    const onClose = renderPicker()
    fireEvent.click(screen.getByRole('dialog', { name: 'Active models' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('moves focus into the panel, traps it, and restores the opener', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    renderPicker()
    const panel = screen.getByRole('dialog', { name: 'Active models' })

    const disabled = document.createElement('button')
    disabled.disabled = true
    disabled.tabIndex = 0
    panel.appendChild(disabled)

    await waitFor(() => expect(document.activeElement).toBe(panel))
    await screen.findByRole('button', { name: /Qwen 3\.5 2B/ })
    const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    expect(first).toBeTruthy()
    expect(last).toBeTruthy()
    expect(first).not.toBe(last)
    expect(first).not.toBe(disabled)
    expect(last).not.toBe(disabled)

    last?.focus()
    fireEvent.keyDown(last as HTMLElement, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    first?.focus()
    fireEvent.keyDown(first as HTMLElement, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    cleanup()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
