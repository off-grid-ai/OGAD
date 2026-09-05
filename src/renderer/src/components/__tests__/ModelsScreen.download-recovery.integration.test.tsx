// @vitest-environment jsdom

/**
 * A failed model transfer can recover without leaving the Models route. The Electron preload is
 * the only fake boundary: Shared model-control projections and download events enter the real
 * ModelsScreen, and the user observes the terminal installed state after retrying.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ModelControlCatalogModel, ModelControlProjection } from '@offgrid/application'
import { modelControlSnapshot } from './harness/model-control-snapshot'

const MODEL = {
  id: 'acme/recoverable-model',
  name: 'Recoverable Model',
  kind: 'language',
  org: 'Acme',
  params: 3,
  artifacts: [{ name: 'recoverable.gguf', role: 'primary', sizeBytes: 2_000_000_000 }]
} satisfies ModelControlCatalogModel

type ProgressEvent = Parameters<typeof window.api.onModelProgress>[0] extends (
  event: infer Event
) => void
  ? Event
  : never

let projection: ModelControlProjection
let progressListeners: Array<(event: ProgressEvent) => void> = []
let projectionListeners: Array<(next: ModelControlProjection) => void> = []
let attempt = 0
let ModelsScreen: typeof import('../ModelsScreen').ModelsScreen

function publishProgress(event: ProgressEvent): void {
  for (const listener of progressListeners) listener(event)
}

function publishProjection(next: ModelControlProjection): void {
  projection = next
  for (const listener of projectionListeners) listener(next)
}

beforeAll(async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      systemHealth: async () => ({ ramGb: 16 }),
      getModelControlProjection: async () => projection,
      onModelControlProjection: (listener: (next: ModelControlProjection) => void) => {
        projectionListeners.push(listener)
        return () => {
          projectionListeners = projectionListeners.filter((candidate) => candidate !== listener)
        }
      },
      onModelProgress: (listener: (event: ProgressEvent) => void) => {
        progressListeners.push(listener)
        return () => {
          progressListeners = progressListeners.filter((candidate) => candidate !== listener)
        }
      },
      controlModel: async (intent: { type: string; operationId: string }) => {
        if (intent.type === 'refresh') {
          return {
            ok: true,
            value: { status: 'completed', operationId: intent.operationId, projection }
          }
        }
        attempt += 1
        if (attempt === 1) {
          return {
            ok: false,
            failure: { kind: 'interrupted', reason: 'network connection ended' }
          }
        }

        const installed = { ...projection, installed: [MODEL.id] }
        publishProjection(installed)
        publishProgress({
          downloadId: 'download:recoverable',
          modelId: MODEL.id,
          fileName: MODEL.artifacts[0].name,
          status: 'completed'
        })
        return {
          ok: true,
          value: { status: 'completed', operationId: intent.operationId, projection: installed }
        }
      },
      getModelVisionStatus: async () => ({}),
      estimateModelFit: async () => ({ level: 'ok', message: '' })
    }
  })
  ;({ ModelsScreen } = await import('../ModelsScreen'))
})

afterEach(() => {
  cleanup()
  attempt = 0
  progressListeners = []
  projectionListeners = []
})

describe('<ModelsScreen/> model download recovery', () => {
  it('shows an interrupted download and installs the model after the user retries', async () => {
    projection = modelControlSnapshot({ kinds: ['language'], models: [MODEL] })
    const user = userEvent.setup()
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))

    expect(await screen.findByText(/download stopped before it finished/i)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('button', { name: 'Use' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})
