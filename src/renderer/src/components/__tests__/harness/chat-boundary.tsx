import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, vi } from 'vitest'
import { ThreadStore } from './thread-store'
import { MemoryChat } from '../../MemoryChat'
import { TooltipProvider } from '../../ui/tooltip'
import type {
  ActiveChatStreamContract,
  RagChatResultContract
} from '../../../../../shared/ipc-contracts'

export type StreamEvent = {
  streamId: string
  type: 'content' | 'reasoning' | 'step' | 'tool_result' | 'done' | 'error' | 'cancel' | 'image_request'
  request?: { prompt: string; enhancePrompt?: boolean }
  text?: string
  step?: unknown
  call?: { name: string; result: string; status: 'completed' | 'failed' | 'pending' }
}
type ThinkSplitter = { push: (text: string) => void; answer: () => string }
export type ThinkSplitterFactory = (
  emit: (event: { text: string; kind: 'content' | 'reasoning' }) => void
) => ThinkSplitter
type RagResult = RagChatResultContract & {
  imageRequests?: Array<{ prompt: string; enhancePrompt?: boolean }>
  unified?: unknown[]
  toolCalls?: Array<{
    name: string
    result: string
    status?: 'completed' | 'failed' | 'pending'
  }>
}
type StoredMessage = {
  id: number | string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  context?: unknown
  created_at?: string
}
type TaskSnapshot = {
  taskId: string
  journeyId?: string
  kind: 'web_use' | 'computer_use'
  title: string
  status: 'running' | 'paused' | 'waiting' | 'reconnecting' | 'done' | 'failed' | 'stopped'
  summary?: string
  steps: string[]
  currentAction?: string
  currentReasoning?: string
  reasoningLive?: boolean
  currentStep?: number
  startedAt: number
  updatedAt: number
}

/**
 * Every persisted message carries a timestamp, so this fake has to give one too.
 *
 * The renderer projects each row through projectSyncedMessageTurn, which REFUSES a message with no
 * usable createdAt and returns null - a message that cannot be ordered cannot be merged with one from
 * another device, and sync will not guess. MemoryChat drops those rows, so a fixture without a
 * timestamp renders as an empty conversation and every assertion about its content fails while
 * pointing at the wrong thing (no Copy button, no Speak button, no reply text).
 *
 * The real boundary cannot produce that row: the messages table defaults created_at to SQLite's
 * CURRENT_TIMESTAMP. Stamping here makes the fake match the seam it stands for, in the exact shape
 * SQLite writes (naive UTC, space-separated), rather than asking every fixture to remember it.
 *
 * Deterministic and increasing, so message order is fixture order and no test depends on a clock.
 */
const FIXTURE_EPOCH = Date.UTC(2026, 0, 1, 9, 0, 0)
const storedAt = (sequence: number): string =>
  new Date(FIXTURE_EPOCH + sequence * 1000).toISOString().replace('T', ' ').slice(0, 19)
