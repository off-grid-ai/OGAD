// @vitest-environment jsdom
//
// TRUE terminal-artifact test for the image-gen drift fix (hygiene §D: assert the
// terminal artifact from the REAL entry point, not a re-implemented state machine).
//
// The terminal artifact is the `window.api.generateImage({...})` payload that crosses
// to the main process. Here we mount the REAL <MemoryChat/> under jsdom, fire REAL DOM
// events (open image mode + options, pick a model in the dropdown, type a steps value,
// type a prompt, click Send), and assert the payload the component actually handed to
// `generateImage`. Unlike the sibling image-params-wiring.test.ts — which replays a
// hand-written replica of the composer's state machine — nothing here re-implements the
// component: if the send path reads a stale local `imgSteps`, if the `[imgModel]` effect
// stops resolving the override, or if the dropdown's onChange stops routing through
// `setActiveModalModel`, this test goes RED because the REAL component produced the
// wrong payload.
//
// The two bugs this guards (both were user-visible):
//   (a) drift — composer showed steps=10 but generate ran the model default (28),
//       because a `[imgModel]` effect re-seeded local state and stomped the typed value.
//   (b) divergence — the composer's model dropdown didn't write through the same owner
//       as the Active-models panel, so the two disagreed on which model ran.

import { afterEach, describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'
import { registerHook } from '../../bootstrap/hookRegistry'
import { SYNC_SUBSCRIBE_INCOMING_FILES_HOOK, type IncomingSharedFile } from '../../lib/sync-hooks'
import {
  imageMemoryGuardErrorMessage,
  type ImageGenerationJobContract
} from '../../../../shared/image-generation-contract'

// The real app mounts MemoryChat inside a global TooltipProvider (App shell). Mirror
// that here so the composer's tooltip-wrapped controls render — this wraps the REAL
// component, it does not stub any of its behavior.
function renderChat(openTarget?: {
  conversationId?: string
  openGallery?: boolean
}): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <MemoryChat openTarget={openTarget} />
    </TooltipProvider>
  )
}

afterEach(() => cleanup())

const FEW_STEP = 'sdxl-lightning.gguf' // shared image-defaults: defaultSteps 10
const FULL = 'dreamlike-photoreal-v2.gguf' // shared image-defaults: defaultSteps 28

type GenPayload = {
  steps?: number
  model?: string
  width?: number
  height?: number
  prompt?: string
  negativePrompt?: string
  seed?: number
  cfgScale?: number
  allowUnsafeMemoryOverride?: boolean
  conversationId?: string
}

