// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { KeyboardShortcuts } from '../KeyboardShortcuts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const setPro = (v: boolean | undefined): void => {
  ;(window as any).api = v === undefined ? undefined : { isPro: v }
}

describe('KeyboardShortcuts reference', () => {
  afterEach(() => {
    cleanup()
    setPro(undefined)
  })

  it('always lists the core shortcuts', () => {
    render(<KeyboardShortcuts />)
    expect(screen.getByText('Open command palette')).toBeTruthy()
    expect(screen.getByText('Back')).toBeTruthy()
    expect(screen.getByText('Forward')).toBeTruthy()
    expect(screen.getByText('Zoom in')).toBeTruthy()
    expect(screen.getByText('Zoom out')).toBeTruthy()
    expect(screen.getByText('Reset zoom')).toBeTruthy()
  })

  it('hides pro shortcuts in the free build', () => {
    setPro(false)
    render(<KeyboardShortcuts />)
    expect(screen.queryByText(/Clipboard quick-paste/)).toBeNull()
    expect(screen.queryByText(/Dictation/)).toBeNull()
  })

  it('shows pro shortcuts (clipboard + dictation) when entitled', () => {
    setPro(true)
    render(<KeyboardShortcuts />)
    expect(screen.getByText(/Clipboard quick-paste/)).toBeTruthy()
    expect(screen.getByText(/Dictation/)).toBeTruthy()
  })
})
