// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ModelPicker } from '../ModelPicker'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderPicker(onClose = vi.fn()) {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getModelCatalog: vi.fn().mockResolvedValue({ models: [] }),
    getInstalledModels: vi.fn().mockResolvedValue([]),
    getActiveModel: vi.fn().mockResolvedValue(null),
    getActiveModalities: vi.fn().mockResolvedValue({})
  }
  render(<ModelPicker onClose={onClose} />)
  return onClose
}

describe('<ModelPicker/> dismissal', () => {
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

    await waitFor(() => expect(document.activeElement).toBe(panel))
    const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    expect(first).toBeTruthy()
    expect(last).toBeTruthy()

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