type ImageResult = {
  dataUrl: string
  path: string
  syncId?: string
  seed?: number
  model?: string
  prompt?: string
}
type ImageProgress = {
  phase: 'sampling' | 'decoding'
  step: number
  total: number
  secPerStep: number
  preview?: string
}
type GalleryImage = { path: string; name: string; mtime: number }
type TestConversation = {
  id: string
  title: string
  project_id: null
  created_at: string
  updated_at: string
  message_count: number
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

type ProcessImage = (
  bytes: ArrayBuffer,
  name: string
) => Promise<{ name: string; kind: 'image'; text: string; path?: string }>

type InstallApiOptions = {
  active: string
  models: string[]
  settings?: Record<string, unknown>
  styleThumbs?: Record<string, string>
  conversations?: TestConversation[]
  generate?: (payload: GenPayload) => Promise<ImageResult>
  chatVision?: boolean
  processFile?: Mock<ProcessImage>
  ragAnswer?: string
  /** Main-owned image job snapshot that imageGenJobStatus() reports on mount (reattach path). */
  jobStatus?: ImageGenerationJobContract
  /** Seed per-conversation persisted messages (getRagMessages), keyed by conversation id. */
  messages?: Record<string, unknown[]>
  toolResult?: {
    answer: string
    toolCalls: { name: string; result: string }[]
    unified: never[]
    imageRequests?: { prompt: string }[]
  }
}

type InstalledApi = {
  generateImage: Mock<(payload: GenPayload) => Promise<ImageResult>>
  emitConversationUpdated: (conversationId: string) => void
  emitJobState: (job: ImageGenerationJobContract) => void
  setActiveModalModel: Mock<(kind: string, model: string) => Promise<void>>
  toolChat: Mock<
    (...args: unknown[]) => Promise<{
      answer: string
      toolCalls: { name: string; result: string }[]
      unified: never[]
      imageRequests?: { prompt: string }[]
    }>
  >
  exportGeneratedImage: Mock<(...args: unknown[]) => Promise<void>>
  addRagMessage: Mock<(...args: unknown[]) => Promise<{ id: number; uuid: string }>>
  imageGenConversationPersisted: Mock<(...args: unknown[]) => Promise<void>>
  getRagMessages: Mock<(id: string) => Promise<unknown[]>>
  cancelImageGen: Mock<() => void>
  chatVisionAvailable: Mock<() => Promise<boolean>>
  processFile: Mock<ProcessImage>
  ragChat: Mock<(...args: unknown[]) => Promise<{ answer: string; context: { unified: never[] } }>>
  listGeneratedImages: Mock<() => Promise<GalleryImage[]>>
  replaceGeneratedGallery: (images: GalleryImage[]) => void
  emitIncomingFiles: (files: IncomingSharedFile[]) => void
  emitProgress: (value: ImageProgress) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Build a full in-process fake of the preload `window.api` bridge. Every method the
 *  component touches on mount / send is stubbed at the TRUE boundary (the IPC bridge),
 *  so the component code under test is 100% real. `generateImage` + `setActiveModalModel`
 *  are the assertion subjects; the rest resolve to inert defaults. */
function installApi(opts: InstallApiOptions): InstalledApi {
  const settings: Record<string, unknown> = { ...(opts.settings ?? {}) }
  const conversations = [...(opts.conversations ?? [])]
  const messages = new Map<string, unknown[]>(Object.entries(opts.messages ?? {}))
  const generatedGallery: GalleryImage[] = []
  let activeImageConversation: string | null = null
  let jobStateCb: ((job: ImageGenerationJobContract) => void) | null = null
  let convUpdatedCb: ((conversationId: string) => void) | null = null
  let incomingFilesCb: ((files: IncomingSharedFile[]) => void) | null = null
  registerHook(SYNC_SUBSCRIBE_INCOMING_FILES_HOOK, (cb: typeof incomingFilesCb) => {
    incomingFilesCb = cb
    return () => {
      incomingFilesCb = null
    }
  })
  const generate =
    opts.generate ??
    (async (payload: GenPayload) => ({
      dataUrl: 'data:image/png;base64,AAAA',
      path: '/tmp/out.png',
      seed: payload.seed,
      model: payload.model,
      prompt: payload.prompt
    }))
  const generateImage = vi.fn<(payload: GenPayload) => Promise<ImageResult>>(async (payload) => {
    activeImageConversation = payload.conversationId ?? null
    const result = await generate(payload)
    generatedGallery.unshift({
      path: result.path,
      name: result.path.split('/').pop() ?? 'generated.png',
      mtime: Date.now()
    })
    return result
  })
  const setActiveModalModel = vi.fn<(kind: string, model: string) => Promise<void>>(async () => {})
  // The agentic path's single entry point. Returns a benign text answer with no
  // imageRequest, so if the turn reaches the agent no generateImage call follows —
  // making "generateImage was/ wasn't called" an unambiguous terminal artifact.
  const toolChat = vi.fn(async () =>
    opts.toolResult
      ? structuredClone(opts.toolResult)
      : { answer: 'done', toolCalls: [], unified: [] }
  )
  const cancelImageGen = vi.fn<() => void>()
  const exportGeneratedImage = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
  let nextStoredMessageId = 1
  const addRagMessage = vi.fn(async () => {
    const id = nextStoredMessageId++
    return { id, uuid: `stored-message-${id}` }
  })
  const imageGenConversationPersisted = vi.fn(async () => {})
  // Timestamps are filled in where a seed omitted one. The renderer projects each row through
  // projectSyncedMessageTurn, which returns null for a message it cannot order, so an untimestamped
  // row is silently dropped and the conversation renders empty. The table this stands for always has
  // one - SQLite's CURRENT_TIMESTAMP default, in this shape.
  const getRagMessages = vi.fn(async (id: string) =>
    (messages.get(id) ?? []).map((row, index) => ({
      created_at: `2026-01-01 09:00:0${index}`,
      ...(row as Record<string, unknown>)
    }))
  )
  const chatVisionAvailable = vi.fn(async () => opts.chatVision ?? true)
  const processFile =
    opts.processFile ??
    vi.fn<ProcessImage>(async (_bytes: ArrayBuffer, name: string) => ({
      name,
      kind: 'image' as const,
      text: '',
      path: `/uploads/${name}`
    }))
  const ragChat = vi.fn(async (..._args: unknown[]) => ({
    answer: opts.ragAnswer ?? 'A red fox is standing in snow.',
    context: { unified: [] as never[] }
  }))
  const listGeneratedImages = vi.fn(async () => generatedGallery.map((image) => ({ ...image })))
  const api = {
    isPro: false,
    // --- assertion subjects ---
    generateImage,
    setActiveModalModel,
    // --- image engine probe (drives imgModels + imgModel on mount) ---
    imageGenStatus: vi.fn(async () => ({
      available: true,
      models: opts.models,
      active: opts.active
    })),
    cancelImageGen,
    // --- main-owned image job (the reattach-on-remount path) ---
    imageGenJobStatus: vi.fn(
      async (): Promise<ImageGenerationJobContract> =>
        opts.jobStatus ?? {
          id: null,
          phase: 'idle',
          conversationId: null,
          projectId: null,
          stage: null,
          enhancedPrompt: '',
          progress: null,
          outputPath: null,
          error: null,
          startedAt: null,
          finishedAt: null
        }
    ),
    onImageGenJobState: vi.fn((cb: (job: ImageGenerationJobContract) => void) => {
      jobStateCb = cb
      return () => {
        jobStateCb = null
      }
    }),
    onImageGenConversationUpdated: vi.fn((cb: (conversationId: string) => void) => {
      convUpdatedCb = cb
      return () => {
        convUpdatedCb = null
      }
    }),
    // --- conversation + persistence seams touched by the send path ---
    getRagConversations: vi.fn(async () => conversations.map((item) => ({ ...item }))),
    getRagConversation: vi.fn(async (id: string) => conversations.find((item) => item.id === id)),
    getRagMessages,
    createRagConversation: vi.fn(async (id: string, title: string) => {
      conversations.unshift({
        id,
        title,
        project_id: null,
        created_at: '2026-07-17T00:00:00.000Z',
        updated_at: '2026-07-17T00:00:00.000Z',
        message_count: 0
      })
      messages.set(id, [])
    }),
    addRagMessage,
    imageGenConversationPersisted,
    saveArtifact: vi.fn(async () => {}),
    exportGeneratedImage,
    // --- settings round-trip (per-model override persistence) ---
    getSettings: vi.fn(async () => settings),
    saveSetting: vi.fn(async (k: string, v: unknown) => {
      settings[k] = v
    }),
    // --- misc mount-time calls (inert) ---
    listProjects: vi.fn(async () => []),
    listArtifacts: vi.fn(async () => []),
    listGeneratedImages,
    styleThumbs: vi.fn(async () => ({ ...(opts.styleThumbs ?? {}) })),
    listSkills: vi.fn(async () => []),
    onRagStream: vi.fn(() => () => {}),
    chatVisionAvailable,
    processFile,
    ragChat,
    toolChat
  }
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
  return {
    generateImage,
    setActiveModalModel,
    toolChat,
    exportGeneratedImage,
    getRagMessages,
    addRagMessage,
    imageGenConversationPersisted,
    cancelImageGen,
    chatVisionAvailable,
    processFile,
    ragChat,
    listGeneratedImages,
    replaceGeneratedGallery(images: GalleryImage[]): void {
      generatedGallery.splice(0, generatedGallery.length, ...images)
    },
    emitIncomingFiles(files: IncomingSharedFile[]): void {
      incomingFilesCb?.(files)
    },
    emitProgress(value: ImageProgress): void {
      if (!activeImageConversation) return
      jobStateCb?.({
        id: 'live-image-job',
        phase: 'running',
        conversationId: activeImageConversation,
        projectId: null,
        stage: value.phase === 'decoding' ? 'decoding' : 'generating',
        enhancedPrompt: '',
        progress: value,
        outputPath: null,
        error: null,
        startedAt: 1,
        finishedAt: null
      })
    },
    emitConversationUpdated(conversationId: string): void {
      convUpdatedCb?.(conversationId)
    },
    emitJobState(job: ImageGenerationJobContract): void {
      jobStateCb?.(job)
    }
  }
}

/** Drive the composer into image mode with the options panel open. */
async function openImageComposer(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /^image$/i }))
  // Turning on image mode reveals the "Image options" toggle (a re-render). Wait for
  // it to mount before clicking, so a cold first-test mount doesn't race the click.
  const opts = await screen.findByRole('button', { name: /image options/i }, { timeout: 3000 })
  await user.click(opts)
}

