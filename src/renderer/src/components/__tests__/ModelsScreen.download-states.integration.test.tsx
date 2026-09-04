// @vitest-environment jsdom

// Integration: what the Models screen SHOWS you while a download runs, when it is refused, and when
// you cancel it. Real ModelsScreen; only window.api — the IPC line out of the renderer — is faked,
// and it emits exactly what the main process emits (a progress event on the channel AND the
// resolved result of the call), so the screen's behaviour is emergent rather than programmed.
//
// Grounded in the macOS session of 2026-08-09: a download the main process had REFUSED
// (reason=application_shutdown) left the card showing a spinner at 0% for hours with no message and
// no way to learn why. The card's job is to say what is true and offer the one action that helps.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { modelControlSnapshot } from './harness/model-control-snapshot'

const MODEL = {
  id: 'unsloth/Qwen3.5-9B-GGUF',
  name: 'Qwen 3.5 9B',
  kind: 'vision',
  org: 'Qwen',
  params: 9,
  files: [
    { name: 'Qwen3.5-9B-Q4_K_M.gguf', role: 'primary', sizeBytes: 6.6e9 },
    { name: 'mmproj-Qwen3.5-9B-BF16.gguf', role: 'mmproj', sizeBytes: 1.0e9 }
  ]
}

const TRANSFERRED_MODEL = {
  ...MODEL,
  id: 'model-package-v1:transferred-qwen-variant',
  name: 'Qwen3.5-0.8B-GGUF',
  params: 0.8,
  files: [
    { name: 'Qwen3.5-0.8B-Q4_K_M.gguf', role: 'primary', sizeBytes: 703e6 },
    { name: 'qwen3.5-0.8b-mmproj-F16.gguf', role: 'mmproj', sizeBytes: 9e6 }
  ]
}

/** The real DOWNLOAD_INTERRUPTED_ERROR string the main process returns for a refused request. */
const INTERRUPTED = 'interrupted - retry to resume'

/**
 * What the main process actually publishes: raw coordinator facts. The percent, the human byte
 * scale, the rate and the ETA are all DERIVED by the production `useModelDownloadProgress` hook, so
 * this suite feeds the real channel shape and lets that projection run rather than hand-feeding a
 * pre-computed percent the channel no longer carries.
 */
type ProgressEvent = {
  downloadId: string
  modelId: string
  fileName: string
  status: string
  bytesDownloaded?: number
  totalBytes?: number
  reason?: string
}

/** The main process, faked at the IPC boundary and only there. `downloadModel` behaves the way
 *  models-manager does: it publishes on the progress channel AND resolves with an outcome. Each
 *  test scripts what its download does; the screen decides what to render from that. */
let listeners: ((p: ProgressEvent) => void)[] = []
const emit = (p: ProgressEvent): void => listeners.forEach((l) => l(p))

/** 1331.2 MiB of 6296.4 MiB — 21% of the whole job, 1.4 GB of 6.6 GB in the units the card uses. */
const FIRST_SAMPLE_BYTES = Math.round(1331.2 * 1024 * 1024)
const JOB_TOTAL_BYTES = Math.round(6296.4 * 1024 * 1024)
/** 2.5 s later, 2.8 MiB/s further on — the two samples the rate is measured from. */
const SECOND_SAMPLE_BYTES = FIRST_SAMPLE_BYTES + Math.round(2.8 * 1024 * 1024 * 2.5)

const inFlight = (modelId: string): ProgressEvent => ({
  downloadId: 'download:qwen',
  modelId,
  fileName: MODEL.files[0]!.name,
  status: 'downloading',
  bytesDownloaded: FIRST_SAMPLE_BYTES,
  totalBytes: JOB_TOTAL_BYTES
})

/** A downloading tick at a chosen whole percent of a round total. */
const tick = (percent: number): ProgressEvent => ({
  downloadId: 'download:qwen',
  modelId: MODEL.id,
  fileName: MODEL.files[0]!.name,
  status: 'downloading',
  bytesDownloaded: percent * 10,
  totalBytes: 1_000
})
let onDownload: (id: string) => Promise<{ success: boolean; error?: string }> = async () => ({
  success: true
})
let onCancel: (id: string) => void = () => {}
let catalogModels = [MODEL]
let installedModels: string[] = []

;(globalThis as unknown as { window: { api: unknown } }).window.api = {
  systemHealth: async () => ({ ramGb: 32 }),
  getModelControlProjection: async () =>
    modelControlSnapshot({
      kinds: ['vision'],
      models: catalogModels,
      installed: installedModels
    }),
  getModelCatalog: async () => ({ kinds: ['vision'], models: catalogModels }),
  getInstalledModels: async () => installedModels,
  getModelVisionStatus: async () => ({}),
  getActiveModelIds: async () => [],
  estimateModelFit: async () => ({ level: 'ok' }),
  onModelProgress: (cb: (p: ProgressEvent) => void) => {
    listeners.push(cb)
    return () => {
      listeners = listeners.filter((l) => l !== cb)
    }
  },
  // The one model-control door. The main process is the other side of it, so the test drives what
  // that side does: a refusal, a cancellation, or a download that stays in flight. `cancelled` is
  // returned as an OUTCOME, not a failure — the same distinction the production owner makes.
  controlModel: async (intent: { type: string; modelId?: string }) => {
    const projection = modelControlSnapshot({
      kinds: ['vision'],
      models: catalogModels,
      installed: installedModels
    })
    if (intent.type === 'cancel-download') {
      onCancel(intent.modelId!)
      return { ok: true, value: { status: 'cancelled', operationId: 'test', projection } }
    }
    if (intent.type === 'download') {
      const result = await onDownload(intent.modelId!)
      if (result.success) {
        return { ok: true, value: { status: 'completed', operationId: 'test', projection } }
      }
      if (result.error === 'cancelled') {
        return { ok: true, value: { status: 'cancelled', operationId: 'test', projection } }
      }
      return { ok: false, failure: { kind: 'runtime', message: result.error ?? 'Download failed' } }
    }
    return { ok: true, value: { status: 'completed', operationId: 'test', projection } }
  }
}

