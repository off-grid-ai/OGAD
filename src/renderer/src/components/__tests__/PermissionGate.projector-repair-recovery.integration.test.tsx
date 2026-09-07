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
import {
  EMPTY_MODELS_OPERATIONS,
  reduceModelsOperations,
  type ModelsEvent,
  type ModelsOperationsSnapshot
} from '@offgrid/application'

const MODEL_ID = 'acme/vision-model'

class CaptureBoundary {
  private attempts = 0
  private ready = false
  private releaseFirstAttempt: (() => void) | null = null
  private operations: ModelsOperationsSnapshot = EMPTY_MODELS_OPERATIONS
  private operationListeners = new Set<(value: ModelsOperationsSnapshot) => void>()

  private publish(operations: ModelsOperationsSnapshot): void {
    this.operations = operations
    for (const listener of this.operationListeners) listener(operations)
  }

  private emit(event: ModelsEvent): void {
    this.publish(reduceModelsOperations(this.operations, event))
  }

  failFirstAttempt(): void {
    this.releaseFirstAttempt?.()
  }

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
    getModelOperationsProjection: async () => this.operations,
    onModelOperationsProjection: (listener: (value: ModelsOperationsSnapshot) => void) => {
      this.operationListeners.add(listener)
      return () => this.operationListeners.delete(listener)
    },
    getModelVisionStatus: async () => ({
      [MODEL_ID]: { supportsVision: true, projectorInstalled: this.ready }
    }),
    proInvoke: async (channel: string) =>
      channel === 'capture:status'
        ? { running: true, paused: false, visionReady: this.ready }
        : null,
    proOn: () => () => undefined,
    onModelProgress: () => () => undefined,
    controlModel: async () => {
      this.attempts += 1
      if (this.attempts === 1) {
        this.emit({
          type: 'model_projector_repair_started',
          operationId: 'repair-projector-1',
          modelId: MODEL_ID
        })
        this.emit({
          type: 'model_projector_repair_progress',
          operationId: 'repair-projector-1',
          modelId: MODEL_ID,
          bytesDownloaded: 25,
          totalBytes: 100
        })
        await new Promise<void>((resolve) => {
          this.releaseFirstAttempt = resolve
        })
        this.emit({
          type: 'model_projector_repair_failed',
          failed: true,
          operationId: 'repair-projector-1',
          modelId: MODEL_ID,
          failure: { kind: 'runtime', message: 'The projector archive could not be verified.' }
        })
        return {
          ok: false,
          failure: { kind: 'runtime', message: 'The projector archive could not be verified.' }
        }
      }
      this.ready = true
      this.emit({
        type: 'model_projector_repair_started',
        operationId: 'repair-projector-2',
        modelId: MODEL_ID
      })
      this.emit({
        type: 'model_projector_repair_succeeded',
        operationId: 'repair-projector-2',
        modelId: MODEL_ID,
        localUri: '/models/projector.gguf'
      })
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

    const activeRepair = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Downloading 25%'
    })
    expect(activeRepair.disabled).toBe(true)
    expect(screen.getByText('25 bytes of 100 bytes · Rate unavailable')).toBeTruthy()
    boundary.failFirstAttempt()

    expect(await screen.findByText('The projector archive could not be verified.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Download vision support' }))

    await waitFor(() => expect(screen.queryByText('Capture needs vision support')).toBeNull())
    expect(screen.getByText('App shell')).toBeTruthy()
  })
})