/** The steps control is a numeric <input min=4 max=50>; find it by its spinbutton role. */
function stepsInput(): HTMLInputElement {
  const spinners = screen.getAllByRole('spinbutton') as HTMLInputElement[]
  // The steps input is the one bounded 4..50 (seed is text; strength is 0..1).
  const steps = spinners.find((el) => el.max === '50' && el.min === '4')
  if (!steps) throw new Error('steps <input min=4 max=50> not found in the image options')
  return steps
}

function typeSteps(value: number): void {
  // The steps <input type=number> is controlled and clamps on every keystroke
  // (onChange -> Math.max(4, Math.min(50, …))). A real edit commits one final value;
  // fire a single change event with that value, which is the faithful DOM signal.
  fireEvent.change(stepsInput(), { target: { value: String(value) } })
}

async function sendPrompt(user: ReturnType<typeof userEvent.setup>, prompt: string): Promise<void> {
  const textarea = screen.getByPlaceholderText(/describe an image to generate/i)
  ;(textarea as HTMLTextAreaElement).focus()
  await user.type(textarea, prompt, { skipClick: true })
  await user.click(screen.getByRole('button', { name: /^send$/i }))
}

describe('<MemoryChat/> image mode — the generateImage payload is the terminal artifact', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    // jsdom has no layout engine. Polyfill the layout APIs MemoryChat + Radix touch so
    // an effect doesn't throw an async ResizeObserver/scroll error that taints the run.
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:attachment-preview')
    })
    Object.defineProperty(File.prototype, 'arrayBuffer', {
      configurable: true,
      value: async () => new ArrayBuffer(8)
    })
  })

  it('opens the real Gallery when a synced generated-file destination targets it', async () => {
    installApi({ active: FULL, models: [FULL] })
    renderChat({ openGallery: true })
    expect(await screen.findByRole('dialog', { name: 'Gallery' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^images/i })).toBeTruthy()
  })

  it('shows bundled style previews without a runtime generation control', async () => {
    const user = userEvent.setup()
    installApi({
      active: FULL,
      models: [FULL],
      styleThumbs: {
        Photoreal: '/app/resources/style-thumbs/Photoreal.png',
        Cinematic: '/app/resources/style-thumbs/Cinematic.png'
      }
    })
    renderChat()

    await openImageComposer(user)

    expect((await screen.findByAltText('Photoreal')).getAttribute('src')).toBe(
      'ogcapture:///app/resources/style-thumbs/Photoreal.png'
    )
    expect(screen.getByAltText('Photoreal').closest('button')?.className).toContain('aspect-[16/9]')
    expect((await screen.findByAltText('Cinematic')).getAttribute('src')).toBe(
      'ogcapture:///app/resources/style-thumbs/Cinematic.png'
    )
    expect(screen.queryByRole('button', { name: /generate previews/i })).toBeNull()
  })

  it('shows the same style previews inline when Image is opened in an existing chat', async () => {
    const user = userEvent.setup()
    const conv: TestConversation = {
      id: 'existing-image-chat',
      title: 'Existing image chat',
      project_id: null,
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z',
      message_count: 1
    }
    installApi({
      active: FULL,
      models: [FULL],
      conversations: [conv],
      messages: {
        [conv.id]: [{ id: 1, role: 'user', content: 'Draw a dog' }]
      },
      styleThumbs: {
        Photoreal: '/app/resources/style-thumbs/Photoreal.png',
        Cinematic: '/app/resources/style-thumbs/Cinematic.png'
      }
    })
    renderChat({ conversationId: conv.id })

    expect(await screen.findByText('Draw a dog')).toBeTruthy()
    await openImageComposer(user)

    expect((await screen.findByAltText('Photoreal')).getAttribute('src')).toBe(
      'ogcapture:///app/resources/style-thumbs/Photoreal.png'
    )
    expect(screen.getByRole('region', { name: 'Image style presets' })).toBeTruthy()
    expect(screen.getByAltText('Photoreal').closest('button')?.className).toContain('h-48')
    expect((await screen.findByAltText('Cinematic')).getAttribute('src')).toBe(
      'ogcapture:///app/resources/style-thumbs/Cinematic.png'
    )
  })

  it('reloads a received image while Gallery is open, then Escape restores trigger focus', async () => {
    const user = userEvent.setup()
    const api = installApi({ active: FULL, models: [FULL] })
    renderChat()

    const trigger = await screen.findByTitle('Generated images')
    act(() => {
      api.emitIncomingFiles([
        {
          syncId: 'sync-image',
          name: 'synced-image.png',
          fileSize: 10,
          mimeType: 'image/png',
          kind: 'generated-image'
        }
      ])
    })
    await user.click(trigger)
    expect(await screen.findByRole('dialog', { name: 'Gallery' })).toBeTruthy()
    await waitFor(() => expect(api.listGeneratedImages).toHaveBeenCalledTimes(1))

    api.replaceGeneratedGallery([
      { path: '/received/synced-image.png', name: 'synced-image.png', mtime: 1 }
    ])
    act(() => api.emitIncomingFiles([]))

    expect(await screen.findByAltText('synced-image.png')).toBeTruthy()
    expect(api.listGeneratedImages).toHaveBeenCalledTimes(2)

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Gallery' })).toBeNull()
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('closes Gallery when the user clicks its scrim', async () => {
    const user = userEvent.setup()
    installApi({ active: FULL, models: [FULL] })
    renderChat()

    const trigger = await screen.findByTitle('Generated images')
    await user.click(trigger)
    expect(await screen.findByRole('dialog', { name: 'Gallery' })).toBeTruthy()

    const scrim = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')
    expect(scrim).not.toBeNull()
    // Radix defers its outside-pointer listener by one task so the opening click cannot close it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await user.click(scrim!)

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Gallery' })).toBeNull()
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('renders the conversation list as an accessible resizable panel without a fixed inner width', async () => {
    installApi({ active: FULL, models: [FULL] })
    renderChat()

    const resizeHandle = await screen.findByRole('separator', {
      name: 'Resize conversation list'
    })
    expect(resizeHandle.className).toContain('cursor-col-resize')
    const historyPanel = document.querySelector<HTMLElement>(
      '[data-panel-id="conversation-history"]'
    )
    expect(historyPanel).not.toBeNull()
    expect(historyPanel?.dataset.panelSize).toBe('20.0')
    expect(historyPanel?.querySelector('.w-64')).toBeNull()
    expect(historyPanel?.className).toContain('transition-[flex-grow]')
    const newChat = screen.getByRole('button', { name: 'New chat' })
    expect(newChat.parentElement?.className).toContain('px-2')
    expect(newChat.parentElement?.className).not.toContain('p-3')
    expect(document.querySelector('[data-panel-id="chat"]')?.className).toContain(
      'transition-[flex-grow]'
    )
    const toggle = screen.getByRole('button', { name: 'Collapse conversation list' })
    expect(toggle.closest('header')?.firstElementChild).toBe(toggle)
    expect(historyPanel?.querySelector('[aria-label="Collapse conversation list"]')).toBeNull()
    expect(screen.queryByTitle('Show conversations')).toBeNull()
  })

  it('carries the USER-typed steps (10), not the model default (28), and the picked model', async () => {
    const user = userEvent.setup()
    // Engine reports the full checkpoint (default 28) active, plus the few-step one.
    const { generateImage, setActiveModalModel } = installApi({
      active: FULL,
      models: [FULL, FEW_STEP]
    })
    renderChat()

    await openImageComposer(user)
    // Model select must be present (imgModels.length > 1) and reflect the active model.
    const modelSelect = (await screen.findByDisplayValue(
      /dreamlike-photoreal-v2/i,
      {},
      { timeout: 3000 }
    )) as HTMLSelectElement
    expect(modelSelect).toBeTruthy()

    // User overrides steps to 10 (the model's default is 28).
    typeSteps(10)
    await sendPrompt(user, 'a red fox in the snow')

    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1))
    const payload = generateImage.mock.calls[0]![0] as GenPayload
    // Bug (a): the send path used to hand over the stomped default (28). Assert 10.
    expect(payload.steps).toBe(10)
    expect(payload.steps).not.toBe(28)
    // The model is the active/picked one, carried through to the engine.
    expect(payload.model).toBe(FULL)
    // Bug (b): the composer binds to the shared owner. On mount it reads active; a
    // dropdown change writes through setActiveModalModel (asserted in the next test).
    expect(setActiveModalModel).toBeTruthy()
  })

  it('reattaches an in-flight image job on remount and shows the progress panel (survives navigation)', async () => {
    // A job was started, then the user left the Chat screen and came back → MemoryChat remounts.
    // Main still reports the job running for this conversation; the fresh mount must re-derive the
    // VISIBLE in-flight UI (the progress panel), not just the internal owner. Regresses the
    // "it generated but the UI didn't show it" bug: reattach restores generatingConvs (the panel's
    // render gate), not only imageGenConv. Delete the markGenerating call in observe() → this fails.
    const conv: TestConversation = {
      id: 'c-img',
      title: 'Aurora',
      project_id: null,
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z',
      message_count: 0
    }
    installApi({
      active: FULL,
      models: [FULL],
      conversations: [conv],
      // The user already sent the prompt before navigating away, so the conversation has a turn.
      messages: {
        'c-img': [{ id: 1, role: 'user', content: 'a glass observatory under an aurora' }]
      },
      jobStatus: {
        id: 'job-1',
        phase: 'running',
        conversationId: 'c-img',
        projectId: null,
        stage: 'generating',
        enhancedPrompt: 'a glass observatory under an aurora',
        progress: { step: 3, total: 20, secPerStep: 1 },
        outputPath: null,
        error: null,
        startedAt: 1,
        finishedAt: null
      }
    })
    renderChat({ conversationId: 'c-img' })

    // The in-flight progress panel (gated on generatingConvs) renders with the live step counter —
    // proving the remount re-derived the whole in-flight UI from main, not a blank screen.
    // Delete the markGenerating(...) call in the reattach observe() → generatingConvs stays empty
    // → this panel never renders → the test goes red (the "generated but UI didn't show it" bug).
    expect(await screen.findByText('Generating image · Step 3 of 20')).toBeTruthy()
  })

  it('picking a different model in the dropdown routes through setActiveModalModel and reaches the payload', async () => {
    const user = userEvent.setup()
    const { generateImage, setActiveModalModel } = installApi({
      active: FULL,
      models: [FULL, FEW_STEP]
    })
    renderChat()
    await openImageComposer(user)

    const modelSelect = (await screen.findByDisplayValue(
      /dreamlike-photoreal-v2/i,
      {},
      { timeout: 3000 }
    )) as HTMLSelectElement
    // Switch to the few-step model via a REAL change event on the real <select>.
    await user.selectOptions(modelSelect, FEW_STEP)

    // Divergence fix: the dropdown MUST write through the same owner as the
    // Active-models panel, or the two silently disagree on which model runs.
    await waitFor(() => expect(setActiveModalModel).toHaveBeenCalledWith('image', FEW_STEP))

    await sendPrompt(user, 'a mountain lake')
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1))
    const payload = generateImage.mock.calls[0]![0] as GenPayload
    expect(payload.model).toBe(FEW_STEP)
    // Switching to the few-step model with no user override resolves to THAT model's
    // default (10), not a leftover value — proving the [imgModel] effect re-resolves.
    expect(payload.steps).toBe(10)
  })

  it('applies every existing image setting at the native boundary and reloads persisted values (#64)', async () => {
    const boundary = installApi({ active: FULL, models: [FULL, FEW_STEP] })
    const firstUser = userEvent.setup()
    const firstMount = renderChat()
    await openImageComposer(firstUser)

    const modelSelect = screen.getByLabelText('Model') as HTMLSelectElement
    await firstUser.selectOptions(modelSelect, FEW_STEP)
    await firstUser.selectOptions(modelSelect, FULL)
    await waitFor(() =>
      expect(boundary.setActiveModalModel).toHaveBeenLastCalledWith('image', FULL)
    )

    const sizeSelect = screen.getByLabelText('Size') as HTMLSelectElement
    await firstUser.selectOptions(sizeSelect, '768')
    typeSteps(17)
    fireEvent.change(screen.getByLabelText('Guidance'), { target: { value: '5.5' } })
    const seedInput = screen.getByLabelText('Seed') as HTMLInputElement
    seedInput.focus()
    await firstUser.type(seedInput, '4242', { skipClick: true })
    const negativePrompt = screen.getByPlaceholderText('Negative prompt') as HTMLInputElement
    negativePrompt.focus()
    await firstUser.type(negativePrompt, 'blurry, watermark', { skipClick: true })
    await sendPrompt(firstUser, 'a glass observatory under an aurora')

    await waitFor(() => expect(boundary.generateImage).toHaveBeenCalledTimes(1))
    expect(boundary.generateImage.mock.calls[0]![0]).toMatchObject({
      prompt: 'a glass observatory under an aurora',
      negativePrompt: 'blurry, watermark',
      model: FULL,
      width: 768,
      height: 768,
      steps: 17,
      cfgScale: 5.5,
      seed: 4242
    })
    expect(await screen.findByAltText('Generated')).toBeTruthy()
    expect(screen.getByLabelText('Image generation metadata').textContent).toContain(
      '768 × 768 · 17 steps · CFG 5.5 · seed 4242'
    )

    // The component persists per-model size/steps plus the global seed. A fresh
    // render must hydrate those controls and send the same values without editing.
    firstMount.unmount()
    boundary.generateImage.mockClear()
    const secondUser = userEvent.setup()
    renderChat()
    await openImageComposer(secondUser)

    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe(FULL)
    expect((screen.getByLabelText('Size') as HTMLSelectElement).value).toBe('768')
    expect(stepsInput().value).toBe('17')
    expect((screen.getByLabelText('Guidance') as HTMLInputElement).value).toBe('5.5')
    expect((screen.getByLabelText('Seed') as HTMLInputElement).value).toBe('4242')
    expect((screen.getByPlaceholderText('Negative prompt') as HTMLInputElement).value).toBe(
      'blurry, watermark'
    )

    await sendPrompt(secondUser, 'a second observatory')
    await waitFor(() => expect(boundary.generateImage).toHaveBeenCalledTimes(1))
    expect(boundary.generateImage.mock.calls[0]![0]).toMatchObject({
      prompt: 'a second observatory',
      negativePrompt: 'blurry, watermark',
      model: FULL,
      width: 768,
      height: 768,
      steps: 17,
      cfgScale: 5.5,
      seed: 4242
    })
  })
})

