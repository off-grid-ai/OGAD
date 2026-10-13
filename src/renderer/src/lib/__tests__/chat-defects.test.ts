import { preparingRunIds } from '../chat-run-lifecycle'
import {
  submitQueuedTurn,
  queuedDraftAfterSave,
  queuedAttachmentsAfterSave
} from '../chat-queue-submit'
import {
  planChatReplacement,
  replaceChatTurn,
  type ReplacementDependencies
} from '../chat-turn-replacement'
import { restoredStreamMessage } from '../chat-stream-restore'
import { describe, expect, it, vi } from 'vitest'
import {
  answerVersion,
  appendAnswerVersion,
  failedAnswerVersion,
  priorAnswerVersions,
  selectAnswerVersion
} from '../chat-versions'
import { editedBranch } from '../chat-edit-branch'
import { buildSendHistory } from '../../../../shared/chat-history'
import {
  readVersions,
  versionContent,
  selectedVersionRepairs
} from '../../../../shared/chat-versions'
import {
  createChatQueueStore,
  CHAT_QUEUE_SETTINGS_KEY,
  restoreChatQueues,
  type ChatQueues
} from '../chat-queue-store'
import { createQueueDrainer } from '../chat-queue-drain'
import {
  matchesRunCancel,
  settleUnownedStream,
  targetRun,
  unownedTerminal
} from '../chat-run-lifecycle'
import { observeOwnedRun } from '../chat-run-owner'
import {
  observedAnswer,
  persistObservedTurn,
  retainedFinalizedTurnCount,
  type TurnPersistence
} from '../chat-turn-persistence'
import { stopChatRun, type StopDependencies } from '../chat-stop'
import type { ChatMessage } from '../../components/MemoryChat/types'

const original: ChatMessage = {
  id: 'answer',
  role: 'assistant',
  content: 'Old answer',
  context: { sources: [{ name: 'old source', position: 1, score: 1 }], unified: [] },
  toolCalls: [{ name: 'web_search', result: 'Old result', status: 'completed' }],
  reasoning: 'Old reasoning',
  timeline: [{ kind: 'thinking', text: 'Old reasoning' }],
  metrics: { completionTokens: 12, totalSeconds: 2 },
  cutoff: { reason: 'max_tokens', maxTokens: 12 }
}
const next: ChatMessage = {
  id: 'answer',
  role: 'assistant',
  content: 'New answer',
  context: { sources: [] },
  reasoning: 'New reasoning',
  metrics: { completionTokens: 20 }
}

function persistence(): TurnPersistence {
  const messagesByConvRef = {
    current: { a: [{ ...original, id: 'stream', streaming: true }] } as Record<
      string,
      ChatMessage[]
    >
  }
  return {
    streamConvRef: { current: new Map([['stream', 'a']]) },
    messagesByConvRef,
    reasoningByStream: { current: { stream: 'Partial reasoning' } },
    timelineByStream: { current: {} },
    toolCallsByStream: { current: {} },
    answerByStream: { current: { stream: 'Partial answer' } },
    setConvMessages(cid, update) {
      messagesByConvRef.current[cid] = update(messagesByConvRef.current[cid] ?? [])
    },
    api: { updateRagMessage: vi.fn(async () => true), addRagMessage: vi.fn() }
  }
}

