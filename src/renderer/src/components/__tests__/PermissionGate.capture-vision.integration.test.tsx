// @vitest-environment jsdom

/**
 * Pro capture readiness through the rendered shell boundary. The Electron preload is the only
 * boundary fake: a running capture pipeline with a non-vision active model must tell the user
 * what is missing and make the recovery action reachable without discovering the Models screen.
 *
 * Projector repair state crosses the bridge as the Shared operations projection
 * (`getModelOperationsProjection` / `onModelOperationsProjection`), reduced here from the same
 * `ModelsEvent`s the main process emits, so the gate renders exactly what production would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PermissionGate } from '../PermissionGate'
import { modelControlSnapshot } from './harness/model-control-snapshot'
import {
  EMPTY_MODELS_OPERATIONS,
  failed,
  ok,
  reduceModelsOperations,
  type ModelsEvent,
  type ModelsOperationsSnapshot
} from '@offgrid/application'

const MODEL_ID = 'unsloth/gemma-4-E2B-it-GGUF'
let visionStatus: Record<string, { supportsVision: boolean; projectorInstalled: boolean }>
let controlModel: ReturnType<typeof vi.fn>
let captureStatus: { running: boolean; paused: boolean; visionReady: boolean }
let proListeners: Map<string, () => void>
let operations: ModelsOperationsSnapshot
let operationListeners: Set<(snapshot: ModelsOperationsSnapshot) => void>
const pendingRepairs: Array<() => void> = []

/** Feed one main-process lifecycle event through the Shared reducer and publish it over the bridge. */
function emit(event: ModelsEvent): void {
  operations = reduceModelsOperations(operations, event)
  for (const listener of operationListeners) listener(operations)
}

function repairProgress(operationId: string, bytesDownloaded: number, totalBytes: number): void {
  emit({
    type: 'model_projector_repair_progress',
    operationId,
    modelId: MODEL_ID,
    bytesDownloaded,
    totalBytes
  })
}

function completedRepair(): ReturnType<typeof ok> {
  return ok({
    status: 'completed' as const,
    operationId: 'repair-projector',
    projection: modelControlSnapshot({ kinds: ['vision'], models: [] })
  })
}

/** A repair whose bridge call stays in flight until the test settles it, as a real download does. */
function holdRepair(): Promise<ReturnType<typeof ok>> {
  return new Promise((resolve) => {
    pendingRepairs.push(() => resolve(completedRepair()))
  })
}

beforeEach(() => {
  visionStatus = {}
  operations = EMPTY_MODELS_OPERATIONS
  operationListeners = new Set()
  controlModel = vi.fn(async () => completedRepair())
  captureStatus = { running: true, paused: false, visionReady: false }
  proListeners = new Map()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      isPro: true,
      getPermissionStatus: async () => ({
        accessibility: true,
        screenRecording: true,
        microphone: true,
        allGranted: true
      }),
      checkModelStatus: async () => ({
        configured: true,
        downloaded: true,
        modelsDir: '/tmp/models'
      }),
      getModelControlProjection: async () =>
        modelControlSnapshot({
          kinds: ['vision'],
          models: [{ id: MODEL_ID, name: 'Gemma 4', kind: 'vision', files: [] }],
          installed: [MODEL_ID],
          activeIds: [MODEL_ID],
          active: { text: MODEL_ID }
        }),
      getModelOperationsProjection: async () => operations,
      onModelOperationsProjection: (listener: (snapshot: ModelsOperationsSnapshot) => void) => {
        operationListeners.add(listener)
        return () => operationListeners.delete(listener)
      },
      getActiveModel: async () => MODEL_ID,
      getModelCatalog: async () => ({ models: [{ id: MODEL_ID, name: 'Gemma 4' }] }),
      getModelVisionStatus: async () => visionStatus,
      proInvoke: async (channel: string) => {
        if (channel === 'capture:status') {
          return captureStatus
        }
        return null
      },
      proOn: (channel: string, callback: () => void) => {
        proListeners.set(channel, callback)
        return () => proListeners.delete(channel)
      },
      onModelProgress: () => () => undefined,
      controlModel
    }
  })
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    for (const settle of pendingRepairs.splice(0)) settle()
  })
})

