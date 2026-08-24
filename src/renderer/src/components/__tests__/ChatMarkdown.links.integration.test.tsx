// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatMarkdown } from '../ChatMarkdown'

describe('ChatMarkdown links', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('opens a supported Markdown link through Electron and refuses unsafe links', () => {
    const openExternal = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { openExternal }
    })

    render(
      <ChatMarkdown content="[Docs](https://example.com/docs) [Unsafe](javascript:alert(1))" />
    )
    fireEvent.click(screen.getByRole('link', { name: 'Docs' }))
    fireEvent.click(screen.getByText('Unsafe'))

    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs')
  })
})
