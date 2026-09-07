// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sidebar, SidebarBody } from '../sidebar'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Desktop sidebar width', () => {
  it.each([640, 1_600])('keeps the navigation present at a %ipx viewport', async (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    const view = render(
      <Sidebar open={false} setOpen={() => {}}>
        <SidebarBody data-testid="desktop-sidebar">Navigation</SidebarBody>
      </Sidebar>
    )

    const sidebar = screen.getByTestId('desktop-sidebar')
    expect(sidebar.getAttribute('data-state')).toBe('collapsed')
    view.rerender(
      <Sidebar open setOpen={() => {}}>
        <SidebarBody data-testid="desktop-sidebar">Navigation</SidebarBody>
      </Sidebar>
    )
    expect(sidebar.getAttribute('data-state')).toBe('expanded')
  })

  it('removes the width transition when reduced motion is requested', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
    render(
      <Sidebar open setOpen={() => {}}>
        <SidebarBody data-testid="desktop-sidebar">Navigation</SidebarBody>
      </Sidebar>
    )

    await waitFor(() =>
      expect(screen.getByTestId('desktop-sidebar').getAttribute('data-motion')).toBe('reduced')
    )
  })
})
