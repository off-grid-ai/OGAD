// @vitest-environment jsdom

// Integration: what the Models screen SHOWS you while a download runs, when it is refused, and when
// you cancel it. Real ModelsScreen; only window.api — the IPC line out of the renderer — is faked,
// and it publishes the Shared-owned model-control projection plus resolved command outcomes. The
// renderer must not rebuild download state from the lower-level transport event channel.
//
// Grounded in the macOS session of 2026-08-09: a download the main process had REFUSED
// (reason=application_shutdown) left the card showing a spinner at 0% for hours with no message and
// no way to learn why. The card's job is to say what is true and offer the one action that helps.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { modelControlSnapshot } from './harness/model-control-snapshot'
import type {
  ModelControlCatalogModel,
  ModelControlProjection,
  PublicDownloadInfo
} from '@offgrid/application'
import { ModelsScreen } from '../ModelsScreen'

const MODEL_ARTIFACTS = [
  { name: 'Qwen3.5-9B-Q4_K_M.gguf', role: 'primary', sizeBytes: 6.6e9 },
  { name: 'vision-adapter-BF16.gguf', role: 'mmproj', sizeBytes: 1.0e9 }
] satisfies ModelControlCatalogModel['artifacts']

const MODEL = {
  id: 'unsloth/Qwen3.5-9B-GGUF',
  name: 'Qwen 3.5 9B',
  kind: 'vision',
  org: 'Qwen',
  params: 9,
  artifacts: MODEL_ARTIFACTS,
  files: MODEL_ARTIFACTS
} satisfies ModelControlCatalogModel & { files: typeof MODEL_ARTIFACTS }

const TRANSFERRED_MODEL_ARTIFACTS = [
  { name: 'Qwen3.5-0.8B-Q4_K_M.gguf', role: 'primary', sizeBytes: 703e6 },
  { name: 'qwen3.5-0.8b-mmproj-F16.gguf', role: 'mmproj', sizeBytes: 9e6 }
] satisfies ModelControlCatalogModel['artifacts']

const TRANSFERRED_MODEL = {
  ...MODEL,
  id: 'model-package-v1:transferred-qwen-variant',
  name: 'Qwen3.5-0.8B-GGUF',
  params: 0.8,
  artifacts: TRANSFERRED_MODEL_ARTIFACTS,
  files: TRANSFERRED_MODEL_ARTIFACTS
} satisfies ModelControlCatalogModel & { files: typeof TRANSFERRED_MODEL_ARTIFACTS }

/** The real DOWNLOAD_INTERRUPTED_ERROR string the main process returns for a refused request. */
const INTERRUPTED = 'interrupted - retry to resume'

type RawProgressEvent = Omit<PublicDownloadInfo, 'startedAt'>
let rawProgressListeners: ((event: RawProgressEvent) => void)[] = []
const emitRawProgress = (event: RawProgressEvent): void =>
  rawProgressListeners.forEach((listener) => listener(event))

/** 1331.2 MiB of 6296.4 MiB — 21% of the whole job, 1.4 GB of 6.6 GB in the units the card uses. */
const FIRST_SAMPLE_BYTES = Math.round(1331.2 * 1024 * 1024)
const JOB_TOTAL_BYTES = Math.round(6296.4 * 1024 * 1024)
const inFlight = (modelId: string): PublicDownloadInfo => ({
  downloadId: 'download:qwen',
  modelId,
  fileName: MODEL.files[0]!.name,
  currentFileRole: 'primary',
  status: 'downloading',
  bytesDownloaded: FIRST_SAMPLE_BYTES,
  totalBytes: JOB_TOTAL_BYTES,
  startedAt: 1
})

