// @vitest-environment jsdom

/**
 * Vision-projector repair through the real permission gate. Electron permission, capture, and
 * model-control calls are the only fake boundaries; Shared projects readiness and formats the
 * model failure that the rendered gate shows.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { modelControlSnapshot } from './harness/model-control-snapshot'
import { PermissionGate } from '../PermissionGate'

const MODEL_ID = 'acme/vision-model'

class CaptureBoundary {
  private attempts = 0
  private ready = false
  private progressListener: ((event: unknown) => void) | null = null

  readonly api = {
    isPro: true,
    getPermissionStatus: async () => ({
      accessibility: true,
      screenRecording: true,
      microphone: true,
      localNetwork: true,
      allGranted: true
    }),
    checkModelStatus: async () => ({ configured: true, downloaded: true, modelsDir: '/models' }),
    getModelControlProjection: async () =>
      modelControlSnapshot({
        kinds: ['vision'],
        models: [{ id: MODEL_ID, name: 'Vision Model', kind: 'vision', files: [] }],
        installed: [MODEL_ID],
        activeIds: [MODEL_ID],
        active: { text: MODEL_ID }
      }),
    getModelVisionStatus: async () => ({
      [MODEL_ID]: { supportsVision: true, projectorInstalled: this.ready }
    }),
    proInvoke: async (channel: string) =>
      channel === 'capture:status'
        ? { running: true, paused: false, visionReady: this.ready }
        : null,
    proOn: () => () => undefined,
    onModelProgress: (listener: (event: unknown) => void) => {
      this.progressListener = listener
      return () => {
        this.progressListener = null
      }
    },
    controlModel: async () => {
      this.attempts += 1
      if (this.attempts === 1) {
        return new Promise(() => undefined)
      }
      this.ready = true
      return {
        ok: true,
        value: {
          status: 'completed',
          operationId: 'repair-projector',
          projection: await this.api.getModelControlProjection()
        }
      }
    }
  }

  failDownload(): void {
    this.progressListener?.({
      downloadId: 'projector-download',
      modelId: MODEL_ID,
      fileName: 'projector.gguf',
      status: 'failed',
      reason: 'The projector archive could not be verified.'
    })
  }
}

afterEach(cleanup)

describe('<PermissionGate/> projector repair recovery', () => {
  it('shows the Shared repair failure and clears the nudge after the user retries', async () => {
    const boundary = new CaptureBoundary()
    Object.defineProperty(window, 'api', { configurable: true, value: boundary.api })
    const user = userEvent.setup()
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    expect(await screen.findByText('Capture needs vision support')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Download vision support' }))
    boundary.failDownload()

    expect(await screen.findByText('The projector archive could not be verified.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Download vision support' }))

    await waitFor(() => expect(screen.queryByText('Capture needs vision support')).toBeNull())
    expect(screen.getByText('App shell')).toBeTruthy()
  })
})
