import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi, type Mock } from 'vitest'
import { MemoryChat } from '../../MemoryChat'
import { TooltipProvider } from '../../ui/tooltip'
import type {
  ActiveChatStreamContract,
  RagChatResultContract
} from '../../../../../shared/ipc-contracts'

export type StreamEvent = {
  streamId: string
  type: 'content' | 'reasoning' | 'step' | 'tool_result'
  text?: string
  step?: unknown
  call?: { name: string; result: string; status: 'completed' | 'failed' | 'pending' }
}
type ThinkSplitter = { push: (text: string) => void; answer: () => string }
export type ThinkSplitterFactory = (
  emit: (event: { text: string; kind: 'content' | 'reasoning' }) => void
) => ThinkSplitter
type RagResult = RagChatResultContract & {
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

/**
 * The capability reads the production preload contract requires at Chat mount time.
 *
 * One owner for the fail-closed default: every fixture that installs a hand-built
 * `window.api` spreads this in, so a new required preload read is added here once
 * instead of failing each journey with "is not a function". A journey that needs a
 * capability on installs its own boundary after the spread.
 */
export function preloadCapabilityFakes(): { chatVisionAvailable: Mock<() => Promise<boolean>> } {
  return { chatVisionAvailable: vi.fn(async () => false) }
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

  readonly speechTurns: ReturnType<typeof deferred<{ dataUrl: string }>>[] = []
  readonly activeRagStreams: ActiveChatStreamContract[] = []

  private streamCallback: ((event: StreamEvent) => void) | null = null
  private taskChangedCallback: ((task: TaskSnapshot) => void) | null = null
  private conversationChangedCallback:
    | ((change: { conversationId: string; projectId?: string | null }) => void)
    | null = null
  private readonly rawSplitters = new Map<number, ThinkSplitter>()
  private nextMessageId = 10
  private pendingUserWrite: ReturnType<typeof deferred<void>> | null = null

  readonly cancelRag = vi.fn()
  readonly listTasks = vi.fn(async () => [] as TaskSnapshot[])
  readonly stopComputerTask = vi.fn(async () => true)
  readonly guideTask = vi.fn(async () => ({ available: true, accepted: true }))
  readonly saveArtifact = vi.fn(async () => 'artifact-id')
  readonly addRagMessage = vi.fn(
    async (
      conversationId: string,
      role: 'user' | 'assistant',
      content: string,
      context?: unknown
    ) => {
      if (role === 'user' && this.pendingUserWrite) {
        const gate = this.pendingUserWrite
        await gate.promise
        if (this.pendingUserWrite === gate) this.pendingUserWrite = null
      }
      this.messages[conversationId] ??= []
      const id = this.nextMessageId++
      const uuid = `message-${id}`
      this.messages[conversationId]!.push({
        id: uuid,
        role,
        content,
        context,
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

  private async modelControlSnapshot(): Promise<unknown> {
    const boundary = this.api as unknown as Record<string, (...args: never[]) => Promise<unknown>>
    const catalog = (await boundary.getModelCatalog?.()) as
      | { kinds?: string[]; models?: unknown[] }
      | undefined
    const activeText = (await boundary.getActiveModel?.()) as string | null | undefined
    const activeIds = (await boundary.getActiveModelIds?.()) as string[] | undefined
    const active = (await boundary.getActiveModalities?.()) as
      | Record<string, string | null>
      | undefined
    return {
      kinds: catalog?.kinds ?? [],
      models: catalog?.models ?? [],
      installed: [],
      activeIds: activeIds ?? (activeText ? [activeText] : []),
      active: {
        text: activeText ?? null,
        image: active?.image ?? null,
        speech: active?.speech ?? null,
        transcription: active?.transcription ?? null,
        computer_use: active?.computer_use ?? null
      },
      computerUse: null
    }
  }

  readonly api = {
    isPro: false,
    ...preloadCapabilityFakes(),
    // Canonical model-control evidence for Chat journeys. Thinking is visible only
    // because the active catalog model explicitly publishes that capability.
    getModelCatalog: vi.fn(async () => ({
      kinds: ['text'],
      models: [
        {
          id: 'chat-boundary-text',
          name: 'Chat boundary text model',
          kind: 'text',
          files: [],
          capabilities: { thinking: true }
        }
      ]
    })),
    getActiveModel: vi.fn(async () => 'chat-boundary-text'),
    getActiveModelIds: vi.fn(async () => ['chat-boundary-text']),
    getActiveModalities: vi.fn(async () => ({
      text: 'chat-boundary-text',
      image: null,
      speech: null,
      transcription: null,
      computer_use: null
    })),
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
    getRagConversations: vi.fn(async () => this.conversations.map((item) => ({ ...item }))),
    getRagConversation: vi.fn(async (id: string) => {
      const found = this.conversations.find((item) => item.id === id)
      return found ? { ...found } : null
    }),
    getRagMessages: vi.fn(async (id: string) =>
      // created_at is filled in where a fixture omitted it, because the table it stands for always has
      // one and the renderer discards any row that does not.
      (this.messages[id] ?? []).map((item, index) => ({
        ...item,
        created_at: item.created_at ?? storedAt(index)
      }))
    ),
    createRagConversation: vi.fn(
      async (id: string, title = 'Untitled', projectId: string | null = null) => {
        this.conversations.unshift(this.conversation(id, title, projectId))
        this.messages[id] = []
        return id
      }
    ),
    setRagConversationProject: vi.fn(async (id: string, projectId: string | null) => {
      const conversation = this.conversations.find((item) => item.id === id)
      if (conversation) conversation.project_id = projectId
    }),
    addRagMessage: this.addRagMessage,
    truncateRagMessages: this.truncateRagMessages,
    saveArtifact: this.saveArtifact,
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
    getSettings: vi.fn(async () => ({})),
    getModelControlSnapshot: vi.fn(() => this.modelControlSnapshot()),
    saveSetting: vi.fn(async () => {}),
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
        return turn.promise
      }
    )
  }

  blockNextUserWrite(): void {
    this.pendingUserWrite = deferred<void>()
  }

  releaseUserWrite(): void {
    this.pendingUserWrite?.resolve()
  }

  /** Main announced that this conversation's rows changed (a task result, a synced row). */
  changeConversation(conversationId: string): void {
    this.conversationChangedCallback?.({ conversationId })
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

export function installBoundary(boundary: ChatBoundary): void {
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = boundary.api
}

export function renderChat(target: {
  conversationId?: string
  projectId?: string
  draftPrompt?: string
}): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <MemoryChat openTarget={target} />
    </TooltipProvider>
  )
}

export async function send(text: string, user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const textarea = await screen.findByPlaceholderText(/^ask /i)
  await user.clear(textarea)
  await user.type(textarea, text)
  await user.click(screen.getByRole('button', { name: /^send$/i }))
}