/** A downloading tick at a chosen whole percent of a round total. */
const tick = (percent: number): PublicDownloadInfo => ({
  downloadId: 'download:qwen',
  modelId: MODEL.id,
  fileName: MODEL.files[0]!.name,
  status: 'downloading',
  bytesDownloaded: percent * 10,
  totalBytes: 1_000,
  startedAt: 1
})
let onDownload: (id: string) => Promise<{ success: boolean; error?: string }> = async () => ({
  success: true
})
let onCancel: (id: string) => void = () => {}
let cancelFailure: string | null = null
let catalogModels = [MODEL]
let installedModels: string[] = []
let activeModels: string[] = []
let downloadIntents: string[] = []
let boundaryDownloads: PublicDownloadInfo[] = []
let downloadActions: { type: string; id: string }[] = []
let visionStatus: Record<string, { supportsVision: boolean; projectorInstalled: boolean }> = {}
let projectionListeners: ((projection: ModelControlProjection) => void)[] = []
const publishDownloads = (downloads: PublicDownloadInfo[]): void => {
  boundaryDownloads = downloads
  const next = {
    ...modelControlSnapshot({
      kinds: ['vision'],
      models: catalogModels,
      installed: installedModels,
      activeIds: activeModels
    }),
    downloads
  }
  for (const listener of projectionListeners) listener(next)
}
const publishDownload = (download: PublicDownloadInfo): void => publishDownloads([download])
let onControlStarted: (intent: {
  type: string
  modelId?: string
  selection?: { repositoryId: string; fileName: string }
  operationId: string
}) => void = () => {}

;(globalThis as unknown as { window: { api: unknown } }).window.api = {
  systemHealth: async () => ({ ramGb: 32 }),
  getModelControlProjection: async () => ({
    ...modelControlSnapshot({
      kinds: ['vision'],
      models: catalogModels,
      installed: installedModels,
      activeIds: activeModels
    }),
    downloads: boundaryDownloads
  }),
  onModelControlProjection: (listener: (projection: ModelControlProjection) => void) => {
    projectionListeners.push(listener)
    return () => {
      projectionListeners = projectionListeners.filter((candidate) => candidate !== listener)
    }
  },
  getModelCatalog: async () => ({ kinds: ['vision'], models: catalogModels }),
  getInstalledModels: async () => installedModels,
  getModelVisionStatus: async () => visionStatus,
  getActiveModelIds: async () => [],
  estimateModelFit: async () => ({ level: 'ok' }),
  onModelProgress: (listener: (event: RawProgressEvent) => void) => {
    rawProgressListeners.push(listener)
    return () => {
      rawProgressListeners = rawProgressListeners.filter((candidate) => candidate !== listener)
    }
  },
  // The one model-control door. The main process is the other side of it, so the test drives what
  // that side does: a refusal, a cancellation, or a download that stays in flight. `cancelled` is
  // returned as an OUTCOME, not a failure — the same distinction the production owner makes.
  controlModel: async (intent: {
    type: string
    modelId?: string
    selection?: { repositoryId: string; fileName: string }
    operationId: string
  }) => {
    const projection = modelControlSnapshot({
      kinds: ['vision'],
      models: catalogModels,
      installed: installedModels,
      activeIds: activeModels
    })
    if (intent.type === 'cancel-download') {
      if (cancelFailure) return { ok: false, failure: { kind: 'runtime', message: cancelFailure } }
      onCancel(intent.modelId!)
      boundaryDownloads = boundaryDownloads.map((row) =>
        row.downloadId === intent.modelId ? { ...row, status: 'cancelled' } : row
      )
      return {
        ok: true,
        value: {
          status: 'cancelled',
          operationId: intent.operationId,
          projection: { ...projection, downloads: boundaryDownloads }
        }
      }
    }
    if (intent.type === 'pause-download' || intent.type === 'resume-download') {
      downloadActions.push({ type: intent.type, id: intent.modelId! })
      const row = boundaryDownloads.find((item) => item.downloadId === intent.modelId)
      if (!row)
        return { ok: false, failure: { kind: 'runtime', message: 'Download job not found' } }
      row.status = intent.type === 'pause-download' ? 'paused' : 'downloading'
      return {
        ok: true,
        value: {
          status: row.status === 'paused' ? 'paused' : 'completed',
          operationId: intent.operationId,
          projection: { ...projection, downloads: boundaryDownloads }
        }
      }
    }
    if (
      intent.type === 'download' ||
      intent.type === 'queue-download' ||
      intent.type === 'repair-projector'
    ) {
      downloadIntents.push(intent.type)
      onControlStarted(intent)
      const result = await onDownload(intent.modelId!)
      if (result.success) {
        return {
          ok: true,
          value: { status: 'completed', operationId: intent.operationId, projection }
        }
      }
      if (result.error === 'cancelled') {
        return {
          ok: true,
          value: { status: 'cancelled', operationId: intent.operationId, projection }
        }
      }
      if (result.error === INTERRUPTED) {
        return { ok: false, failure: { kind: 'interrupted', reason: result.error } }
      }
      return { ok: false, failure: { kind: 'runtime', message: result.error ?? 'Download failed' } }
    }
    return {
      ok: true,
      value: {
        status: 'completed',
        operationId: intent.operationId,
        projection: { ...projection, downloads: boundaryDownloads }
      }
    }
  }
}

