// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'

describe('<MemoryChat/> assistant preset runs', () => {
  beforeEach(() => {
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0)
      return 1
    }
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('selects Assistant when an example is picked inside a fresh chat', async () => {
    installBoundary(new ChatBoundary())
    const user = userEvent.setup()
    renderChat({ projectId: 'project-alpha' })

    await user.click(await screen.findByTestId('explore-preset-price-compare'))
    await screen.findByTestId('preset-intake-price-compare')
    expect(screen.getByRole('button', { name: 'Assistant' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
  })

  it('starts Train My Feed as an Assistant run with the approved bounds', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ presetId: 'train-my-feed' })

    await screen.findByTestId('preset-intake-train-my-feed')
    expect(screen.getByRole('button', { name: 'Assistant' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect((screen.getByLabelText(/Social platform/) as HTMLSelectElement).value).toBe('Instagram')
    expect((screen.getByLabelText(/Learning goal/) as HTMLTextAreaElement).value).toBe(
      'Local and on-device AI models, multimodal LLMs, and private AI assistants serving as an AI chief of staff.'
    )
    expect((screen.getByLabelText('Follow or subscribe') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('Like useful content') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Bookmark useful posts') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Save videos for later') as HTMLInputElement).checked).toBe(true)
    expect(
      (screen.getByLabelText('Mark irrelevant items Not interested') as HTMLInputElement).checked
    ).toBe(true)
    expect((screen.getByLabelText(/Session length/) as HTMLSelectElement).value).toBe('30 minutes')
    expect((screen.getByLabelText(/Creator follow limit/) as HTMLSelectElement).value).toBe(
      'Do not follow creators'
    )
    expect((screen.getByLabelText(/Related concepts/) as HTMLTextAreaElement).value).toBe(
      'Edge AI, small language models, local inference, autonomous AI agents, privacy-preserving AI'
    )
    expect((screen.getByLabelText(/^Avoid/) as HTMLTextAreaElement).value).toBe(
      'Generic AI hype, clickbait reels, get-rich-quick tutorials, lifestyle vlogs, low-effort promotional content, non-private cloud tools, memes'
    )
    fireEvent.change(screen.getByLabelText(/Learning goal/), {
      target: { value: 'Local AI models' }
    })
    await user.selectOptions(screen.getByLabelText(/Session length/), '45 minutes')
    const start = screen.getByRole('button', { name: 'Start in chat' }) as HTMLButtonElement
    expect(start.disabled).toBe(false)
    await user.selectOptions(screen.getByLabelText(/Social platform/), 'YouTube')
    expect((screen.getByLabelText('Search for topics') as HTMLInputElement).checked).toBe(true)
    expect(
      (screen.getByLabelText('Watch or read relevant content') as HTMLInputElement).checked
    ).toBe(true)
    await user.click(screen.getByLabelText('Follow or subscribe'))
    expect(start.disabled).toBe(false)
    await user.click(start)

    await waitFor(() => expect(boundary.api.createRagConversation).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(boundary.toolQueries).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Assistant' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(boundary.toolQueries[0]?.query).toContain('A: Local AI models')
    expect(boundary.toolQueries[0]?.query).toContain('A: 45 minutes')
    expect(boundary.toolQueries[0]?.query).toContain('A: YouTube')
    expect(boundary.toolQueries[0]?.query).toContain('Follow or subscribe to creators')
    expect(boundary.toolQueries[0]?.query).toContain('Like useful content')
    expect(boundary.toolQueries[0]?.query).toContain('Bookmark useful posts')
    expect(boundary.toolQueries[0]?.query).toContain('Save videos for later')
    expect(boundary.toolQueries[0]?.query).toContain('Mark irrelevant recommendations')
    expect(boundary.toolQueries[0]?.query).toContain('default browser')
    expect(boundary.toolQueries[0]?.query).toContain('Do not use Web Use')
    expect(boundary.toolQueries[0]?.query).toContain('open_url')
    expect(boundary.toolQueries[0]?.query).toContain('computer_use once')
    expect(boundary.toolQueries[0]?.query).toContain('complete successfully')
    expect(boundary.toolQueries[0]?.query).toContain(
      'Never search for avoided or irrelevant material'
    )
    expect(boundary.toolQueries[0]?.query).toContain(
      'never make finding or marking it a plan stage'
    )
    expect(boundary.toolQueries[0]?.query).toContain('Do not make reporting a plan stage')
    expect(boundary.toolQueries[0]?.query).toContain('Do not summarize content')
  })

  it('directs an Instagram feed run to keyword URLs using the chosen topic', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ presetId: 'train-my-feed' })

    await screen.findByTestId('preset-intake-train-my-feed')
    fireEvent.change(screen.getByLabelText(/Learning goal/), {
      target: { value: 'Local AI models' }
    })
    await user.selectOptions(screen.getByLabelText(/Social platform/), 'Instagram')
    await user.click(screen.getByRole('button', { name: 'Start in chat' }))

    await waitFor(() => expect(boundary.toolQueries).toHaveLength(1))
    expect(boundary.toolQueries[0]?.query).toContain('A: Instagram')
    expect(boundary.toolQueries[0]?.query).toContain('A: Local AI models')
    expect(boundary.toolQueries[0]?.query).toContain(
      'https://www.instagram.com/explore/search/keyword/?q=<URL-encoded search phrase>'
    )
    expect(boundary.toolQueries[0]?.query).toContain('URL-encoded search phrase')
    expect(boundary.toolQueries[0]?.query).not.toContain('q=offgridai')
  })

  it('starts a nearby search from the current location by default', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ presetId: 'best-nearby' })

    const form = await screen.findByTestId('preset-intake-best-nearby')
    expect((screen.getByLabelText(/Starting location/) as HTMLInputElement).value).toBe(
      'Use my current location'
    )
    fireEvent.change(screen.getByLabelText(/What are you looking for/), {
      target: { value: 'Quiet Japanese restaurant' }
    })
    const start = screen.getByRole('button', { name: 'Start in chat' }) as HTMLButtonElement
    expect(
      [
        ...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          '[required]'
        )
      ].map((control) => [control.id, control.value])
    ).toEqual([
      ['preset-field-location', 'Use my current location'],
      ['preset-field-category', 'Quiet Japanese restaurant'],
      ['preset-field-when', 'Open now'],
      ['preset-field-range', 'Within 20 minutes by car']
    ])
    expect(start.disabled).toBe(false)
    await user.click(start)

    await waitFor(() => expect(boundary.api.createRagConversation).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(boundary.toolQueries).toHaveLength(1))
    expect(boundary.toolQueries[0]?.query).toContain('call get_current_location')
    expect(boundary.toolQueries[0]?.query).toContain('A: Use my current location')
  })
})
