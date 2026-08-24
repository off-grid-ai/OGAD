// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
})