describe('chat answer records and edit branches', () => {
  it('switches every answer field and durable content; accepts legacy text versions', () => {
    const variants = appendAnswerVersion(priorAnswerVersions(original), next)!
    const selected = selectAnswerVersion({ ...next, variants, variantIndex: 1 }, -1)
    expect(selected).toMatchObject({
      content: original.content,
      reasoning: original.reasoning,
      metrics: original.metrics,
      toolCalls: original.toolCalls,
      timeline: original.timeline,
      cutoff: original.cutoff,
      context: original.context
    })
    expect(selectAnswerVersion(selected, 1)).toMatchObject({
      content: next.content,
      reasoning: next.reasoning,
      metrics: next.metrics,
      context: next.context
    })
    expect(selectAnswerVersion(selected, 1).toolCalls).toBeUndefined()
    expect(versionContent('legacy', '')).toBe('legacy')
    expect(readVersions({ variants: ['legacy', answerVersion(next)] })).toHaveLength(2)
    expect(readVersions({ variants: [null, 'bad'] })).toBeUndefined()
  })
  it('archives old answers under the old question; edited model history has matching pairs', () => {
    const question: ChatMessage = { id: 'q', role: 'user', content: 'Old question' }
    const branch = editedBranch([question, original], 0, 'New question')
    expect(branch.context.branches[0]).toEqual({
      question: 'Old question',
      answers: [answerVersion(original)]
    })
    const versions = appendAnswerVersion(priorAnswerVersions(next), {
      ...next,
      content: 'Second new answer'
    })!
    const selected = selectAnswerVersion({ ...next, variants: versions, variantIndex: 1 }, -1)
    expect(buildSendHistory([...branch.history, selected], false, 'Follow up')).toEqual([
      { role: 'user', content: 'New question' },
      { role: 'assistant', content: 'New answer' },
      { role: 'user', content: 'Follow up' }
    ])
    expect(branch.retainedCount).toBe(1)
  })
  it('keeps the previous answer and its complete context after failed regeneration', () => {
    const failed = failedAnswerVersion(original, 'Tool failed', priorAnswerVersions(original))
    expect(failed).toMatchObject({
      content: original.content,
      reasoning: original.reasoning,
      metrics: original.metrics,
      toolCalls: original.toolCalls,
      context: original.context
    })
    expect(selectAnswerVersion(failed, 1).content).toBe('Tool failed')
    expect(selectAnswerVersion(selectAnswerVersion(failed, 1), -1)).toMatchObject(original)
  })
})

