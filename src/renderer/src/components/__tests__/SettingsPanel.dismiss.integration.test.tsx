// @vitest-environment jsdom

// Integration: the REAL chat Settings panel must dismiss on a click-outside (the scrim)
// AND on Escape — not only via its Close button. Renders the actual SettingsPanel; only
// the window.api boundary is stubbed (the panel loads settings/tools/connectors on mount).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { SettingsPanel } from '../SettingsPanel'
import { OPEN_ACTIVE_MODELS_PANEL_EVENT } from '@renderer/lib/model-settings-panel'

beforeEach(() => {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getLlmSettings: vi.fn().mockResolvedValue({}),
    ttsVoices: vi.fn().mockResolvedValue([]),
    prepareTtsVoice: vi.fn().mockResolvedValue({ ready: true }),
    onTtsVoiceProgress: vi.fn(() => vi.fn()),
    listTools: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    mcpList: vi.fn().mockResolvedValue([]),
    saveSetting: vi.fn().mockResolvedValue(undefined)
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('<SettingsPanel/> dismissal', () => {
  it('closes when the click-outside scrim is clicked', () => {
    const onClose = vi.fn()
    render(<SettingsPanel onClose={onClose} />)
    const scrim = screen.getByTestId('side-panel-backdrop')
    fireEvent.click(scrim)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<SettingsPanel onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('still closes via the Close button (unchanged)', () => {
    const onClose = vi.fn()
    render(<SettingsPanel onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes before opening Active models', () => {
    const sequence: string[] = []
    const onClose = vi.fn(() => sequence.push('close'))
    const onOpen = vi.fn(() => sequence.push('open'))
    window.addEventListener(OPEN_ACTIVE_MODELS_PANEL_EVENT, onOpen, { once: true })
    render(<SettingsPanel onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Active models' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(sequence).toEqual(['close', 'open'])
  })

  it('a click INSIDE the panel does not close it', () => {
    const onClose = vi.fn()
    render(<SettingsPanel onClose={onClose} />)
    // The tab strip lives inside the panel; clicking it must not bubble to the scrim.
    fireEvent.click(screen.getByRole('button', { name: /voice/i }))
    expect(onClose).not.toHaveBeenCalled()
  })
})