type Conversation = {
  id: string
  title: string
  project_id: string | null
  /** 'god' for a God conversation; null for Chat (main's rag_conversations.surface). */
  surface?: string | null
  created_at: string
  updated_at: string
  message_count: number
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export class ChatBoundary {
  constructor(private readonly createSplitter?: ThinkSplitterFactory) {}

  readonly projects = [
    { id: 'project-alpha', name: 'Project Alpha' },
    { id: 'project-beta', name: 'Project Beta' }
  ]

  readonly conversations: Conversation[] = [
    this.conversation('conversation-a', 'Conversation A', 'project-alpha'),
    this.conversation('conversation-b', 'Conversation B', null)
  ]

  readonly messages: Record<string, StoredMessage[]> = {
    'conversation-a': [],
    'conversation-b': [
      { id: 1, role: 'assistant', content: 'Conversation B baseline', context: { unified: [] } }
    ]
  }

  readonly calls: {
    query: string
    projectId: string | null | undefined
    conversationId: string
    noMemory: boolean
    streamId: string
    thinking: boolean
    turn: ReturnType<typeof deferred<RagResult>>
  }[] = []
  readonly toolQueries: { query: string; options: Record<string, unknown> }[] = []

  readonly speechTurns: ReturnType<typeof deferred<{ dataUrl: string }>>[] = []
  readonly settings: Record<string, unknown> = {}
  readonly activeRagStreams: ActiveChatStreamContract[] = []

  private streamCallback: ((event: StreamEvent) => void) | null = null
  private taskChangedCallback: ((task: TaskSnapshot) => void) | null = null
  private conversationChangedCallback:
    | ((change: { conversationId: string; projectId?: string | null }) => void)
    | null = null
  private readonly rawSplitters = new Map<number, ThinkSplitter>()
  private readonly pendingConversationReads = new Map<string, ReturnType<typeof deferred<void>>>()
  private nextMessageId = 10
  private pendingUserWrite: ReturnType<typeof deferred<void>> | null = null
  private readonly heldUserWrites = new Set<ReturnType<typeof deferred<void>>>()
  private disposed = false

  readonly cancelRag = vi.fn((streamId: string) => {
    const restored = this.activeRagStreams.findIndex((stream) => stream.streamId === streamId)
    if (restored >= 0) this.activeRagStreams.splice(restored, 1)
    this.calls.find((call) => call.streamId === streamId)?.turn.reject(new Error('Cancelled'))
  })
  readonly listTasks = vi.fn(async () => [] as TaskSnapshot[])
  readonly stopComputerTask = vi.fn(async () => true)
  readonly guideTask = vi.fn(async () => ({ available: true, accepted: true }))
  readonly saveArtifact = vi.fn(async () => 'artifact-id')
  /** How main places, reads and chooses versions. */
  private readonly thread = new ThreadStore()

  readonly addRagMessage = vi.fn(
    async (
      conversationId: string,
      role: 'user' | 'assistant',
      content: string,
      context?: unknown
    ) => {
      if (role === 'user' && this.pendingUserWrite) {
        const gate = this.pendingUserWrite
        this.pendingUserWrite = null
        await gate.promise
        this.heldUserWrites.delete(gate)
      }
      this.messages[conversationId] ??= []
      const placed = this.thread.place(this.messages[conversationId]!, conversationId, role, context)
      const id = this.nextMessageId++
      const uuid = `message-${id}`
      this.messages[conversationId]!.push({
        id: uuid,
        role,
        content,
        context: placed,
        created_at: storedAt(this.nextMessageId)
      })
      const conversation = this.conversations.find((item) => item.id === conversationId)
      if (conversation) conversation.message_count = this.messages[conversationId]!.length
      return { id, uuid }
    }
  )

  readonly truncateRagMessages = vi.fn(async (conversationId: string, keepCount: number) => {
    this.messages[conversationId] = (this.messages[conversationId] ?? []).slice(0, keepCount)
    const conversation = this.conversations.find((item) => item.id === conversationId)
    if (conversation) conversation.message_count = this.messages[conversationId]!.length
  })

  readonly api = {
    isPro: false,
    // A file made in the page (jsdom) is an in-memory blob: the preload finds no path on disk for it.
    filePath: (): string => '',
    // Documents in a chat (preload `documents`): none attached unless a test attaches one.
    documents: {
      list: async (): Promise<unknown[]> => [],
      setExcluded: async (): Promise<void> => undefined,
      onProgress: (): (() => void) => () => undefined
    },
    imageGenStatus: vi.fn(async () => ({ available: false, models: [], active: '' })),
    cancelImageGen: vi.fn(),
    cancelRag: this.cancelRag,
    tasks: {
      list: this.listTasks,
      guideTask: this.guideTask,
      onChanged: vi.fn((callback: (task: TaskSnapshot) => void) => {
        this.taskChangedCallback = callback
        return () => {
          if (this.taskChangedCallback === callback) this.taskChangedCallback = null
        }
      })
    },
    vision: { control: this.stopComputerTask },
    onImageGenProgress: vi.fn(() => () => {}),
    onImageGenJobState: vi.fn(() => () => {}),
    onImageGenConversationUpdated: vi.fn(() => () => {}),
    imageGenJobStatus: vi.fn(async () => ({
      id: null,
      phase: 'idle' as const,
      conversationId: null,
      projectId: null,
      stage: null,
      enhancedPrompt: '',
      progress: null,
      outputPath: null,
      error: null,
      startedAt: null,
      finishedAt: null
    })),
    onRagConversationsChanged: vi.fn(
      (callback: (change: { conversationId: string; projectId?: string | null }) => void) => {
        this.conversationChangedCallback = callback
        return () => {
          if (this.conversationChangedCallback === callback) {
            this.conversationChangedCallback = null
          }
        }
      }
    ),
    onRagStream: vi.fn((callback: (event: StreamEvent) => void) => {
      this.streamCallback = callback
      return () => {
        this.streamCallback = null
      }
    }),
    getActiveRagStreams: vi.fn(async () => this.activeRagStreams.map((stream) => ({ ...stream }))),
    // As main filters it: 'god' lists God's conversations only, 'chat' leaves them out.
    getRagConversations: vi.fn(
      async (_projectId?: string | null, _page?: unknown, surface?: 'chat' | 'god') =>
        this.conversations
          .filter((item) =>
            surface === 'god'
              ? item.surface === 'god'
              : surface === 'chat'
                ? item.surface !== 'god'
                : true
          )
          .map((item) => ({ ...item }))
    ),
    getRagConversation: vi.fn(async (id: string) => {
      const found = this.conversations.find((item) => item.id === id)
      return found ? { ...found } : null
    }),
    getRagMessages: vi.fn(async (id: string) => {
      await this.pendingConversationReads.get(id)?.promise
      // The shown thread, as main returns it: each turn's chosen version, with its place among them.
      // created_at is filled in where a fixture omitted it, because the table it stands for always
      // has one and the renderer discards any row that does not.
      const rows = (this.messages[id] ?? []).map((item, index) => ({
        ...item,
        created_at: item.created_at ?? storedAt(index)
      }))
      return this.thread.read(rows)
    }),
    prepareAnswerVersion: vi.fn(async (conversationId: string, ofUuid: string) =>
      this.thread.prepareAnswerVersion(this.messages[conversationId] ?? [], conversationId, ofUuid)
    ),
    addRagMessageVersion: vi.fn(
      async (
        conversationId: string,
        ofUuid: string,
        role: 'user' | 'assistant',
        content: string,
        context?: unknown
      ) => {
        const parent = this.thread.versionParent(this.messages[conversationId] ?? [], ofUuid)
        if (parent === undefined) return null
        const base = context && typeof context === 'object' ? context : {}
        return this.addRagMessage(conversationId, role, content, { ...base, parent })
      }
    ),
    selectRagMessageVersion: vi.fn(async (conversationId: string, uuid: string, direction: number) =>
      Boolean(this.thread.select(this.messages[conversationId] ?? [], uuid, direction))
    ),
    createRagConversation: vi.fn(
      async (
        id: string,
        title = 'Untitled',
        projectId: string | null = null,
        surface?: 'chat' | 'god'
      ) => {
        this.conversations.unshift({
          ...this.conversation(id, title, projectId),
          surface: surface === 'god' ? 'god' : null
        })
        this.messages[id] = []
        return id
      }
    ),
    setRagConversationProject: vi.fn(async (id: string, projectId: string | null) => {
      const conversation = this.conversations.find((item) => item.id === id)
      if (conversation) conversation.project_id = projectId
    }),
    addRagMessage: this.addRagMessage,
    updateRagMessage: async (
      conversationId: string,
      messageId: string,
      content: string,
      context?: unknown
    ) => {
      const message = this.messages[conversationId]?.find((entry) => String(entry.id) === messageId)
      if (!message) return false
      message.content = content
      // As main does: the message keeps its place in the thread.
      if (context !== undefined) message.context = this.thread.update(message, context)
      return true
    },
    truncateRagMessages: this.truncateRagMessages,
    saveArtifact: this.saveArtifact,
    artifactRuntime: async () => ({}),
    createArtifactPreview: async (html: string) => `data:text/html,${encodeURIComponent(html)}`,
    revokeArtifactPreview: async () => true,
    suggestNextChatMessage: async (): Promise<string | null> => null,
    speak: vi.fn(() => {
      const turn = deferred<{ dataUrl: string }>()
      this.speechTurns.push(turn)
      return turn.promise
    }),
    ttsVoices: vi.fn(async () => [
      { id: 'af_heart', label: 'Heart', language: 'en-US' },
      { id: 'bf_emma', label: 'Emma', language: 'en-GB' }
    ]),
    prepareTtsVoice: vi.fn(async () => ({ ready: true })),
    onTtsVoiceProgress: vi.fn(() => () => {}),
    getSettings: vi.fn(async () => structuredClone(this.settings)),
    getLlmSettings: vi.fn(async () => ({})),
    saveSetting: vi.fn(async (key: string, value: unknown) => {
      this.settings[key] = structuredClone(value)
    }),
    listProjects: vi.fn(async () => this.projects.map((item) => ({ ...item }))),
    styleThumbs: vi.fn(async () => ({})),
    listSkills: vi.fn(async (): Promise<{ name: string; description: string }[]> => []),
    ragChat: vi.fn(
      async (
        query: string,
        _appName?: string,
        _history?: unknown[],
        projectId?: string | null,
        conversationId?: string,
        noMemory?: boolean,
        streamId?: string,
        thinking?: boolean
      ) => {
        const turn = deferred<RagResult>()
        this.calls.push({
          query,
          projectId,
          conversationId: conversationId!,
          noMemory: noMemory ?? false,
          streamId: streamId!,
          thinking: thinking ?? false,
          turn
        })
        if (this.disposed) turn.resolve({ answer: '', context: { unified: [] } })
        return turn.promise
      }
    ),
    toolChat: vi.fn(
      async (query: string, _history: unknown[], options: Record<string, unknown>) => {
        const turn = deferred<RagResult>()
        this.toolQueries.push({ query, options })
        this.calls.push({
          query,
          projectId: typeof options.projectId === 'string' ? options.projectId : null,
          conversationId: String(options.conversationId),
          noMemory: !options.projectId && !options.allMemory,
          streamId: String(options.streamId),
          thinking: !!options.thinking,
          turn
        })
        if (this.disposed) turn.resolve({ answer: '', context: { unified: [] } })
        return turn.promise
      }
    )
  }

  blockNextUserWrite(): void {
    this.pendingUserWrite = deferred<void>()
    this.heldUserWrites.add(this.pendingUserWrite)
  }

  releaseUserWrite(): void {
    for (const write of this.heldUserWrites) write.resolve()
  }

  /** Finish the boundary work that a production sender can still own after unmount. */
  dispose(): void {
    this.disposed = true
    this.releaseUserWrite()
    this.pendingUserWrite = null
    for (const read of this.pendingConversationReads.values()) read.resolve()
    this.pendingConversationReads.clear()
    for (const call of this.calls) call.turn.resolve({ answer: '', context: { unified: [] } })
    for (const speech of this.speechTurns) speech.resolve({ dataUrl: '' })
    this.activeRagStreams.length = 0
  }

  blockConversationRead(conversationId: string): void {
    this.pendingConversationReads.set(conversationId, deferred<void>())
  }

  releaseConversationRead(conversationId: string): void {
    this.pendingConversationReads.get(conversationId)?.resolve()
    this.pendingConversationReads.delete(conversationId)
  }

  emitStream(event: StreamEvent): void {
    this.streamCallback?.(event)
  }

  emit(callIndex: number, text: string): void {
    const call = this.calls[callIndex]!
    this.streamCallback?.({ streamId: call.streamId, type: 'content', text })
  }

  emitReasoning(callIndex: number, text: string): void {
    const call = this.calls[callIndex]!
    this.streamCallback?.({ streamId: call.streamId, type: 'reasoning', text })
  }

  emitToolStep(callIndex: number, name: string): void {
    const call = this.calls[callIndex]!
    this.streamCallback?.({
      streamId: call.streamId,
      type: 'step',
      step: { kind: 'running_tool', name }
    })
  }

  emitPreparingToolCalls(callIndex: number, name: string): void {
    const call = this.calls[callIndex]!
    this.streamCallback?.({
      streamId: call.streamId,
      type: 'step',
      step: { kind: 'preparing_tool_calls', name }
    })
  }

  emitToolResult(
    callIndex: number,
    name: string,
    result: string,
    status: 'completed' | 'failed' | 'pending' = 'completed'
  ): void {
    const call = this.calls[callIndex]!
    this.streamCallback?.({
      streamId: call.streamId,
      type: 'tool_result',
      call: { name, result, status }
    })
  }

  emitRaw(callIndex: number, text: string): void {
    const call = this.calls[callIndex]!
    let splitter = this.rawSplitters.get(callIndex)
    if (!splitter) {
      if (!this.createSplitter) throw new Error('Raw stream parser is not installed')
      splitter = this.createSplitter((event) => {
        this.streamCallback?.({ streamId: call.streamId, type: event.kind, text: event.text })
      })
      this.rawSplitters.set(callIndex, splitter)
    }
    splitter.push(text)
  }

  resolveRaw(callIndex: number): void {
    const answer = this.rawSplitters.get(callIndex)?.answer() ?? ''
    this.resolve(callIndex, answer)
  }

  resolve(
    callIndex: number,
    answer: string,
    result: Omit<Partial<RagResult>, 'answer'> = {}
  ): void {
    this.calls[callIndex]!.turn.resolve({ answer, context: { unified: [] }, ...result })
  }

  reject(callIndex: number, error: unknown): void {
    this.calls[callIndex]!.turn.reject(error)
  }

  emitTask(task: TaskSnapshot): void {
    this.taskChangedCallback?.(task)
  }

  emitConversationChanged(conversationId: string): void {
    this.conversationChangedCallback?.({ conversationId })
  }

  private conversation(id: string, title: string, projectId: string | null): Conversation {
    return {
      id,
      title,
      project_id: projectId,
      created_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z',
      message_count: 0
    }
  }
}

const installedBoundaries = new Set<ChatBoundary>()

afterEach(async () => {
  cleanup()
  // Queued turns can start after a reply settles. Keep the old API installed until
  // their timers and final storage promises finish, rather than leaking a sender
  // into the next test's boundary through window.api.
  let previousCallCount: number
  let callCount = -1
  do {
    previousCallCount = callCount
    await act(async () => {
      for (const boundary of installedBoundaries) boundary.dispose()
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(50)
      else await new Promise((resolve) => setTimeout(resolve, 50))
    })
    callCount = [...installedBoundaries].reduce(
      (total, boundary) => total + boundary.calls.length,
      0
    )
  } while (callCount !== previousCallCount)
  installedBoundaries.clear()
})

export function installBoundary(boundary: ChatBoundary): void {
  installedBoundaries.add(boundary)
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = boundary.api
}

export function renderChat(target: {
  conversationId?: string
  projectId?: string
  draftPrompt?: string
  presetId?: string
}): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <MemoryChat openTarget={target} />
    </TooltipProvider>
  )
}

export async function send(text: string, user: ReturnType<typeof userEvent.setup>): Promise<void> {
  // A menu that just closed animates out; until it is gone it holds focus and the page is inert.
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  const textarea = await screen.findByPlaceholderText(/^ask /i)
  await user.clear(textarea)
  await user.type(textarea, text)
  await user.click(screen.getByRole('button', { name: /^send$/i }))
}