describe('restored stream ownership and cancellation', () => {
  it.each(['done', 'error', 'cancel', 'cancelled'])(
    'releases an unowned %s stream after saving; the queue drains',
    async (terminal) => {
      const state = persistence()
      const busy = new Set(['a'])
      const send = vi.fn()
      expect(unownedTerminal(terminal, false)).toBe(true)
      expect(unownedTerminal(terminal, true)).toBe(false)
      await settleUnownedStream(
        () => persistObservedTurn(state, 'a', 'stream'),
        () => busy.delete('a'),
        send
      )
      expect(busy.size).toBe(0)
      expect(send).toHaveBeenCalledOnce()
      expect(state.api.updateRagMessage).toHaveBeenCalledWith(
        'a',
        'stream',
        'Partial answer',
        expect.objectContaining({
          reasoning: 'Partial reasoning',
          status: 'cancelled',
          sources: original.context!.sources
        })
      )
      await persistObservedTurn(state, 'a', 'stream')
      expect(state.api.updateRagMessage).toHaveBeenCalledOnce()
    }
  )
  it('ignores a cancel for a different run', () => {
    const state = persistence()
    const cancelledRef = { current: new Set<string>() }
    const cancelRag = vi.fn()
    const detail = { action: 'cancel' as const, conversationId: 'a', runId: 'send-old' }
    observeOwnedRun(detail, 'a', 'send-new', {
      ...state,
      cancelledRef,
      queuedRef: { current: {} },
      setQueuedByConv: vi.fn(),
      cancelRag,
      activeStream: () => 'new-stream'
    })
    expect(matchesRunCancel('send-old', 'send-new')).toBe(false)
    expect(cancelRag).not.toHaveBeenCalled()
    expect(cancelledRef.current.size).toBe(0)
    expect(
      targetRun(
        new Map([
          ['new-stream', 'a'],
          ['send-new', 'a']
        ]),
        'a'
      )
    ).toBe('send-new')
  })
  it('reattaches the sender reservation before cancelling a native image stream', () => {
    const state = persistence()
    const owner = new Map([['image:a', 'a']])
    const dependencies = {
      ...state,
      cancelledRef: { current: new Set<string>() },
      queuedRef: { current: {} },
      setQueuedByConv: vi.fn(),
      cancelRag: vi.fn()
    }
    observeOwnedRun(
      { action: 'attach', conversationId: 'a', owner },
      'a',
      'send-held',
      dependencies
    )
    expect(targetRun(owner, 'a')).toBe('send-held')
    const cancel = {
      action: 'cancel' as const,
      conversationId: 'a',
      runId: targetRun(owner, 'a'),
      preserveQueue: true,
      claimed: false
    }
    observeOwnedRun(cancel, 'a', 'send-held', dependencies)
    expect(cancel.claimed).toBe(true)
    expect(dependencies.cancelledRef.current.has('a')).toBe(true)
    expect(dependencies.cancelRag).not.toHaveBeenCalled()
  })
  it('captures the run before awaiting task Stop; a drained urgent send survives', async () => {
    const state = persistence()
    state.streamConvRef.current.set('send-old', 'a')
    const cancelRag = vi.fn()
    const dependencies: StopDependencies = {
      ...state,
      activeConversationId: 'a',
      cancelledRef: { current: new Set() },
      queuedRef: { current: {} },
      setQueuedByConv: vi.fn(),
      setAttachWarn: vi.fn(),
      stopLiveTask: async () => {
        state.streamConvRef.current = new Map([['send-new', 'a']])
        return true
      },
      dispatch: (detail) =>
        observeOwnedRun(detail, 'a', 'send-new', {
          ...state,
          cancelledRef: { current: new Set() },
          queuedRef: { current: {} },
          setQueuedByConv: vi.fn(),
          cancelRag,
          activeStream: () => 'new-stream'
        }),
      cancelRag,
      finalizeStoppedTurn: vi.fn(),
      markGenerating: vi.fn(),
      drainQueue: vi.fn(),
      imageGenConv: null,
      cancelImageGen: vi.fn(),
      setImageGenConv: vi.fn(),
      setImgProgress: vi.fn(),
      setLoading: vi.fn()
    }
    await stopChatRun(dependencies, 'a', { taskId: 'task', journeyId: 'a', kind: 'web_use' }, true)
    expect(cancelRag).not.toHaveBeenCalled()
    expect(dependencies.markGenerating).not.toHaveBeenCalled()
  })
})

describe('durable conversation queues', () => {
  const queues: ChatQueues = {
    a: [
      {
        text: 'queued',
        atts: [{ id: 'att', name: 'notes', kind: 'text', text: 'Attachment', status: 'ready' }],
        mode: 'ask',
        projectId: null
      }
    ],
    b: [{ text: 'other', atts: [], mode: 'image', projectId: 'p' }]
  }
  it('persists, restores and clears queues through the settings store', async () => {
    let saved: unknown
    const storage = {
      getSettings: async () => ({ [CHAT_QUEUE_SETTINGS_KEY]: saved }),
      saveSetting: vi.fn(async (_key, value) => {
        saved = value
      })
    }
    const first = createChatQueueStore(storage)
    await first.ready
    await first.publish(queues)
    const restored = createChatQueueStore(storage)
    await restored.ready
    expect(restored.ref.current).toEqual(queues)
    await restored.publish({ b: queues.b! })
    const third = createChatQueueStore(storage)
    await third.ready
    expect(third.ref.current).toEqual({ b: queues.b })
    expect(restoreChatQueues({ a: [null, { text: 'missing attachments' }] })).toEqual({})
  })
  it('keeps queued messages until sending and coalesces repeated drains', () => {
    let scheduled: (() => void) | undefined
    const drain = createQueueDrainer((callback) => {
      scheduled = callback
    })
    const state = {
      queues: { current: queues },
      blocked: () => false,
      publish: vi.fn(),
      send: vi.fn()
    }
    drain('a', state)
    drain('a', state)
    expect(state.queues.current.a).toHaveLength(1)
    scheduled!()
    expect(state.send).toHaveBeenCalledWith(queues.a![0])
    expect(state.queues.current.a).toEqual([])
  })
})

