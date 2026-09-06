// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'
import { invalidateLlmSettings } from '../../lib/settings-invalidation'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const catalog = {
  models: [{ id: 'local/model-a', name: 'Model A', kind: 'text', files: [] }]
}

function composerModelChip(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button.rounded-full')].find((button) =>
    button.textContent?.includes('Model A')
  )
}

describe('<MemoryChat/> active model summary lifecycle', () => {
  beforeEach(() => {
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it.each(['catalog', 'active model', 'LLM settings'])(
    '%s failure leaves no stale model chip',
    async (failure) => {
      const boundary = new ChatBoundary()
      const getModelCatalog = vi.fn(async () => {
        if (failure === 'catalog') throw new Error('catalog unavailable')
        return catalog
      })
      const getActiveModel = vi.fn(async () => {
        if (failure === 'active model') throw new Error('selection unavailable')
        return 'local/model-a'
      })
      const getLlmSettings = vi.fn(async () => {
        if (failure === 'LLM settings') throw new Error('settings unavailable')
        return { ctxSize: 8192 }
      })
      Object.assign(boundary.api, {
        getModelCatalog,
        getActiveModel,
        getLlmSettings
      })
      installBoundary(boundary)

      const view = renderChat({ conversationId: 'conversation-b' })

      await waitFor(() => expect(getModelCatalog).toHaveBeenCalledOnce())
      await waitFor(() => expect(composerModelChip(view.container)).toBeUndefined())
      expect((await screen.findByRole('alert')).textContent).toContain('Model status unavailable')
    }
  )

  it('clears the current model identity and renders the projection failure when refresh fails', async () => {
    const boundary = new ChatBoundary()
    let failSettings = false
    Object.assign(boundary.api, {
      getModelCatalog: vi.fn(async () => catalog),
      getInstalledModels: vi.fn(async () => ['local/model-a']),
      getActiveModel: vi.fn(async () => 'local/model-a'),
      getActiveModalities: vi.fn(async () => ({})),
      getLlmSettings: vi.fn(async () => {
        if (failSettings) throw new Error('settings unavailable')
        return { ctxSize: 8192 }
      })
    })
    installBoundary(boundary)
    const user = userEvent.setup()
    const view = renderChat({ conversationId: 'conversation-b' })

    const chip = await screen.findByRole('button', { name: /^Model A/ })
    failSettings = true
    await user.click(chip)

    await waitFor(() => expect(composerModelChip(view.container)).toBeUndefined())
    expect((await screen.findByRole('alert')).textContent).toContain('Model status unavailable')
    expect(screen.getByTitle('settings unavailable')).toBeTruthy()
  })

  it('ignores a catalog failure that settles after the user leaves chat', async () => {
    const boundary = new ChatBoundary()
    const pending = deferred<typeof catalog>()
    Object.assign(boundary.api, {
      getModelCatalog: vi.fn(() => pending.promise),
      getActiveModel: vi.fn(async () => 'local/model-a'),
      getLlmSettings: vi.fn(async () => ({ ctxSize: 8192 }))
    })
    installBoundary(boundary)
    const view = renderChat({ conversationId: 'conversation-b' })

    view.unmount()
    pending.reject(new Error('late catalog failure'))

    await Promise.resolve()
    expect(screen.queryByRole('button', { name: /Model A/ })).toBeNull()
  })

  it('updates the open composer when the committed context window changes', async () => {
    const boundary = new ChatBoundary()
    let settings = { ctxSize: 32768, effectiveCtxSize: 32768 }
    Object.assign(boundary.api, {
      getModelCatalog: vi.fn(async () => catalog),
      getInstalledModels: vi.fn(async () => ['local/model-a']),
      getActiveModel: vi.fn(async () => 'local/model-a'),
      getActiveModalities: vi.fn(async () => ({})),
      getLlmSettings: vi.fn(async () => settings)
    })
    installBoundary(boundary)

    renderChat({ conversationId: 'conversation-b' })
    expect(await screen.findByRole('button', { name: /Model A.*32K/ })).toBeTruthy()

    settings = { ctxSize: 8192, effectiveCtxSize: 8192 }
    invalidateLlmSettings()

    expect(await screen.findByRole('button', { name: /Model A.*8K/ })).toBeTruthy()
  })

  it('disables Thinking when the active model lacks support', async () => {
    const boundary = new ChatBoundary()
    Object.assign(boundary.api, {
      getModelCatalog: vi.fn(async () => ({
        models: [
          {
            id: 'local/model-a',
            name: 'Model A',
            kind: 'text',
            files: [],
            capabilities: { thinking: false }
          }
        ]
      })),
      getActiveModel: vi.fn(async () => 'local/model-a'),
      getLlmSettings: vi.fn(async () => ({ ctxSize: 8192 })),
      getSettings: vi.fn(async () => ({ composerThinking: true }))
    })
    installBoundary(boundary)

    renderChat({ conversationId: 'conversation-b' })

    const thinking = (await screen.findByRole('button', {
      name: /Thinking unavailable for Model A/
    })) as HTMLButtonElement
    await waitFor(() => expect(thinking.disabled).toBe(true))
    expect(thinking.className).not.toContain('border-green-500')
  })

  it('shows model loading status and keeps Thinking disabled until projection is ready', async () => {
    const boundary = new ChatBoundary()
    const pending = deferred<typeof catalog>()
    Object.assign(boundary.api, {
      getModelCatalog: vi.fn(() => pending.promise),
      getActiveModel: vi.fn(async () => 'local/model-a'),
      getLlmSettings: vi.fn(async () => ({ ctxSize: 8192 }))
    })
    installBoundary(boundary)

    renderChat({ conversationId: 'conversation-b' })

    expect((await screen.findByRole('status')).textContent).toContain('Loading model status')
    const thinking = screen.getByRole('button', {
      name: /Thinking unavailable while model status loads/
    }) as HTMLButtonElement
    expect(thinking.disabled).toBe(true)

    pending.resolve(catalog)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })
})