// Send a message in the DEFAULT chat composer (not image mode).
async function sendChat(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  const textarea = await screen.findByPlaceholderText(/ask anything/i, {}, { timeout: 3000 })
  ;(textarea as HTMLTextAreaElement).focus()
  await user.type(textarea, text, { skipClick: true })
  await user.click(screen.getByRole('button', { name: /^send$/i }))
}

// Bug 4 (root of the image-gen-as-tool bug): the renderer's keyword auto-route and
// the agent's tool decision both decided "is this an image request?" for the same
// turn. With tools on, "draw ..." was hijacked by the renderer's direct generate,
// so the generate_image TOOL never ran. The terminal artifacts: which IPC the turn
// actually crosses on (toolChat = agent path, generateImage = direct route).
describe('<MemoryChat/> chat mode — image intent is decided in ONE place', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  })

  it('with tools ON, a "draw ..." turn goes to the agent (toolChat), NOT the renderer direct-generate', async () => {
    const user = userEvent.setup()
    // composerToolsOn is persisted in settings and read into toolsOn on mount.
    const { generateImage, toolChat } = installApi({
      active: FULL,
      models: [FULL],
      settings: { composerToolsOn: true }
    })
    renderChat()

    await sendChat(user, 'draw a dog')

    // The turn crossed on the agentic path...
    await waitFor(() => expect(toolChat).toHaveBeenCalledTimes(1))
    // ...and the renderer did NOT pre-decide + fire a direct image generation.
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('with tools OFF, the same "draw ..." turn auto-routes to direct image generation', async () => {
    const user = userEvent.setup()
    const { generateImage, toolChat } = installApi({ active: FULL, models: [FULL] })
    renderChat()

    await sendChat(user, 'draw a dog')

    // No agent in plain chat — the renderer keyword auto-route generates directly.
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1))
    expect(toolChat).not.toHaveBeenCalled()
    const payload = generateImage.mock.calls[0]![0] as GenPayload
    expect(payload.prompt).toBe('a dog') // cleanImagePrompt stripped the verb
  })

  it('generates, associates, and renders one distinct image for every completed image tool call', async () => {
    const outputs = [
      {
        dataUrl: 'data:image/png;base64,FIRST',
        path: '/generated/first.png',
        syncId: 'image-sync-first'
      },
      {
        dataUrl: 'data:image/png;base64,SECOND',
        path: '/generated/second.png',
        syncId: 'image-sync-second'
      }
    ]
    const boundary = installApi({
      active: FULL,
      models: [FULL],
      settings: { composerToolsOn: true },
      toolResult: {
        answer: 'I made both images.',
        toolCalls: [
          { name: 'generate_image', result: 'Image generation started' },
          { name: 'generate_image', result: 'Image generation started' }
        ],
        unified: [],
        imageRequests: [{ prompt: 'first scene' }, { prompt: 'second scene' }]
      },
      generate: async () => outputs.shift()!
    })
    const user = userEvent.setup()
    renderChat()

    await sendChat(user, 'make two different scenes')

    await waitFor(() => expect(boundary.generateImage).toHaveBeenCalledTimes(2))
    expect(boundary.generateImage.mock.calls.map(([payload]) => payload.prompt)).toEqual([
      'first scene',
      'second scene'
    ])
    const generated = await screen.findAllByAltText('Generated')
    expect(generated.map((image) => image.getAttribute('src'))).toEqual([
      'data:image/png;base64,FIRST',
      'data:image/png;base64,SECOND'
    ])

    const persistedImages = boundary.addRagMessage.mock.calls.filter(
      ([, role, , context]) =>
        role === 'assistant' && !!(context as { imageRef?: unknown })?.imageRef
    )
    expect(persistedImages).toHaveLength(2)
    expect(
      persistedImages.map(([, , , context]) => (context as { imageRef: unknown }).imageRef)
    ).toEqual([
      { id: 'image-sync-first', path: '/generated/first.png' },
      { id: 'image-sync-second', path: '/generated/second.png' }
    ])
    expect(
      boundary.imageGenConversationPersisted.mock.calls.map(([, messageId]) => messageId)
    ).toEqual(['stored-message-3', 'stored-message-4'])

    await user.click(screen.getByTitle('Generated images'))
    expect(await screen.findByRole('button', { name: /images \(2\)/i })).toBeTruthy()
    expect(screen.getByAltText('first.png')).toBeTruthy()
    expect(screen.getByAltText('second.png')).toBeTruthy()
  })
})