beforeEach(() => {
  rawProgressListeners = []
  projectionListeners = []
  onControlStarted = () => {}
  onDownload = async () => ({ success: true })
  onCancel = () => {}
  cancelFailure = null
  catalogModels = [MODEL]
  installedModels = []
  activeModels = []
  downloadIntents = []
  boundaryDownloads = []
  downloadActions = []
  visionStatus = {}
})
afterEach(cleanup)

// The catalog fixture holds exactly one model, so the screen IS that model's card and a screen-level
// query cannot be satisfied by a neighbour.

describe('<ModelsScreen/> — what a download looks like', () => {
  it('sends the exact repository and selected file facts through the one control command', async () => {
    let observed:
      | { type: string; modelId?: string; selection?: { repositoryId: string; fileName: string } }
      | undefined
    onControlStarted = (intent) => {
      observed = intent
    }
    render(<ModelsScreen />)
    await userEvent.click(await screen.findByRole('button', { name: 'Download' }))
    expect(observed).toMatchObject({
      type: 'queue-download',
      modelId: MODEL.id,
      selection: {
        repositoryId: MODEL.id,
        fileName: MODEL.files[0]!.name
      }
    })
  })

  it('reacts to Shared preparation while the command is still resolving metadata', async () => {
    onDownload = async () => new Promise(() => {})
    onControlStarted = (intent) => {
      const projection = {
        ...modelControlSnapshot({
          kinds: ['vision'],
          models: catalogModels,
          installed: installedModels,
          activeIds: activeModels
        }),
        downloads: [
          {
            downloadId: intent.operationId,
            modelId: intent.modelId!,
            fileName: intent.modelId!,
            status: 'preparing' as const,
            bytesDownloaded: 0,
            totalBytes: 0,
            startedAt: 0
          }
        ]
      }
      for (const listener of projectionListeners) listener(projection)
    }

    render(<ModelsScreen />)
    await userEvent.click(await screen.findByRole('button', { name: /^download$/i }))

    expect(await screen.findByText('Preparing')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^download$/i })).toBeNull()
  })

  it('restores a paused job and resumes and pauses that exact job from card and detail', async () => {
    boundaryDownloads = [
      {
        downloadId: 'exact-paused-job',
        modelId: MODEL.id,
        fileName: MODEL.files[0]!.name,
        currentFile: MODEL.files[0]!.name,
        currentFileRole: 'primary',
        status: 'paused',
        bytesDownloaded: 100e6,
        totalBytes: 1e9,
        startedAt: 1
      }
    ]
    render(<ModelsScreen />)
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    expect((await screen.findByRole('button', { name: 'Pause' })).hasAttribute('disabled')).toBe(
      false
    )
    expect(screen.getByText('100 MB of 1.0 GB')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull()
    await userEvent.click(screen.getByTitle('Details'))
    const detail = within(await screen.findByRole('dialog'))
    await userEvent.click(detail.getByRole('button', { name: 'Pause' }))
    expect((await detail.findByRole('button', { name: 'Resume' })).hasAttribute('disabled')).toBe(
      false
    )
    expect(detail.getByText(/Paused/)).toBeTruthy()
    expect(downloadActions).toEqual([
      { type: 'resume-download', id: 'exact-paused-job' },
      { type: 'pause-download', id: 'exact-paused-job' }
    ])
    await userEvent.click(detail.getByRole('button', { name: 'Cancel' }))
    expect(await detail.findByRole('button', { name: 'Download' })).toBeTruthy()
  })
  it('retries only the failed projector while its installed primary stays active', async () => {
    installedModels = [MODEL.id]
    activeModels = [MODEL.id]
    visionStatus = { [MODEL.id]: { supportsVision: true, projectorInstalled: false } }
    onDownload = async (id) => {
      publishDownload({
        ...inFlight(id),
        currentFileRole: 'mmproj',
        fileName: MODEL.files[1]!.name,
        status: 'failed',
        reason: 'Connection lost',
        startedAt: 1
      })
      return { success: false, error: 'Connection lost' }
    }
    render(<ModelsScreen />)
    await userEvent.click(await screen.findByRole('button', { name: 'Add vision support' }))
    expect(
      await screen.findByRole('button', { name: 'Retry vision support (mmproj)' })
    ).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Connection lost')).toBeTruthy()
    let finish!: (result: { success: boolean; error?: string }) => void
    onDownload = async (id) => {
      publishDownload({
        ...inFlight(id),
        currentFileRole: 'mmproj',
        fileName: MODEL.files[1]!.name
      })
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Retry vision support (mmproj)' }))
      expect(await screen.findByText('Vision support (mmproj)')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
      expect(downloadIntents).toEqual(['repair-projector', 'repair-projector'])
    } finally {
      await act(async () => {
        finish?.({ success: false, error: 'cancelled' })
      })
    }
  })
  it.each([false, true])(
    'shows projector transfer numbers and Cancel for an installed model (active=%s)',
    async (active) => {
      installedModels = [MODEL.id]
      activeModels = active ? [MODEL.id] : []
      visionStatus = { [MODEL.id]: { supportsVision: true, projectorInstalled: false } }
      let finish!: (result: { success: boolean; error?: string }) => void
      onDownload = async (id) => {
        const sample = {
          ...inFlight(id),
          fileName: MODEL.files[1]!.name,
          currentFileRole: 'mmproj' as const,
          bytesDownloaded: 100_000_000,
          totalBytes: 1_000_000_000,
          bytesPerSecond: 2_000_000
        }
        publishDownload({ ...sample, bytesDownloaded: 105_000_000 })
        return new Promise((resolve) => {
          finish = resolve
        })
      }
      render(<ModelsScreen />)
      try {
        await userEvent.click(await screen.findByRole('button', { name: 'Add vision support' }))
        expect(await screen.findByText('11%')).toBeTruthy()
        expect(screen.getByText('105 MB of 1.0 GB')).toBeTruthy()
        expect(screen.getByText(/1\.9 MB\/s/)).toBeTruthy()
        expect(screen.getByText('Vision support (mmproj)')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Add vision support' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Use' })).toBeNull()
        await userEvent.click(screen.getByTitle('Details'))
        const detail = within(await screen.findByRole('dialog'))
        expect(detail.getByText('11%')).toBeTruthy()
        expect(detail.getByText('105 MB of 1.0 GB')).toBeTruthy()
        expect(detail.getByText('Vision support (mmproj)')).toBeTruthy()
        expect(detail.getByText(/1\.9 MB\/s/)).toBeTruthy()
        expect(detail.getByRole('button', { name: 'Cancel' })).toBeTruthy()
      } finally {
        await act(async () => {
          finish?.({ success: false, error: 'cancelled' })
        })
      }
    }
  )

  it('shows a received model without closing and reopening Models', async () => {
    render(<ModelsScreen />)
    expect(await screen.findByText(MODEL.name)).toBeTruthy()
    expect(screen.queryByText(TRANSFERRED_MODEL.name)).toBeNull()

    catalogModels = [MODEL, TRANSFERRED_MODEL]
    installedModels = [TRANSFERRED_MODEL.id]
    publishDownload({
      downloadId: 'download:transferred',
      modelId: TRANSFERRED_MODEL.id,
      fileName: TRANSFERRED_MODEL.files[0]!.name,
      status: 'completed',
      bytesDownloaded: TRANSFERRED_MODEL.files[0]!.sizeBytes,
      totalBytes: TRANSFERRED_MODEL.files[0]!.sizeBytes,
      startedAt: 1
    })

    const installedList = await screen.findByRole('list', { name: 'Models on this device' })
    expect(installedList.textContent).toContain(TRANSFERRED_MODEL.name)
  })

  it('a refused download says why, and offers one way forward — never a silent 0%', async () => {
    // The main process refuses the request: it publishes 'failed' and resolves unsuccessfully.
    onDownload = async (id) => {
      publishDownload({
        downloadId: 'download:qwen',
        modelId: id,
        fileName: MODEL.files[0]!.name,
        status: 'interrupted',
        reason: INTERRUPTED,
        bytesDownloaded: 0,
        totalBytes: MODEL.files[0]!.sizeBytes,
        startedAt: 1
      })
      return { success: false, error: INTERRUPTED }
    }
    const user = userEvent.setup()
    render(<ModelsScreen />)

    // BEFORE: the card offers a download and says nothing about failure.
    const download = await screen.findByRole('button', { name: /^download$/i })
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()

    await user.click(download)

    // The reason is on screen, in words, with the one action that helps.
    expect(await screen.findByText(/download stopped before it finished/i)).toBeTruthy()
    const retry = screen.getByRole('button', { name: /try again/i })
    expect(retry).toBeTruthy()

    // And the card does NOT still claim to be working: no stuck percent, no Cancel.
    expect(screen.queryByText(/\d+%/)).toBeNull()
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
    // One action, not two: the failed row replaces Download rather than stacking under it.
    expect(screen.queryByRole('button', { name: /^download$/i })).toBeNull()
  })

  it('cancelling returns the card to Download, and is never reported as a failure', async () => {
    // Held open: the download stays in flight until the test cancels it, so the in-flight state
    // genuinely renders and "it went back to Download" is a transition, not a no-op.
    let finish: (r: { success: boolean; error?: string }) => void = () => {}
    onDownload = async (id) => {
      publishDownload(inFlight(id))
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    // Cancelling is what the main process does: it clears the card on the channel, and the pending
    // call resolves unsuccessfully with 'cancelled' — which is an outcome, not a failure.
    onCancel = (id) => {
      publishDownload({
        downloadId: 'download:qwen',
        modelId: id,
        fileName: MODEL.files[0]!.name,
        status: 'cancelled',
        bytesDownloaded: FIRST_SAMPLE_BYTES,
        totalBytes: JOB_TOTAL_BYTES,
        startedAt: 1
      })
      finish({ success: false, error: 'cancelled' })
    }
    const user = userEvent.setup()
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: /^download$/i }))

    // BEFORE: it is genuinely downloading — progress on screen and a Cancel to press.
    expect(await screen.findByText(/21%/)).toBeTruthy()
    const cancel = screen.getByRole('button', { name: /cancel/i })

    await user.click(cancel)

    // Back to the start, with nothing red about a thing you chose to stop.
    expect(await screen.findByRole('button', { name: /^download$/i })).toBeTruthy()
    expect(screen.queryByText(/cancelled/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
    expect(screen.queryByText(/21%/)).toBeNull()
  })

  it('keeps the running download visible when cancellation is refused', async () => {
    let finish: (result: { success: boolean; error?: string }) => void = () => {}
    onDownload = async (id) => {
      publishDownload(inFlight(id))
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    cancelFailure = 'The active transfer cannot stop yet'
    const user = userEvent.setup()
    render(<ModelsScreen />)
    await user.click(await screen.findByRole('button', { name: /^download$/i }))
    expect(await screen.findByText(/21%/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(
      await screen.findByText(/Couldn't cancel: The active transfer cannot stop yet/)
    ).toBeTruthy()
    expect(screen.getByText(/21%/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
    await act(async () => {
      finish({ success: false, error: 'cancelled' })
    })
  })

  it('an in-flight download reads as one number, in human units, with the part it is fetching', async () => {
    onDownload = async (id) => {
      publishDownload({ ...inFlight(id), bytesPerSecond: 2.8 * 1024 * 1024 })
      return new Promise(() => {}) // stays in flight
    }
    const user = userEvent.setup()
    render(<ModelsScreen />)
    await user.click(await screen.findByRole('button', { name: /^download$/i }))

    // One percent for the whole download.
    expect(await screen.findByText(/21%/)).toBeTruthy()
    // Bytes at the scale the card above already uses — 6296.4 MB is a number you have to convert.
    //
    // The feed counts MEBIbytes, so 6296.4 is 6.6 GB, not 6.1. This line used to assert 6.1 because
    // it divided by 1024 while the meta line above it divided by 1e9 — one file, two units, one
    // label, which is what made a 25.4GB model report "23.7 GB" while downloading. Both now read
    // through formatSize, so this assertion finally matches the intent stated above it.
    expect(screen.getByText(/1\.4 GB of 6\.6 GB/)).toBeTruthy()
    expect(screen.getByText(/2\.8 MB\/s/)).toBeTruthy()
    expect(screen.getByText(/~30 min left/)).toBeTruthy()
    // The card stays scannable; its detail panel exposes the full artifact without squeezing metrics.
    expect(screen.queryByText('Model file')).toBeNull()
    expect(screen.queryByText('Vision support (mmproj)')).toBeNull()
    expect(screen.queryByText(MODEL.files[0]!.name)).toBeNull()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy()
    await user.click(screen.getByTitle('Details'))
    const detail = within(await screen.findByRole('dialog'))
    expect(detail.getByText(MODEL.files[0]!.name)).toBeTruthy()
    expect(detail.getByText(/21%/)).toBeTruthy()
    expect(detail.getByText(/1\.4 GB of 6\.6 GB/)).toBeTruthy()
    expect(detail.getByText(/2\.8 MB\/s/)).toBeTruthy()
    expect(detail.getByText(/~30 min left/)).toBeTruthy()
    expect(detail.getByRole('button', { name: /cancel/i })).toBeTruthy()
  })

  it('uses an indeterminate label when byte totals and percentage are invalid', async () => {
    onDownload = async (id) => {
      // The coordinator has started the transfer but has no byte totals for it yet — the state the
      // card used to fill with NaN and Infinity.
      publishDownload({
        downloadId: 'download:qwen',
        modelId: id,
        fileName: MODEL.files[0]!.name,
        status: 'downloading',
        bytesDownloaded: 0,
        totalBytes: 0,
        startedAt: 1
      })
      return new Promise(() => {})
    }
    const user = userEvent.setup()
    render(<ModelsScreen />)
    await user.click(await screen.findByRole('button', { name: /^download$/i }))

    // BLOCKED, left asserting the product guarantee rather than the current behaviour. A download
    // the coordinator has started but has no byte totals for renders a bare "0%" — no NaN and no
    // Infinity, but also no indeterminate label. That bare 0% is the exact failure this suite was
    // written against (the macOS session of 2026-08-09: a refused download sat at 0% for hours,
    // saying nothing). A percentage that reads as real progress when there is none is the bug, so
    // the assertion stays as written and the card has to grow the label.
    expect(await screen.findByText('Downloading')).toBeTruthy()
    expect(screen.getByText(/Total size unavailable/)).toBeTruthy()
    expect(screen.getByText(/Rate unavailable/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('NaN')
    expect(document.body.textContent).not.toContain('Infinity')
    expect(document.body.textContent).not.toContain('left')
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy()
  })

  it('never lets a raw transport tick reopen or change a terminal Shared projection', async () => {
    render(<ModelsScreen />)
    expect(await screen.findByText(MODEL.name)).toBeTruthy()
    act(() =>
      publishDownload({
        ...tick(30),
        status: 'failed',
        reason: 'network connection lost'
      })
    )
    expect(screen.getByText('network connection lost')).toBeTruthy()

    act(() => emitRawProgress(tick(80)))

    expect(screen.getByText('network connection lost')).toBeTruthy()
    expect(screen.queryByText('80%')).toBeNull()
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
  })
})
