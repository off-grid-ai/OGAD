// @vitest-environment jsdom

/**
 * A failed model transfer can recover without leaving the Models route. The Electron preload is
 * the only fake boundary: Shared model-control projections and download events enter the real
 * ModelsScreen, and the user observes the terminal installed state after retrying.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type {
  ModelControlArtifact,
  ModelControlCatalogModel,
  ModelControlProjection,
  PublicDownloadInfo
} from '@offgrid/application'
import { modelControlSnapshot } from './harness/model-control-snapshot'
import { ModelsScreen } from '../ModelsScreen'

const PRIMARY_ARTIFACT = {
  name: 'recoverable.gguf',
  role: 'primary',
  sizeBytes: 2_000_000_000
} satisfies ModelControlArtifact

const MODEL: ModelControlCatalogModel = {
  id: 'acme/recoverable-model',
  name: 'Recoverable Model',
  kind: 'text',
  artifacts: [PRIMARY_ARTIFACT]
}

let projection: ModelControlProjection
let projectionListeners: Array<(next: ModelControlProjection) => void> = []
let attempt = 0

function publishProjection(next: ModelControlProjection): void {
  projection = next
  for (const listener of projectionListeners) listener(next)
}

beforeAll(() => {
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

        const completed: PublicDownloadInfo = {
          downloadId: 'download:recoverable',
          modelId: MODEL.id,
          fileName: PRIMARY_ARTIFACT.name,
          bytesDownloaded: PRIMARY_ARTIFACT.sizeBytes,
          totalBytes: PRIMARY_ARTIFACT.sizeBytes,
          status: 'completed',
          localUri: `file:///models/${PRIMARY_ARTIFACT.name}`,
          startedAt: 1
        }
        const installed = { ...projection, installed: [MODEL.id], downloads: [completed] }
        publishProjection(installed)
        return {
          ok: true,
          value: { status: 'completed', operationId: intent.operationId, projection: installed }
        }
      },
      getModelVisionStatus: async () => ({}),
      estimateModelFit: async () => ({ level: 'ok', message: '' })
    }
  })
})

afterEach(() => {
  cleanup()
  attempt = 0
  projectionListeners = []
})

describe('<ModelsScreen/> model download recovery', () => {
  it('shows an interrupted download and installs the model after the user retries', async () => {
    // The harness's download row type predates PublicDownloadInfo (totalBytes/startedAt); this
    // journey starts with no downloads, so the Shared read model is satisfied directly.
    projection = { ...modelControlSnapshot({ kinds: ['text'], models: [MODEL] }), downloads: [] }
    const user = userEvent.setup()
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: 'Download' }))

    expect(await screen.findByText(/download stopped before it finished/i)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('button', { name: 'Use' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})