function conversation(id: string, title: string): TestConversation {
  return {
    id,
    title,
    project_id: null,
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
    message_count: 0
  }
}

function imageInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"][accept="image/*"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('image attachment input not found')
  return input
}

describe('<MemoryChat/> image and vision release journeys', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:attachment-preview')
    })
    Object.defineProperty(File.prototype, 'arrayBuffer', {
      configurable: true,
      value: async () => new ArrayBuffer(8)
    })
  })

  it('renders a synced image attachment inline and opens the existing lightbox', async () => {
    const conv = conversation('c-synced-image', 'Synced image')
    installApi({
      active: FULL,
      models: [FULL],
      conversations: [conv],
      messages: {
        [conv.id]: [
          {
            uuid: 'message-image-1',
            role: 'assistant',
            content: 'Generated image for: "Draw a dog"',
            context: JSON.stringify({
              attachments: [
                {
                  id: 'image-1',
                  name: 'dog.png',
                  kind: 'image',
                  path: '/received/dog.png'
                }
              ]
            })
          }
        ]
      }
    })
    const user = userEvent.setup()
    renderChat({ conversationId: conv.id })

    const image = await screen.findByAltText('dog.png')
    expect(image.getAttribute('src')).toBe('ogcapture:///received/dog.png')
    expect(screen.queryByText('image')).toBeNull()

    await user.click(image)
    expect(screen.getByRole('dialog', { name: 'Generated image preview' })).toBeTruthy()
    expect(screen.getByAltText('Generated preview').getAttribute('src')).toBe(
      'ogcapture:///received/dog.png'
    )
  })

  it('shows live progress, renders one generated image, and opens and saves it (#61, #67)', async () => {
    const turn = deferred<ImageResult>()
    const boundary = installApi({
      active: FULL,
      models: [FULL],
      generate: () => turn.promise
    })
    const user = userEvent.setup()
    renderChat()

    await openImageComposer(user)
    await sendPrompt(user, 'a lighthouse during a winter storm')
    await waitFor(() => expect(boundary.generateImage).toHaveBeenCalledTimes(1))

    const conversationId = boundary.generateImage.mock.calls[0]![0].conversationId!
    act(() => {
      boundary.emitJobState({
        id: 'live-image-job',
        phase: 'running',
        conversationId,
        projectId: null,
        stage: 'enhancing',
        enhancedPrompt: 'A cinematic lighthouse in a fierce',
        progress: null,
        outputPath: null,
        error: null,
        startedAt: 1,
        finishedAt: null
      })
    })
    expect(await screen.findByText('A cinematic lighthouse in a fierce')).toBeTruthy()
    expect(screen.getByText('Enhancing prompt…')).toBeTruthy()

    act(() => {
      boundary.emitProgress({ phase: 'sampling', step: 4, total: 10, secPerStep: 0.5 })
    })
    expect(await screen.findByText('Generating image · Step 4 of 10')).toBeTruthy()

    const enhancedPrompt =
      'A cinematic lighthouse in a fierce winter storm, dramatic waves, cold blue light'
    turn.resolve({
      dataUrl: 'data:image/png;base64,AAAA',
      path: '/generated/lighthouse.png',
      prompt: enhancedPrompt
    })
    const generated = await screen.findByAltText('Generated')
    const caption = await screen.findByText('Generated for: a lighthouse during a winter storm')
    const disclosure = await screen.findByRole('button', { name: /enhanced prompt/i })
    expect(screen.getAllByAltText('Generated')).toHaveLength(1)
    expect(generated.className).toContain('w-full')
    expect(generated.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0
    )
    await user.click(disclosure)
    expect(screen.getByText(enhancedPrompt)).toBeTruthy()
    expect(boundary.addRagMessage).toHaveBeenCalledWith(
      expect.any(String),
      'assistant',
      expect.stringContaining(`__LABEL:Enhanced prompt__\n${enhancedPrompt}`),
      expect.any(Object)
    )

    await user.click(generated)
    expect(screen.getByRole('dialog', { name: 'Generated image preview' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() =>
      expect(boundary.exportGeneratedImage).toHaveBeenCalledWith(
        '/generated/lighthouse.png',
        'lighthouse.png'
      )
    )
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Generated image preview' })).toBeNull()
  })

  it('runs the same refused request only after explicit RAM override without remounting (#66)', async () => {
    const guardMessage =
      'Not enough memory to run oversized-image.safetensors (~14.0GB resident) on this 16GB machine. Pick a lighter image model (e.g. SDXL-Lightning or SD 1.5) in the image options.'
    const boundary = installApi({
      active: FULL,
      models: [FULL],
      generate: async (payload) => {
        if (!payload.allowUnsafeMemoryOverride) {
          throw new Error(
            `Error invoking remote method: Error: ${imageMemoryGuardErrorMessage(guardMessage)}`
          )
        }
        return {
          dataUrl: 'data:image/png;base64,AAAA',
          path: '/generated/safe-follow-up.png'
        }
      }
    })
    const user = userEvent.setup()
    renderChat()

    await openImageComposer(user)
    await sendPrompt(user, 'an oversized image request')

    expect(await screen.findByText(guardMessage)).toBeTruthy()
    expect(screen.queryByAltText('Generated')).toBeNull()
    const firstPayload = boundary.generateImage.mock.calls[0]![0]
    expect(firstPayload.allowUnsafeMemoryOverride).toBeUndefined()
    const promptOccurrencesBeforeRetry = screen.getAllByText('an oversized image request').length

    await user.click(screen.getByRole('button', { name: 'Run anyway' }))

    expect(await screen.findByAltText('Generated')).toBeTruthy()
    expect(boundary.generateImage).toHaveBeenCalledTimes(2)
    expect(boundary.generateImage.mock.calls[1]![0]).toEqual({
      ...firstPayload,
      allowUnsafeMemoryOverride: true
    })
    expect(screen.getAllByText('an oversized image request')).toHaveLength(
      promptOccurrencesBeforeRetry
    )
    expect(screen.getByText(guardMessage)).toBeTruthy()
  })

  it('keeps image progress and cancellation scoped to the conversation that owns the job (#62)', async () => {
    const turn = deferred<ImageResult>()
    const boundary = installApi({
      active: FULL,
      models: [FULL],
      conversations: [
        conversation('conversation-a', 'Conversation A'),
        conversation('conversation-b', 'Conversation B')
      ],
      generate: () => turn.promise
    })
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })
    await waitFor(() => expect(boundary.getRagMessages).toHaveBeenCalledWith('conversation-a'))

    await openImageComposer(user)
    await sendPrompt(user, 'a quiet forest')
    await waitFor(() => expect(boundary.generateImage).toHaveBeenCalledTimes(1))
    expect(boundary.generateImage.mock.calls[0]![0].conversationId).toBe('conversation-a')
    act(() => {
      boundary.emitProgress({ phase: 'sampling', step: 2, total: 8, secPerStep: 1 })
    })
    expect(await screen.findByText('Generating image · Step 2 of 8')).toBeTruthy()

    await user.click(screen.getByText('Conversation B'))
    await waitFor(() => expect(screen.queryByText('Generating image · Step 2 of 8')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(boundary.cancelImageGen).not.toHaveBeenCalled()

    const aTab = screen.getByRole('button', { name: 'Conversation A' })
    await user.click(aTab)
    await waitFor(() => expect(aTab.parentElement?.className).toContain('bg-neutral-800'))
    expect(
      screen.queryAllByRole('button', { name: /stop/i }).map((button) => button.textContent)
    ).toEqual(['Stop'])
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(boundary.cancelImageGen).toHaveBeenCalledTimes(1)
    turn.reject(new Error('cancelled'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull())
  })

  it('sends a ready image through the vision path and preserves the typed question (#68)', async () => {
    const boundary = installApi({
      active: FULL,
      models: [FULL],
      chatVision: true,
      ragAnswer: 'The image contains a red bicycle beside a stone wall.'
    })
    const user = userEvent.setup()
    renderChat()

    await user.upload(imageInput(), new File(['png'], 'bicycle.png', { type: 'image/png' }))
    expect(await screen.findByText('bicycle.png')).toBeTruthy()
    await sendChat(user, 'What is in this image?')

    expect(
      await screen.findByText('The image contains a red bicycle beside a stone wall.')
    ).toBeTruthy()
    expect(screen.getAllByText('What is in this image?').length).toBeGreaterThan(0)
    const ragArgs = boundary.ragChat.mock.calls[0]!
    expect(ragArgs[0]).toBe('What is in this image?')
    expect(ragArgs[8]).toEqual(['/uploads/bicycle.png'])
  })

  it('explains why a text-only model rejects an image and sends no unsupported content (#69)', async () => {
    const boundary = installApi({ active: FULL, models: [FULL], chatVision: false })
    const user = userEvent.setup()
    renderChat()
    await waitFor(() => expect(boundary.chatVisionAvailable).toHaveBeenCalled())

    await user.upload(imageInput(), new File(['png'], 'unsupported.png', { type: 'image/png' }))
    expect(
      await screen.findByText(/This model can't read images\. Switch to a vision model/i)
    ).toBeTruthy()
    expect(boundary.processFile).not.toHaveBeenCalled()
    expect(screen.queryByText('unsupported.png')).toBeNull()

    await sendChat(user, 'Continue with text only')
    expect(await screen.findByText('A red fox is standing in snow.')).toBeTruthy()
    expect(boundary.ragChat.mock.calls[0]![8]).toEqual([])
  })

  it('shows a damaged-image error and keeps the conversation usable (#70)', async () => {
    const boundary = installApi({
      active: FULL,
      models: [FULL],
      processFile: vi.fn(async () => {
        throw new Error('Unsupported or damaged image data.')
      })
    })
    const user = userEvent.setup()
    renderChat()

    await user.upload(imageInput(), new File(['broken'], 'damaged.png', { type: 'image/png' }))
    expect(await screen.findByText('Unsupported or damaged image data.')).toBeTruthy()

    await sendChat(user, 'The conversation should still work')
    expect(await screen.findByText('A red fox is standing in snow.')).toBeTruthy()
    expect(boundary.ragChat).toHaveBeenCalledTimes(1)
    expect(boundary.ragChat.mock.calls[0]![8]).toEqual([])
  })
})