describe('<PermissionGate/> Pro capture vision recovery', () => {
  it('offers the missing projector download from the app shell', async () => {
    visionStatus = { [MODEL_ID]: { supportsVision: true, projectorInstalled: false } }
    const user = userEvent.setup()
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    expect(await screen.findByText('Capture needs vision support')).toBeTruthy()
    expect(
      screen.getByText('Gemma 4 can read images after its vision projector is downloaded.')
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Download vision support' }))
    expect(controlModel).toHaveBeenCalledWith({ type: 'repair-projector', modelId: MODEL_ID })
  })

  it('routes a text-only active model to model selection', async () => {
    const navigate = vi.fn()
    window.addEventListener('og:navigate', navigate)
    const user = userEvent.setup()
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    expect(await screen.findByText('Capture needs a vision model')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Choose model' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce())
    expect((navigate.mock.calls[0]?.[0] as CustomEvent).detail).toBe('models')
    window.removeEventListener('og:navigate', navigate)
  })

  it('surfaces a new capture vision problem when the running pipeline reports a change', async () => {
    captureStatus = { running: true, paused: false, visionReady: true }
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    await screen.findByText('App shell')
    expect(screen.queryByText('Capture needs a vision model')).toBeNull()

    captureStatus = { running: true, paused: false, visionReady: false }
    proListeners.get('capture:changed')?.()

    expect(await screen.findByText('Capture needs a vision model')).toBeTruthy()
  })

  it('does not misdirect a configured vision model during a transient pipeline mismatch', async () => {
    visionStatus = { [MODEL_ID]: { supportsVision: true, projectorInstalled: true } }
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    await screen.findByText('App shell')
    await waitFor(() => {
      expect(screen.queryByText('Capture needs a vision model')).toBeNull()
      expect(screen.queryByText('Capture needs vision support')).toBeNull()
    })
  })

  it('shows projector download progress and restores the action after failure or cancellation', async () => {
    visionStatus = { [MODEL_ID]: { supportsVision: true, projectorInstalled: false } }
    controlModel.mockImplementation(() => holdRepair())
    const user = userEvent.setup()
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    await user.click(await screen.findByRole('button', { name: 'Download vision support' }))
    // The first tick of a real download: the job exists but no content length is known yet.
    emit({ type: 'model_projector_repair_started', operationId: 'repair-1', modelId: MODEL_ID })
    repairProgress('repair-1', 0, 0)
    expect(
      ((await screen.findByRole('button', { name: 'Downloading 0%' })) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(
      screen.getByText(/0 bytes downloaded - Total size unavailable.*Rate unavailable/)
    ).toBeTruthy()

    repairProgress('repair-1', 42, 100)
    expect(
      ((await screen.findByRole('button', { name: 'Downloading 42%' })) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(screen.getByText(/42 bytes of 100 bytes.*Rate unavailable/)).toBeTruthy()

    emit({
      type: 'model_projector_repair_failed',
      failed: true,
      operationId: 'repair-1',
      modelId: MODEL_ID,
      failure: { kind: 'runtime', message: 'The projector archive could not be verified.' }
    })
    expect(
      (
        (await screen.findByRole('button', {
          name: 'Download vision support'
        })) as HTMLButtonElement
      ).disabled
    ).toBe(false)
    expect(screen.getByText('The projector archive could not be verified.')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Download vision support' }))
    expect(controlModel).toHaveBeenCalledTimes(2)
    emit({ type: 'model_projector_repair_started', operationId: 'repair-2', modelId: MODEL_ID })
    repairProgress('repair-2', 65, 100)
    expect(
      ((await screen.findByRole('button', { name: 'Downloading 65%' })) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    emit({ type: 'model_projector_repair_cancelled', operationId: 'repair-2', modelId: MODEL_ID })
    expect(
      (
        (await screen.findByRole('button', {
          name: 'Download vision support'
        })) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })

  it('shows why the write door refused the repair instead of leaving the click silent', async () => {
    visionStatus = { [MODEL_ID]: { supportsVision: true, projectorInstalled: false } }
    // A refusal at the door. The real Shared control owner emits `model_control_started` and
    // `model_control_failed` for every refusal, so the canonical operations projection carries the
    // failure - the hook reads it from there, not from the command's return value. The fake mirrors
    // that door contract exactly.
    const failure = {
      kind: 'runtime' as const,
      message: 'No projector is published for this model.'
    }
    controlModel.mockImplementation(async () => {
      emit({
        type: 'model_control_started',
        operationId: 'refused-1',
        operation: 'repair-projector',
        modelId: MODEL_ID
      })
      emit({
        type: 'model_control_failed',
        failed: true,
        operationId: 'refused-1',
        operation: 'repair-projector',
        modelId: MODEL_ID,
        failure
      })
      return failed(failure)
    })
    const user = userEvent.setup()
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    await user.click(await screen.findByRole('button', { name: 'Download vision support' }))

    expect(await screen.findByText('No projector is published for this model.')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Download vision support' }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it('clears the setup nudge when the projector download completes', async () => {
    visionStatus = { [MODEL_ID]: { supportsVision: true, projectorInstalled: false } }
    controlModel.mockImplementation(async () => {
      emit({ type: 'model_projector_repair_started', operationId: 'repair-1', modelId: MODEL_ID })
      captureStatus = { running: true, paused: false, visionReady: true }
      visionStatus = { [MODEL_ID]: { supportsVision: true, projectorInstalled: true } }
      emit({
        type: 'model_projector_repair_succeeded',
        operationId: 'repair-1',
        modelId: MODEL_ID,
        localUri: '/tmp/models/mmproj.gguf'
      })
      return completedRepair()
    })
    const user = userEvent.setup()
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    expect(await screen.findByText('Capture needs vision support')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Download vision support' }))

    await waitFor(() => expect(screen.queryByText('Capture needs vision support')).toBeNull())
    expect(screen.getByText('App shell')).toBeTruthy()
  })
})
