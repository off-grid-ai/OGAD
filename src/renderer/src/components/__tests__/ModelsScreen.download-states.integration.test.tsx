// @vitest-environment jsdom

// Integration: what the Models screen SHOWS you while a download runs, when it is refused, and when
// you cancel it. Real ModelsScreen; only window.api — the IPC line out of the renderer — is faked,
// and it emits exactly what the main process emits (a progress event on the channel AND the
// resolved result of the call), so the screen's behaviour is emergent rather than programmed.
//
// Grounded in the macOS session of 2026-08-09: a download the main process had REFUSED
// (reason=application_shutdown) left the card showing a spinner at 0% for hours with no message and
// no way to learn why. The card's job is to say what is true and offer the one action that helps.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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

/** The real DOWNLOAD_INTERRUPTED_ERROR string the main process returns for a refused request. */
const INTERRUPTED = 'interrupted - retry to resume'

type ProgressEvent = {
  modelId: string
  percent?: number
  status?: string
  currentFile?: string
  error?: string
  downloadedMB?: string
  totalMB?: string
  fileIndex?: number
  fileCount?: number
}

/** The main process, faked at the IPC boundary and only there. `downloadModel` behaves the way
 *  models-manager does: it publishes on the progress channel AND resolves with an outcome. Each
 *  test scripts what its download does; the screen decides what to render from that. */
let listeners: ((p: ProgressEvent) => void)[] = []
const emit = (p: ProgressEvent): void => listeners.forEach((l) => l(p))
let onDownload: (id: string) => Promise<{ success: boolean; error?: string }> = async () => ({
  success: true
})
let onCancel: (id: string) => void = () => {}

;(globalThis as unknown as { window: { api: unknown } }).window.api = {
  systemHealth: async () => ({ ramGb: 32 }),
  getModelCatalog: async () => ({ kinds: ['vision'], models: [MODEL] }),
  getInstalledModels: async () => [],
  getModelVisionStatus: async () => ({}),
  getActiveModelIds: async () => [],
  estimateModelFit: async () => ({ level: 'ok' }),
  onModelProgress: (cb: (p: ProgressEvent) => void) => {
    listeners.push(cb)
    return () => {
      listeners = listeners.filter((l) => l !== cb)
    }
  },
  downloadModel: (id: string) => onDownload(id),
  cancelModelDownload: (id: string) => onCancel(id)
}

let ModelsScreen: () => React.JSX.Element
beforeAll(async () => {
  ModelsScreen = (await import('../ModelsScreen')).ModelsScreen
})
beforeEach(() => {
  listeners = []
  onDownload = async () => ({ success: true })
  onCancel = () => {}
})
afterEach(cleanup)

// The catalog fixture holds exactly one model, so the screen IS that model's card and a screen-level
// query cannot be satisfied by a neighbour.

describe('<ModelsScreen/> — what a download looks like', () => {
  it('a refused download says why, and offers one way forward — never a silent 0%', async () => {
    // The main process refuses the request: it publishes 'failed' and resolves unsuccessfully.
    onDownload = async (id) => {
      emit({ modelId: id, status: 'failed', percent: 0, error: INTERRUPTED })
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
      emit({
        modelId: id,
        status: 'downloading',
        percent: 20,
        currentFile: MODEL.files[0]!.name,
        downloadedMB: '1331.2',
        totalMB: '6296.4',
        fileIndex: 1,
        fileCount: 2
      })
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    // Cancelling is what the main process does: it clears the card on the channel, and the pending
    // call resolves unsuccessfully with 'cancelled' — which is an outcome, not a failure.
    onCancel = (id) => {
      emit({ modelId: id, status: 'cancelled' })
      finish({ success: false, error: 'cancelled' })
    }
    const user = userEvent.setup()
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('button', { name: /^download$/i }))

    // BEFORE: it is genuinely downloading — progress on screen and a Cancel to press.
    expect(await screen.findByText(/20%/)).toBeTruthy()
    const cancel = screen.getByRole('button', { name: /cancel/i })

    await user.click(cancel)

    // Back to the start, with nothing red about a thing you chose to stop.
    expect(await screen.findByRole('button', { name: /^download$/i })).toBeTruthy()
    expect(screen.queryByText(/cancelled/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
    expect(screen.queryByText(/20%/)).toBeNull()
  })

  it('an in-flight download reads as one number, in human units, with the part it is fetching', async () => {
    onDownload = async (id) => {
      emit({
        modelId: id,
        status: 'downloading',
        percent: 20,
        currentFile: MODEL.files[0]!.name,
        downloadedMB: '1331.2',
        totalMB: '6296.4',
        fileIndex: 1,
        fileCount: 2
      })
      return new Promise(() => {}) // stays in flight
    }
    const user = userEvent.setup()
    render(<ModelsScreen />)
    await user.click(await screen.findByRole('button', { name: /^download$/i }))

    // One percent for the whole download.
    expect(await screen.findByText(/20%/)).toBeTruthy()
    // Bytes at the scale the card above already uses — 6296.4 MB is a number you have to convert.
    expect(screen.getByText(/1\.3 GB of 6\.1 GB/)).toBeTruthy()
    // Which part is moving, without giving it a second percent of its own.
    expect(screen.getByText(/file 1 of 2/)).toBeTruthy()
    // The action row holds the action, on the same line as the status.
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy()
  })
})
