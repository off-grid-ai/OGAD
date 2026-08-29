// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ModelPicker } from '../ModelPicker'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderPicker(onClose = vi.fn()): ReturnType<typeof vi.fn> {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getModelCatalog: vi.fn().mockResolvedValue({
      models: [
        {
          id: 'local/qwen',
          name: 'Qwen 3.5 2B',
          kind: 'text',
          files: [{ name: 'qwen.gguf', role: 'primary' }]
        }
      ]
    }),
    getInstalledModels: vi.fn().mockResolvedValue(['local/qwen']),
    getActiveModel: vi.fn().mockResolvedValue(null),
    getActiveModalities: vi.fn().mockResolvedValue({}),
    getActiveModelIds: vi.fn().mockResolvedValue([])
  }
  render(<ModelPicker onClose={onClose} />)
  return onClose
}

function renderPickerWithRemote(): ReturnType<typeof vi.fn> {
  const activateModel = vi.fn().mockResolvedValue({ success: true })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getModelCatalog: vi.fn().mockResolvedValue({
      models: [
        {
          id: 'remote-vision:home:google%2Fgemma-4',
          name: 'google/gemma-4',
          kind: 'vision',
          files: [],
          remoteServerId: 'home'
        }
      ]
    }),
    getInstalledModels: vi.fn().mockResolvedValue(['remote-vision:home:google%2Fgemma-4']),
    getActiveModel: vi.fn().mockResolvedValue(null),
    getActiveModalities: vi.fn().mockResolvedValue({}),
    getActiveModelIds: vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['remote-vision:home:google%2Fgemma-4']),
    activateModel
  }
  render(<ModelPicker onClose={vi.fn()} />)
  return activateModel
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
    expect(screen.queryByRole('region', { name: 'Computer Use' })).toBeNull()
  })

  it('shows and activates a saved remote model through the shared model seam', async () => {
    const activateModel = renderPickerWithRemote()
    const button = (await screen.findByText('google/gemma-4')).closest('button')
    expect(button).toBeTruthy()
    fireEvent.click(button as HTMLButtonElement)
    await waitFor(() =>
      expect(activateModel).toHaveBeenCalledWith('remote-vision:home:google%2Fgemma-4')
    )
    expect(await screen.findByText('Remote')).toBeTruthy()
  })

  it('closes on Escape', () => {
    const onClose = renderPicker()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the backdrop is clicked', () => {
    const onClose = renderPicker()
    fireEvent.click(screen.getByTestId('side-panel-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
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
