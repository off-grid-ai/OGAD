// @vitest-environment jsdom
/**
 * RELEASE_TEST_CHECKLIST #11 - manual onboarding through the real product seam.
 *
 * PermissionGate, setup surface, Models screen, Shared catalog, route handoff, and filesystem
 * results remain real. Electron model-management IPC and HTTP delivery are controlled boundaries;
 * the dedicated model-integrity suite owns large-file promotion, size, and checksum behavior.
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

const setup = await import('@offgrid/core/main/setup')
const { CATALOG, MODEL_KINDS } = await import('@offgrid/models')

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

interface Progress {
  modelId: string
  percent?: number
  status: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled'
}

const installedIds = new Set<string>()
const activeIds = new Set<string>()

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
      downloaded: chatModels.some((model) => installedIds.has(model.id)),
      modelsDir: path.join(dataDir, 'models')
    }),
    getModelControlSnapshot: async () => {
      const selected = [...activeIds][0] ?? null
      return {
        kinds: MODEL_KINDS,
        models: CATALOG,
        installed: [...installedIds],
        activeIds: [...activeIds],
        active: {
          text: selected,
          image: null,
          speech: null,
          transcription: null,
          computer_use: null
        },
        computerUse: null
      }
    },
    getModelCatalog: async () => ({ kinds: MODEL_KINDS, models: CATALOG }),
    getInstalledModels: async () => [...installedIds],
    getActiveModelIds: async () => [...activeIds],
    activateModel: async (modelId: string) => {
      activeIds.clear()
      activeIds.add(modelId)
      return { success: true }
    },
    estimateModelFit: setup.estimateModelFit,
    downloadModel: async (modelId: string) => {
      const model = CATALOG.find((candidate) => candidate.id === modelId)
      if (!model) return { success: false, error: 'unknown model' }
      fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true })
      for (const file of model.files) {
        const response = await fetch(file.url)
        fs.writeFileSync(
          path.join(dataDir, 'models', file.name),
          Buffer.from(await response.arrayBuffer())
        )
      }
      installedIds.add(modelId)
      const progress: Progress = { modelId, percent: 100, status: 'completed' }
      for (const listener of progressListeners) listener(progress)
      return { success: true }
    },
    cancelModelDownload: async () => true,
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
  installedIds.clear()
  activeIds.clear()
  for (const model of [chosenModel, unchosenModel]) {
    for (const file of model.files) {
      fs.rmSync(path.join(dataDir, 'models', file.name), { force: true })
    }
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

afterAll(() => {
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
    expect([...installedIds]).toEqual([chosenModel.id])
    expect(requestedUrls).toEqual(chosenModel.files.map((file) => file.url))
    expect(requestedUrls).not.toEqual(expect.arrayContaining(unchosenModel.files.map((f) => f.url)))
    expect(fs.existsSync(path.join(dataDir, 'models', chosenModel.files[0]!.name))).toBe(true)
    expect(fs.existsSync(path.join(dataDir, 'models', unchosenModel.files[0]!.name))).toBe(false)

    if (!(installedCard instanceof HTMLElement)) throw new Error('Installed model card missing')
    await user.click(within(installedCard).getByRole('button', { name: 'Use' }))
    await waitFor(() => expect([...activeIds]).toContain(chosenModel.id))
    expect([...installedIds]).not.toContain(unchosenModel.id)
    await waitFor(() => {
      const activeCard = screen.getByText(chosenModel.name).closest('[role="listitem"]')
      if (!(activeCard instanceof HTMLElement)) throw new Error('Active model card missing')
      expect(within(activeCard).getByText('Active')).not.toBeNull()
    })
  })
})
