// @vitest-environment jsdom
/**
 * RELEASE_TEST_CHECKLIST #11 - manual onboarding through the real product seam.
 *
 * PermissionGate, setup surface, Models screen, catalog, model manager, integrity checks,
 * filesystem promotion, installed discovery, and activation remain real. The harness owns only
 * the App shell's `og:navigate` handoff so unrelated app subsystems do not pollute this seam.
 * Electron APIs and HTTP model delivery are the only controlled boundaries.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-manual-setup-'))
const dataDir = path.join(testRoot, 'data')
process.env.OFFGRID_DATA_DIR = dataDir

vi.mock('electron', () => ({
  app: {
    getPath: () => dataDir,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const manager = await import('@offgrid/core/main/models-manager')
const setup = await import('@offgrid/core/main/setup')
const { CATALOG } = await import('@offgrid/models')

// The chat model is a vision model now (no pure-text kind — every text model
// ships an mmproj). Manual setup just needs two distinct downloadable chat models
// to prove only the CHOSEN one downloads (its files, not the other's).
const chatModels = CATALOG.filter(
  (model) => model.kind === 'vision' && model.files.some((f) => f.name.endsWith('.gguf'))
)
const chosenModel = chatModels[0]
const unchosenModel = chatModels.find((model) => model.id !== chosenModel?.id)
if (!chosenModel || !unchosenModel) {
  throw new Error('Model catalog needs two downloadable chat (vision) models for manual setup')
}

type Progress = import('@offgrid/core/main/models-manager').DownloadProgress

function installStorage(): void {
  const values = new Map<string, string>([['onboarding_completed', 'true']])
  const storage: Storage = {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value))
  }
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
  vi.stubGlobal('localStorage', storage)
}

function installApi(): { requestedUrls: string[] } {
  const requestedUrls: string[] = []
  const progressListeners = new Set<(progress: Progress) => void>()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      requestedUrls.push(url)
      const bytes = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_044, 19)])
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-length': String(bytes.length) }
      })
    })
  )

  const eventSubscription = (): (() => void) => () => {}
  const values: Record<string, unknown> = {
    isPro: false,
    platform: 'darwin',
    getPermissionStatus: async () => ({
      accessibility: true,
      screenRecording: true,
      allGranted: true
    }),
    checkModelStatus: async () => ({
      downloaded: (await manager.listInstalled()).length > 0,
      modelsDir: path.join(dataDir, 'models')
    }),
    getModelCatalog: manager.getCatalog,
    getInstalledModels: manager.listInstalled,
    getModelScanFolders: async () => [],
    getActiveModelIds: manager.getActiveModelIds,
    activateModel: manager.activateModel,
    estimateModelFit: setup.estimateModelFit,
    downloadModel: async (modelId: string) =>
      manager.downloadModel(modelId, (progress) => {
        for (const listener of progressListeners) listener(progress)
      }),
    cancelModelDownload: async (modelId: string) => manager.cancelDownload(modelId),
    onModelProgress: (listener: (progress: Progress) => void) => {
      progressListeners.add(listener)
      return () => progressListeners.delete(listener)
    },
    getLlmSettings: async () => ({ performanceMode: 'balanced' }),
    setLlmSettings: async () => true,
    setupPlan: setup.getSetupPlan,
    systemHealth: async () => ({ ramGb: 64, components: [{ id: 'chat', status: 'ready' }] }),
    imageGenStatus: async () => ({ available: false, models: [], active: '' }),
    getStagedUpdateVersion: async () => null,
    getSettings: async () => ({}),
    listProjects: async () => [],
    getRagConversations: async () => [],
    meetingGetState: async () => ({
      recording: false,
      busy: false,
      platform: null,
      startedAt: 0,
      warnUntil: 0,
      error: ''
    }),
    onNewApproval: eventSubscription,
    onNewAction: eventSubscription,
    onUpdateDownloaded: eventSubscription,
    onReprocessProgress: eventSubscription,
    onSetupProgress: eventSubscription,
    onNavigate: eventSubscription,
    onMeetingState: eventSubscription,
    onRagStream: eventSubscription
  }
  const api = new Proxy(values, {
    get(target, property: string) {
      if (property in target) return target[property]
      if (/^on[A-Z]/.test(property)) return eventSubscription
      return async () => undefined
    }
  })
  Object.assign(window, { api })
  return { requestedUrls }
}

// Electron installs preload before renderer modules evaluate. Preserve that ordering here because
// ModelsScreen intentionally captures the stable preload bridge at module scope.
const apiBoundary = installApi()
const [{ PermissionGate }, { ModelsScreen }] = await Promise.all([
  import('@renderer/components/PermissionGate'),
  import('@renderer/components/ModelsScreen')
])

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true })
})

beforeEach(async () => {
  installStorage()
  window.history.replaceState(null, '', '/models')
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  await manager.clearDownload(chosenModel.id)
  await manager.clearDownload(unchosenModel.id)
  await manager.deleteModel(chosenModel.id)
  await manager.deleteModel(unchosenModel.id)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await manager.clearDownload(chosenModel.id)
  await manager.clearDownload(unchosenModel.id)
  await manager.deleteModel(chosenModel.id)
  await manager.deleteModel(unchosenModel.id)
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(testRoot, { recursive: true, force: true })
})

describe('manual model setup', () => {
  it('downloads and activates only the chosen model through manual setup (#11)', async () => {
    const { requestedUrls } = apiBoundary
    function ManualSetupHarness(): React.ReactElement {
      const [view, setView] = React.useState<'workspace' | 'models'>('workspace')
      React.useEffect(() => {
        const navigate = (event: Event): void => {
          if ((event as CustomEvent).detail === 'models') setView('models')
        }
        window.addEventListener('og:navigate', navigate)
        return () => window.removeEventListener('og:navigate', navigate)
      }, [])
      return React.createElement(
        PermissionGate,
        null,
        view === 'models'
          ? React.createElement(ModelsScreen)
          : React.createElement('main', null, 'Application workspace')
      )
    }
    const user = userEvent.setup()
    render(React.createElement(ManualSetupHarness))

    await user.click(await screen.findByRole('button', { name: 'Configure' }))
    await user.click(
      await screen.findByRole('button', { name: 'or browse & pick a model yourself' })
    )
    expect(await screen.findByRole('heading', { name: 'Models' })).not.toBeNull()

    const chosenCard = (await screen.findByText(chosenModel.name)).closest('[role="listitem"]')
    if (!(chosenCard instanceof HTMLElement)) throw new Error('Chosen model card did not render')
    await user.click(within(chosenCard).getByRole('button', { name: 'Download' }))

    let installedCard: HTMLElement | null = null
    await waitFor(() => {
      installedCard = screen.getByText(chosenModel.name).closest('[role="listitem"]')
      if (!(installedCard instanceof HTMLElement)) throw new Error('Installed model card missing')
      expect(within(installedCard).getByRole('button', { name: 'Use' })).not.toBeNull()
    })
    expect(await manager.listInstalled()).toEqual([chosenModel.id])
    expect(requestedUrls).toEqual(chosenModel.files.map((file) => file.url))
    expect(requestedUrls).not.toEqual(expect.arrayContaining(unchosenModel.files.map((f) => f.url)))
    expect(fs.existsSync(path.join(dataDir, 'models', chosenModel.files[0]!.name))).toBe(true)
    expect(fs.existsSync(path.join(dataDir, 'models', unchosenModel.files[0]!.name))).toBe(false)

    if (!(installedCard instanceof HTMLElement)) throw new Error('Installed model card missing')
    await user.click(within(installedCard).getByRole('button', { name: 'Use' }))
    await waitFor(() => expect(manager.getActiveModel()).toBe(chosenModel.id))
    await expect(manager.getActiveModelIds()).resolves.toContain(chosenModel.id)
    await expect(manager.listInstalled()).resolves.not.toContain(unchosenModel.id)
    await waitFor(() => {
      const activeCard = screen.getByText(chosenModel.name).closest('[role="listitem"]')
      if (!(activeCard instanceof HTMLElement)) throw new Error('Active model card missing')
      expect(within(activeCard).getByText('Active')).not.toBeNull()
    })
  })
})
