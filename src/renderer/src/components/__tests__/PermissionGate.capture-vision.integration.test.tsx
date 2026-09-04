// @vitest-environment jsdom

/**
 * Pro capture readiness through the rendered shell boundary. The Electron preload is the only
 * boundary fake: a running capture pipeline with a non-vision active model must tell the user
 * what is missing and make the recovery action reachable without discovering the Models screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PermissionGate } from '../PermissionGate'
import { modelControlSnapshot } from './harness/model-control-snapshot'
import { ok } from '@offgrid/application'

const MODEL_ID = 'unsloth/gemma-4-E2B-it-GGUF'
let visionStatus: Record<string, { supportsVision: boolean; projectorInstalled: boolean }>
let controlModel: ReturnType<typeof vi.fn>
let captureStatus: { running: boolean; paused: boolean; visionReady: boolean }
let proListeners: Map<string, () => void>
let modelProgress:
  | ((progress: {
      modelId: string
      percent?: number
      downloadedBytes?: number
      totalBytes?: number
      status?: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled'
    }) => void)
  | null

beforeEach(() => {
  visionStatus = {}
  controlModel = vi.fn(async () =>
    ok({
      status: 'completed' as const,
      operationId: 'repair-projector',
      projection: modelControlSnapshot({ kinds: ['vision'], models: [] })
    })
  )
  captureStatus = { running: true, paused: false, visionReady: false }
  proListeners = new Map()
  modelProgress = null
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
      checkModelStatus: async () => ({ downloaded: true, modelsDir: '/tmp/models' }),
      getModelControlProjection: async () =>
        modelControlSnapshot({
          kinds: ['vision'],
          models: [{ id: MODEL_ID, name: 'Gemma 4', kind: 'vision', files: [] }],
          installed: [MODEL_ID],
          activeIds: [MODEL_ID],
          active: { text: MODEL_ID }
        }),
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
      onModelProgress: (callback: typeof modelProgress) => {
        modelProgress = callback
        return () => {
          modelProgress = null
        }
      },
      controlModel
    }
  })
})

afterEach(() => cleanup())

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
    controlModel.mockImplementationOnce(() => new Promise(() => {}))
    const user = userEvent.setup()
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    await user.click(await screen.findByRole('button', { name: 'Download vision support' }))
    expect(
      (screen.getByRole('button', { name: 'Downloading 0%' }) as HTMLButtonElement).disabled
    ).toBe(true)

    modelProgress?.({
      modelId: MODEL_ID,
      percent: 42,
      status: 'downloading',
      downloadedBytes: 42,
      totalBytes: 100
    })
    expect(
      ((await screen.findByRole('button', { name: 'Downloading 42%' })) as HTMLButtonElement)
        .disabled
    ).toBe(true)

    modelProgress?.({ modelId: MODEL_ID, status: 'failed' })
    expect(
      (
        (await screen.findByRole('button', {
          name: 'Download vision support'
        })) as HTMLButtonElement
      ).disabled
    ).toBe(false)

    modelProgress?.({ modelId: MODEL_ID, percent: 65, status: 'downloading' })
    expect(
      ((await screen.findByRole('button', { name: 'Downloading 65%' })) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    modelProgress?.({ modelId: MODEL_ID, status: 'cancelled' })
    expect(
      (
        (await screen.findByRole('button', {
          name: 'Download vision support'
        })) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })

  it('clears the setup nudge when the projector download completes', async () => {
    visionStatus = { [MODEL_ID]: { supportsVision: true, projectorInstalled: false } }
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    expect(await screen.findByText('Capture needs vision support')).toBeTruthy()
    captureStatus = { running: true, paused: false, visionReady: true }
    modelProgress?.({ modelId: MODEL_ID, status: 'completed' })

    await waitFor(() => expect(screen.queryByText('Capture needs vision support')).toBeNull())
  })
})