it('restores a stream with the durable answer identity and ordered thinking/tools', () => {
  expect(
    restoredStreamMessage({
      streamId: 'stream',
      messageId: 'durable',
      conversationId: 'a',
      content: 'partial',
      reasoning: 'thinking',
      reasoningRequested: true,
      phase: 'answering',
      tools: [{ name: 'web_search', status: 'completed', result: 'result' }]
    })
  ).toMatchObject({
    replacementMessageId: 'durable',
    content: 'partial',
    toolCalls: [{ name: 'web_search', result: 'result' }],
    timeline: [
      { kind: 'thinking', text: 'thinking' },
      { kind: 'tool', toolIndex: 0 }
    ]
  })
})
it('plans replacement versions only for the same question and releases failed preparation', async () => {
  const messages: ChatMessage[] = [{ id: 'q', role: 'user', content: 'Question' }, original]
  expect(planChatReplacement(messages, original.id)?.priorVariants).toEqual([
    answerVersion(original)
  ])
  expect(planChatReplacement(messages, 'q', 'Edited')?.priorVariants).toBeUndefined()
  expect(planChatReplacement(messages, 'missing')).toBeUndefined()
  const send = vi.fn()
  const release = vi.fn()
  const drain = vi.fn()
  const d: ReplacementDependencies = {
    conversationId: 'a',
    messages,
    generating: new Set(),
    cancelled: new Set(),
    newId: () => 'id',
    listen: () => release,
    markGenerating: vi.fn(),
    resetPreview: vi.fn(),
    stopTask: async () => {},
    update: async () => false,
    truncate: vi.fn(),
    removeTasks: vi.fn(),
    setMessages: vi.fn(),
    refresh: vi.fn(),
    announceSettled: () => false,
    drain,
    send
  }
  await replaceChatTurn(d, 'q', 'Edited')
  expect(send).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
  expect(drain).toHaveBeenCalledWith('a')
})

it('repairs only valid selected versions in legacy rows', () => {
  expect(
    selectedVersionRepairs([
      {
        id: 1,
        content: 'latest',
        context: JSON.stringify({ variants: ['old', 'latest'], variantIndex: 0 })
      },
      { id: 2, content: 'same', context: 'invalid' },
      {
        id: 3,
        content: 'same',
        context: JSON.stringify({ variants: ['old', 'same'], variantIndex: 99 })
      }
    ])
  ).toEqual([
    {
      id: 1,
      content: 'old',
      context: JSON.stringify({ variants: ['old', 'latest'], variantIndex: 0 })
    }
  ])
})

it('projects a partial even when a conversation load removed its temporary row', () => {
  expect(
    observedAnswer(undefined, {
      id: 'orphan',
      content: 'Partial answer',
      reasoning: 'Partial reasoning'
    })
  ).toMatchObject({
    id: 'orphan',
    content: 'Partial answer',
    reasoning: 'Partial reasoning',
    streaming: false,
    context: { status: 'cancelled', reasoning: 'Partial reasoning' }
  })
})

it('saves queued text before clearing the draft and preserves the submitted Stop target', async () => {
  let save: (() => void) | undefined
  const stored = new Promise<void>((resolve) => {
    save = resolve
  })
  const store = createChatQueueStore({
    getSettings: async () => ({}),
    saveSetting: async () => stored
  })
  await store.ready
  const clearDraft = vi.fn()
  const stop = vi.fn(async () => {})
  const submitted = submitQueuedTurn(
    store,
    'a',
    new Set(['a']),
    { text: 'urgent', atts: [], mode: 'ask', projectId: null },
    { sendNow: true, clearDraft, stop }
  )
  await Promise.resolve()
  expect(clearDraft).not.toHaveBeenCalled()
  save!()
  expect(await submitted).toBe(true)
  expect(clearDraft).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalledOnce()
  expect(
    await submitQueuedTurn(
      store,
      'b',
      new Set(['a']),
      { text: 'fresh', atts: [], mode: 'ask', projectId: null },
      { stop }
    )
  ).toBe(false)
})

