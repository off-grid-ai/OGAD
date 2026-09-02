// @vitest-environment jsdom
//
// RELEASE_TEST_CHECKLIST #149 and #152 - large collection and transient-layer
// integration coverage. The production Models screen and shared modal are real;
// only Electron/native calls are provided at the window.api boundary.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal, ModalBody, ModalContent, ModalTrigger } from '../ui/animated-modal'
import { modelControlSnapshot } from './harness/model-control-snapshot'

let ModelsScreen: typeof import('../ModelsScreen').ModelsScreen

const MODELS = Array.from({ length: 120 }, (_, index) => ({
  id: `community/model-${String(index + 1).padStart(3, '0')}`,
  name: `Seeded Model ${String(index + 1).padStart(3, '0')}`,
  kind: index % 12 === 0 ? 'vision' : 'text',
  org: 'community',
  description: `Synthetic catalog entry ${index + 1}`,
  params: (index % 10) + 1,
  files: [{ name: 'model.gguf', url: 'https://example.test/model.gguf', sizeBytes: 1e9 }]
}))

function installBoundary(): void {
  const values: Record<string, unknown> = {
    systemHealth: async () => ({ ramGb: 16 }),
    getModelControlSnapshot: async () =>
      modelControlSnapshot({ kinds: ['text', 'image'], models: MODELS }),
    getModelCatalog: async () => ({ kinds: ['text', 'image'], models: MODELS }),
    getInstalledModels: async () => [],
    getActiveModelIds: async () => [],
    onModelProgress: () => () => {}
  }
  const api = new Proxy(values, {
    get(target, property: string) {
      if (property in target) return target[property]
      return async () => undefined
    }
  })
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
}

function SharedModalHarness(): React.JSX.Element {
  return (
    <div>
      <p>Underlying workspace remains selected</p>
      <Modal>
        <ModalTrigger>Open details modal</ModalTrigger>
        <ModalBody>
          <ModalContent>
            <h2>Transient details</h2>
            <Modal>
              <ModalTrigger>Open nested confirmation</ModalTrigger>
              <ModalBody>
                <ModalContent>
                  <h3>Nested confirmation</h3>
                </ModalContent>
              </ModalBody>
            </Modal>
          </ModalContent>
        </ModalBody>
      </Modal>
    </div>
  )
}

describe('desktop collection and transient-layer integration', () => {
  beforeAll(async () => {
    installBoundary()
    ;({ ModelsScreen } = await import('../ModelsScreen'))
  }, 30_000)

  beforeEach(() => {
    vi.clearAllMocks()
    installBoundary()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps a large synthetic model catalog filterable and its detail panel usable (#149)', async () => {
    const user = userEvent.setup()
    render(<ModelsScreen />)

    expect(await screen.findByText('120 models')).not.toBeNull()
    expect(await screen.findByRole('button', { name: 'Seeded Model 120' })).not.toBeNull()

    await user.click(screen.getByRole('button', { name: 'Coding' }))
    expect(await screen.findByText('84 models')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Seeded Model 001' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Seeded Model 120' }))
    expect(await screen.findByRole('heading', { name: 'Seeded Model 120' })).not.toBeNull()
    expect(screen.getByText('Synthetic catalog entry 120')).not.toBeNull()
  })

  it('Escape closes only the model detail layer and preserves the filtered collection (#152)', async () => {
    const user = userEvent.setup()
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Coding' }))
    await user.click(await screen.findByRole('button', { name: 'Seeded Model 120' }))
    expect(await screen.findByRole('heading', { name: 'Seeded Model 120' })).not.toBeNull()

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Seeded Model 120' })).toBeNull()
    })
    expect(await screen.findByText('84 models')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Coding' })).not.toBeNull()
  })

  it('Escape closes only the top shared modal and restores focus without clearing state (#152)', async () => {
    const user = userEvent.setup()
    render(<SharedModalHarness />)

    const trigger = screen.getByRole('button', { name: 'Open details modal' })
    await user.click(trigger)
    expect(await screen.findByRole('heading', { name: 'Transient details' })).not.toBeNull()

    const nestedTrigger = screen.getByRole('button', { name: 'Open nested confirmation' })
    await user.click(nestedTrigger)
    expect(await screen.findByRole('heading', { name: 'Nested confirmation' })).not.toBeNull()

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Nested confirmation' })).toBeNull()
    })
    expect(screen.getByRole('heading', { name: 'Transient details' })).not.toBeNull()
    expect(document.activeElement).toBe(nestedTrigger)

    await user.keyboard('{Escape}')
    await waitFor(
      () => {
        expect(screen.queryByRole('heading', { name: 'Transient details' })).toBeNull()
      },
      // AnimatePresence keeps the closing layer mounted until the real spring exit
      // finishes. Under full-suite load that can exceed Testing Library's 1s default.
      { timeout: 5_000 }
    )
    expect(screen.getByText('Underlying workspace remains selected')).not.toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
