// @vitest-environment jsdom

import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'

describe('<MemoryChat/> attachment intake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    Object.defineProperty(File.prototype, 'arrayBuffer', {
      configurable: true,
      value: async () => new TextEncoder().encode('Atlas release notes').buffer
    })
  })

  afterEach(() => cleanup())

  it('rejects an unsupported image while keeping a readable text attachment usable', async () => {
    const boundary = new ChatBoundary()
    const processFile = vi.fn(async (_bytes: ArrayBuffer, name: string) => ({
      kind: 'text',
      text: `${name}: Atlas release notes`,
      path: `/tmp/${name}`
    }))
    Object.assign(boundary.api, { processFile })
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    const fileInput = document.querySelector('input[type="file"]:not([accept])')
    if (!(fileInput instanceof HTMLInputElement)) throw new Error('attachment input not found')

    const image = new File(['image'], 'diagram.png', { type: 'image/png' })
    const notes = new File(['notes'], 'release-notes.txt', { type: 'text/plain' })
    await user.upload(fileInput, [image, notes])

    const warning = await screen.findByText(/This model can't read images/i)
    expect(warning).toBeTruthy()
    expect(processFile).toHaveBeenCalledTimes(1)
    expect(processFile.mock.calls[0]?.[0].byteLength).toBeGreaterThan(0)
    expect(processFile.mock.calls[0]?.[1]).toBe('release-notes.txt')
    expect(screen.queryByText('diagram.png')).toBeNull()

    await user.click(await screen.findByTitle('Click to expand'))

    const viewer = screen.getByRole('dialog', { name: 'release-notes.txt' })
    expect(within(viewer).getByText('release-notes.txt: Atlas release notes')).toBeTruthy()

    await user.click(within(viewer).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'release-notes.txt' })).toBeNull()

    const warningRow = warning.closest('div')
    if (!warningRow) throw new Error('attachment warning row not found')
    await user.click(within(warningRow).getByRole('button'))
    expect(screen.queryByText(/This model can't read images/i)).toBeNull()
  })
})
