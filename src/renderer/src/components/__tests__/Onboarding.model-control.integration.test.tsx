// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Onboarding } from '../Onboarding'

class TestStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

beforeEach(() => {
  const storage = new TestStorage()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
})

afterEach(() => {
  cleanup()
})

describe('rendered multimodal onboarding journey', () => {
  it('explains local and remote models, named Desktop control, and credential custody', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    const { container } = render(<Onboarding onComplete={onComplete} />)
    const renderedText = (): string => container.textContent?.replace(/\s+/g, ' ') ?? ''

    expect(renderedText()).toContain('Local models and your data need no Off Grid AI cloud')

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(renderedText()).toContain('Choose what runs on your device.'))
    expect(renderedText()).toContain('run Computer Use with local models')
    expect(renderedText()).toContain('browse with Web Use')
    expect(renderedText()).toContain('Add a model server only when you want one')

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(renderedText()).toContain('Then it starts remembering'))
    expect(renderedText()).toContain('Web Use and Computer Use')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(renderedText()).toContain('Your devices work as one'))
    expect(renderedText()).toContain('choose a paired Desktop by name')
    expect(renderedText()).toContain(
      'See and switch the active Chat, Image, Transcription, Voice, and Computer Use model'
    )

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(renderedText()).toContain('You choose where each model runs'))
    expect(renderedText()).toContain(
      'Personal Mesh does not copy server API keys to Off Grid AI Mobile'
    )
    expect(onComplete).not.toHaveBeenCalled()
  })
})
