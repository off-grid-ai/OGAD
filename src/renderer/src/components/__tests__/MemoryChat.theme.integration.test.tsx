// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'

describe('<MemoryChat/> theme surfaces', () => {
  beforeEach(() => {
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0)
      return 1
    }
  })

  afterEach(() => {
    cleanup()
    delete document.documentElement.dataset.theme
    vi.unstubAllGlobals()
  })

  it.each(['light', 'dark'] as const)(
    'renders preset cards and the composer from semantic tokens in %s theme',
    async (theme) => {
      document.documentElement.dataset.theme = theme
      const boundary = new ChatBoundary()
      installBoundary(boundary)
      renderChat({ conversationId: 'conversation-a' })

      const composer = await screen.findByTestId('chat-composer')
      const hero = screen.getByTestId('chat-empty-hero')
      const preset = screen.getByTestId('explore-preset-find-flight')

      expect(composer.className).toContain('bg-card')
      expect(composer.className).toContain('border-input')
      expect(composer.className).not.toContain('bg-neutral-950')
      expect(composer.getAttribute('data-focus-surface')).toBe('chat-composer')
      expect(composer.parentElement?.className).toBe('w-full')
      expect(hero.className).toContain('bg-card')
      expect(preset.className).toContain('bg-background')
      expect(preset.className).toContain('border-border')
      expect(preset.className).not.toContain('bg-neutral-950')
    }
  )
})