it('keeps newer composer edits while a queued message is being saved', () => {
  expect(queuedDraftAfterSave('queued', 'queued')).toBe('')
  expect(queuedDraftAfterSave('new draft', 'queued')).toBe('new draft')
  const queued = {
    id: 'q',
    name: 'queued',
    kind: 'text' as const,
    text: '',
    status: 'ready' as const
  }
  const added = { ...queued, id: 'new' }
  expect(queuedAttachmentsAfterSave([queued, added], [queued])).toEqual([added])
})

it('cancels preparation only in the target conversation', () => {
  expect(
    preparingRunIds(
      new Map([
        ['prepare-a', 'a'],
        ['prepare-b', 'b'],
        ['send-a', 'a']
      ]),
      'a'
    )
  ).toEqual(['prepare-a'])
})

// Separate maps model a sender that survives navigation and a newly mounted observer.
it.each(['stop-first', 'terminal-first', 'unclaimed-cancel', 'concurrent'])(
  'finalizes one partial across observers (%s)',
  async (order) => {
    const first = persistence()
    first.api.updateRagMessage = vi.fn(async () => false)
    first.api.addRagMessage = vi.fn(async () => ({
      id: 1,
      uuid: 'saved'
    }))
    const second = {
      ...first,
      streamConvRef: { current: new Map([['stream', 'a']]) }
    }
    const stopDependencies: StopDependencies = {
      ...first,
      activeConversationId: 'a',
      cancelledRef: { current: new Set() },
      queuedRef: { current: {} },
      setQueuedByConv: vi.fn(),
      setAttachWarn: vi.fn(),
      stopLiveTask: async () => true,
      dispatch: vi.fn(),
      cancelRag: vi.fn(),
      finalizeStoppedTurn: () => persistObservedTurn(first, 'a', 'stream'),
      markGenerating: vi.fn(),
      drainQueue: vi.fn(),
      imageGenConv: null,
      cancelImageGen: vi.fn(),
      setImageGenConv: vi.fn(),
      setImgProgress: vi.fn(),
      setLoading: vi.fn()
    }
    const stop = (): Promise<void> => stopChatRun(stopDependencies, 'a', null)
    const terminal = (): Promise<void> =>
      settleUnownedStream(
        () => persistObservedTurn(second, 'a', 'stream'),
        () => {},
        () => {}
      )
    if (order === 'concurrent') await Promise.all([stop(), terminal()])
    else if (order === 'unclaimed-cancel') {
      await terminal()
      await terminal()
    } else if (order === 'terminal-first') {
      await terminal()
      await stop()
    } else {
      await stop()
      await terminal()
    }
    expect(first.api.addRagMessage).toHaveBeenCalledOnce()
    expect(first.api.updateRagMessage).toHaveBeenCalledOnce()
    expect(first.messagesByConvRef.current.a).toHaveLength(1)
    expect(first.messagesByConvRef.current.a![0]).toMatchObject({
      id: 'saved',
      content: 'Partial answer'
    })
  }
)

it('retains a pending save and a late observer only until the settlement grace expires', async () => {
  vi.useFakeTimers()
  try {
    const first = persistence()
    let finish!: (updated: boolean) => void
    first.api.updateRagMessage = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
    const saved = persistObservedTurn(first, 'a', 'stream')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(retainedFinalizedTurnCount(first.api)).toBe(1)
    finish(true)
    await saved
    await vi.advanceTimersByTimeAsync(4_999)
    const second = { ...first, streamConvRef: { current: new Map([['stream', 'a']]) } }
    await persistObservedTurn(second, 'a', 'stream')
    expect(first.api.updateRagMessage).toHaveBeenCalledOnce()
    expect(retainedFinalizedTurnCount(first.api)).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(retainedFinalizedTurnCount(first.api)).toBe(0)
    expect(first.api.addRagMessage).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