let ModelsScreen: () => React.JSX.Element
beforeAll(async () => {
  ModelsScreen = (await import('../ModelsScreen')).ModelsScreen
})
beforeEach(() => {
  listeners = []
  onDownload = async () => ({ success: true })
  onCancel = () => {}
  catalogModels = [MODEL]
  installedModels = []
})
afterEach(cleanup)

// The catalog fixture holds exactly one model, so the screen IS that model's card and a screen-level
// query cannot be satisfied by a neighbour.

describe('<ModelsScreen/> — what a download looks like', () => {
  it('shows a received model without closing and reopening Models', async () => {
    render(<ModelsScreen />)
    expect(await screen.findByText(MODEL.name)).toBeTruthy()
    expect(screen.queryByText(TRANSFERRED_MODEL.name)).toBeNull()

    catalogModels = [MODEL, TRANSFERRED_MODEL]
    installedModels = [TRANSFERRED_MODEL.id]
    emit({
      downloadId: 'download:transferred',
      modelId: TRANSFERRED_MODEL.id,
      fileName: TRANSFERRED_MODEL.files[0]!.name,
      status: 'completed'
    })

    const installedList = await screen.findByRole('list', { name: 'Models on this device' })
    expect(installedList.textContent).toContain(TRANSFERRED_MODEL.name)
  })

  it('a refused download says why, and offers one way forward — never a silent 0%', async () => {
    // The main process refuses the request: it publishes 'failed' and resolves unsuccessfully.
    onDownload = async (id) => {
      emit({
        downloadId: 'download:qwen',
        modelId: id,
        fileName: MODEL.files[0]!.name,
        status: 'failed',
        reason: INTERRUPTED
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
      emit(inFlight(id))
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    // Cancelling is what the main process does: it clears the card on the channel, and the pending
    // call resolves unsuccessfully with 'cancelled' — which is an outcome, not a failure.
    onCancel = (id) => {
      emit({
        downloadId: 'download:qwen',
        modelId: id,
        fileName: MODEL.files[0]!.name,
        status: 'cancelled'
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

  it('an in-flight download reads as one number, in human units, with the part it is fetching', async () => {
    onDownload = async (id) => {
      // A rate needs TWO samples of the same file: the hook measures bytes over elapsed time
      // rather than trusting a number the transport claims. The clock is pinned so the measured
      // rate is exact instead of racing the test runner.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
      emit(inFlight(id))
      clock.mockReturnValue(3_500)
      emit({ ...inFlight(id), bytesDownloaded: SECOND_SAMPLE_BYTES })
      clock.mockRestore()
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
    // Which part is moving — named, without giving it a second percent of its own.
    //
    // BLOCKED, left asserting the product guarantee rather than the current behaviour: the card
    // never names the file. `downloadPartLabel` (ModelsScreen.tsx) only renders "· adding
    // <companion>" for a companion file or "· file N of M" from `fileIndex` / `fileCount` — and
    // the progress channel no longer carries either, so both branches are dead and the label is
    // always empty for the primary file. Whether the card should name the part, or whether this
    // guarantee is retired, is the open `fileIndex` / `fileCount` decision; it is not settled by
    // deleting this line.
    expect(screen.getByText(new RegExp(MODEL.files[0]!.name))).toBeTruthy()
    // The action row holds the action, on the same line as the status.
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy()
  })

  it('uses an indeterminate label when byte totals and percentage are invalid', async () => {
    onDownload = async (id) => {
      // The coordinator has started the transfer but has no byte totals for it yet — the state the
      // card used to fill with NaN and Infinity.
      emit({
        downloadId: 'download:qwen',
        modelId: id,
        fileName: MODEL.files[0]!.name,
        status: 'downloading'
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
    expect(document.body.textContent).not.toContain('NaN')
    expect(document.body.textContent).not.toContain('Infinity')
    expect(document.body.textContent).not.toContain('left')
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy()
  })

  it('shows progress at most every two seconds and never lets a stale tick replace failure', async () => {
    render(<ModelsScreen />)
    expect(await screen.findByText(MODEL.name)).toBeTruthy()
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      act(() => emit(tick(10)))
      expect(screen.getByText('10%')).toBeTruthy()

      act(() => {
        emit(tick(20))
        emit(tick(30))
      })
      expect(screen.getByText('10%')).toBeTruthy()
      expect(screen.queryByText('30%')).toBeNull()

      act(() => vi.advanceTimersByTime(1_999))
      expect(screen.queryByText('30%')).toBeNull()
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByText('30%')).toBeTruthy()

      act(() => {
        emit(tick(40))
        emit({
          downloadId: 'download:qwen',
          modelId: MODEL.id,
          fileName: MODEL.files[0]!.name,
          status: 'failed',
          reason: 'network connection lost'
        })
      })
      expect(screen.getByText('network connection lost')).toBeTruthy()
      expect(screen.queryByText('40%')).toBeNull()

      act(() => vi.advanceTimersByTime(2_000))
      expect(screen.getByText('network connection lost')).toBeTruthy()
      expect(screen.queryByText('40%')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
