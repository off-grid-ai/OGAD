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

const MODEL_ID = `model-package-v1:${'a'.repeat(64)}`
const MODEL_NAME = 'Gemma 4 E2B'
let visionStatus: Record<string, { supportsVision: boolean; projectorInstalled: boolean }>
let downloadModel: ReturnType<typeof vi.fn>
let captureStatus: {
  running: boolean
  paused: boolean
  visionReady: boolean
  framesNeedingVision?: number
  visionBlocker?: string | null
  visionServer?: string | null
}
let proListeners: Map<string, () => void>
let modelProgress:
  | ((progress: {
      modelId: string
      percent?: number
      status?: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled'
    }) => void)
  | null

beforeEach(() => {
  visionStatus = {}
  downloadModel = vi.fn(async () => ({ success: true }))
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
      getActiveModel: async () => MODEL_ID,
      getModelCatalog: async () => ({
        kinds: ['vision'],
        models: [{ id: MODEL_ID, name: MODEL_NAME, kind: 'vision', files: [] }]
      }),
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
      downloadModel
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
    await user.click(screen.getByRole('button', { name: 'Download vision support' }))
    expect(downloadModel).toHaveBeenCalledWith(MODEL_ID)
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

    expect(await screen.findByText('Some moments need a vision model')).toBeTruthy()
    expect(
      screen.getByText(
        `Moments without on-screen text wait. ${MODEL_NAME} reads text only; pick one that reads images.`
      )
    ).toBeTruthy()
    expect(screen.queryByText(new RegExp(MODEL_ID))).toBeNull()
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
    expect(screen.queryByText('Some moments need a vision model')).toBeNull()

    captureStatus = { running: true, paused: false, visionReady: false }
    proListeners.get('capture:changed')?.()

    expect(await screen.findByText('Some moments need a vision model')).toBeTruthy()
  })

  it('says how many moments wait, and sends a remote server without screen images to its settings', async () => {
    captureStatus = {
      running: true,
      paused: false,
      visionReady: false,
      framesNeedingVision: 60,
      visionBlocker: 'screen-images-off',
      visionServer: 'RTX Pro 6000'
    }
    const openSettings = vi.fn()
    window.addEventListener('og:open-model-settings-panel', openSettings)
    const user = userEvent.setup()
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    expect(await screen.findByText('Allow screen images')).toBeTruthy()
    expect(
      screen.getByText(
        '60 moments without on-screen text wait. Allow screen images for RTX Pro 6000 to analyze them there.'
      )
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Open settings' }))
    expect((openSettings.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ tab: 'remote' })
    window.removeEventListener('og:open-model-settings-panel', openSettings)
  })

  it('stays quiet when no moment needs a vision model', async () => {
    captureStatus = { running: true, paused: false, visionReady: false, framesNeedingVision: 0 }
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    await screen.findByText('App shell')
    await waitFor(() => expect(screen.queryByText('Some moments need a vision model')).toBeNull())
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
      expect(screen.queryByText('Some moments need a vision model')).toBeNull()
      expect(screen.queryByText('Capture needs vision support')).toBeNull()
    })
  })

  it('shows projector download progress and restores the action after failure or cancellation', async () => {
    visionStatus = { [MODEL_ID]: { supportsVision: true, projectorInstalled: false } }
    downloadModel.mockImplementationOnce(() => new Promise(() => {}))
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

    modelProgress?.({ modelId: MODEL_ID, percent: 42, status: 'downloading' })
    expect(
      ((await screen.findByRole('button', { name: 'Downloading 42%' })) as HTMLButtonElement)
        .disabled
    ).toBe(true)

    modelProgress?.({ modelId: MODEL_ID, status: 'failed' })
    expect((await screen.findByRole('status')).textContent).toBe(
      'Vision support download failed. Check your connection and try again.'
    )
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

    // The nudge re-reads capture status and then animates out; a busy machine needs more than 1s.
    await waitFor(() => expect(screen.queryByText('Capture needs vision support')).toBeNull(), {
      timeout: 5_000
    })
  })
})
