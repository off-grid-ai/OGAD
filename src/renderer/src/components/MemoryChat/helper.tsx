import {
  PROMPT_ENHANCEMENT_REASONING_LABEL,
  isPromptEnhancementStatus,
  projectSyncedMessageTurn,
  type ChatStreamPreviewRow,
  type ProjectedSyncedTool
} from '@offgrid/sync'
import {
  readAssistantTimeline,
  readGenerationMetrics,
  readReasoning,
  readResponseCutoff
} from '../../lib/message-persistence'
import { readGeneratedImageReference } from '../../../../shared/generated-image-reference'
import { captureUrlForPath } from '../../../../shared/ogcapture-url'
import type {
  Attachment,
  ChatMessage,
  ProjectedTurn,
  RagContext,
  RawRagMessage,
  StoredAttachment
} from './types'
import { isPromptEnhancementMessage, noticeText } from './utlis'
import type { TaskSession } from '@renderer/lib/task-session-store'

export function completedImageMessage(
  content: string,
  requestedPrompt: string,
  promptUsed?: string
): Pick<ChatMessage, 'content' | 'reasoning' | 'reasoningLabel'> & { storedContent: string } {
  const rewrittenPrompt = promptUsed?.trim()
  if (!rewrittenPrompt || rewrittenPrompt === requestedPrompt.trim()) {
    return { content, storedContent: content }
  }
  return {
    content,
    reasoning: rewrittenPrompt,
    reasoningLabel: PROMPT_ENHANCEMENT_REASONING_LABEL,
    storedContent: `<think>__LABEL:${PROMPT_ENHANCEMENT_REASONING_LABEL}__\n${rewrittenPrompt}</think>\n\n${content}`
  }
}

export async function announceImageMessagePersisted(
  conversationId: string,
  messageId: string
): Promise<void> {
  try {
    await window.api.imageGenConversationPersisted?.(conversationId, messageId)
  } catch {
    /* The message is already durable; a later mount still loads it from SQLite. */
  }
}

export function attachmentsOf(message: { attachments?: StoredAttachment[] }): Attachment[] {
  return (message.attachments ?? []).map((attachment, index) => ({
    id: `stored-${index}-${attachment.path ?? attachment.name}`,
    name: attachment.name,
    kind: attachment.kind as Attachment['kind'],
    text: attachment.text ?? '',
    path: attachment.path,
    status: 'ready' as const
  }))
}

export function parseRagContext(context: unknown): RagContext | undefined {
  if (typeof context === 'string') {
    try {
      return JSON.parse(context) as RagContext
    } catch {
      return undefined
    }
  }
  return context && typeof context === 'object' ? (context as RagContext) : undefined
}

export function readRagProvenance(message: RawRagMessage): ChatMessage['provenance'] {
  if (
    typeof message.origin_device_id !== 'string' ||
    typeof message.origin_device_name !== 'string'
  ) {
    return undefined
  }
  return {
    originDeviceId: message.origin_device_id,
    originDeviceName: message.origin_device_name
  }
}

function promptEnhancementMessage(
  message: RawRagMessage,
  provenance: ChatMessage['provenance']
): ChatMessage | undefined {
  if (message.role !== 'assistant' || !isPromptEnhancementStatus(message.content)) return undefined
  const id = String(message.uuid ?? message.id ?? '')
  return id ? { id, role: 'assistant', content: message.content, provenance } : undefined
}

function shouldHideProjectedTurn(turn: ReturnType<typeof projectSyncedMessageTurn>): boolean {
  return Boolean(
    turn &&
    turn.role === 'assistant' &&
    turn.status !== 'failed' &&
    turn.status !== 'cancelled' &&
    turn.tools.length === 0 &&
    !(turn.answer ?? turn.content).trim() &&
    turn.reasoning === undefined
  )
}

function projectedTurnContent(turn: ProjectedTurn): string {
  if (turn.role !== 'assistant') return turn.content
  return turn.answer ?? turn.content
}

function projectedTurnTools(turn: ProjectedTurn): Partial<ChatMessage> {
  if (turn.role === 'assistant') {
    return {
      toolCalls: turn.tools.length > 0 ? turn.tools : undefined,
      generationTimeMs: turn.durationMs
    }
  }
  if (turn.role === 'tool') {
    return {
      toolName: turn.tools[0]?.name,
      toolCallId: turn.tools[0]?.id,
      generationTimeMs: turn.tools[0]?.durationMs
    }
  }
  return { generationTimeMs: turn.durationMs }
}

function projectChatMessage(turn: ProjectedTurn, context?: RagContext): ChatMessage {
  const imageReference = readGeneratedImageReference(context)
  return {
    id: turn.id,
    role: turn.role,
    content: projectedTurnContent(turn),
    createdAt: turn.createdAt,
    context,
    reasoning: turn.reasoning ?? readReasoning(context),
    timeline: readAssistantTimeline(context),
    cutoff: readResponseCutoff(context),
    metrics: readGenerationMetrics(context),
    toolsOffered: turn.toolsOffered,
    ...projectedTurnTools(turn),
    turnStatus: turn.status,
    notice: turn.notice,
    reasoningLabel: turn.reasoningLabel,
    provenance: turn.provenance,
    image: imageReference ? captureUrlForPath(imageReference.path) : undefined,
    imagePath: imageReference?.path,
    imageMetadata: context?.imageMetadata,
    attachments: Array.isArray(context?.attachments) ? context.attachments : undefined
  }
}

function mapRagMessage(message: RawRagMessage): ChatMessage[] {
  const context = parseRagContext(message.context)
  const provenance = readRagProvenance(message)
  if (
    context?.notice &&
    (noticeText(message.content) === 'Compacted' || message.content.startsWith('Model changed: '))
  ) {
    const id = String(message.uuid ?? message.id ?? '')
    return id ? [{ id, role: 'assistant', content: message.content, notice: true }] : []
  }
  const promptEnhancement = promptEnhancementMessage(message, provenance)
  if (promptEnhancement) return [promptEnhancement]
  const turn = projectSyncedMessageTurn({
    id: String(message.uuid ?? message.id),
    role: message.role,
    content: message.content,
    context: message.context,
    createdAt: message.created_at,
    provenance
  })
  if (!turn || shouldHideProjectedTurn(turn)) return []
  return [projectChatMessage(turn, context)]
}

const groupedTurnCache = new WeakMap<
  ChatMessage,
  { sources: readonly ChatMessage[]; grouped: ChatMessage }
>()

function sameMessages(left: readonly ChatMessage[], right: readonly ChatMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index])
}

export function groupChatTurnWork(messages: ChatMessage[]): ChatMessage[] {
  const displayed: ChatMessage[] = []
  let pending: ChatMessage[] = []
  const flushPending = (final?: ChatMessage): void => {
    const turn = final ? [...pending, final] : pending
    pending = []
    if (turn.length === 0) return
    const response =
      final ??
      [...turn]
        .reverse()
        .find(
          (entry) => entry.role === 'assistant' && Boolean(entry.content.trim() || entry.image)
        ) ??
      [...turn].reverse().find((entry) => entry.role === 'assistant')
    if (!response || !turn.some((entry) => entry.role === 'assistant')) {
      displayed.push(...turn)
      return
    }
    const tools: ProjectedSyncedTool[] = []
    const timeline: NonNullable<ChatMessage['timeline']> = []
    const toolsOffered = new Set<string>()
    const labeledReasoning = turn.find(
      (entry) => entry.role === 'assistant' && entry.reasoningLabel && entry.reasoning?.trim()
    )
    for (const entry of turn) {
      entry.toolsOffered?.forEach((name) => toolsOffered.add(name))
      if (entry.role === 'tool') {
        const existingToolIndex = entry.toolCallId
          ? tools.findIndex((tool) => tool.id === entry.toolCallId)
          : -1
        if (existingToolIndex >= 0) {
          tools[existingToolIndex] = {
            ...tools[existingToolIndex]!,
            result: entry.content,
            status: entry.turnStatus === 'failed' ? 'failed' : 'completed',
            ...(entry.generationTimeMs === undefined
              ? {}
              : { durationMs: entry.generationTimeMs })
          }
          continue
        }
        timeline.push({ kind: 'tool', toolIndex: tools.length })
        tools.push({
          name: entry.toolName || 'Tool result',
          result: entry.content,
          status: entry.turnStatus === 'failed' ? 'failed' : 'completed',
          ...(entry.generationTimeMs === undefined ? {} : { durationMs: entry.generationTimeMs })
        })
        continue
      }
      if (entry.role !== 'assistant') continue
      const toolOffset = tools.length
      tools.push(...(entry.toolCalls ?? []))
      if (entry.timeline?.length) {
        timeline.push(
          ...entry.timeline.map((item) =>
            item.kind === 'tool' ? { ...item, toolIndex: item.toolIndex + toolOffset } : item
          )
        )
      } else {
        if (entry.reasoning?.trim()) timeline.push({ kind: 'thinking', text: entry.reasoning })
        entry.toolCalls?.forEach((_, index) =>
          timeline.push({ kind: 'tool', toolIndex: toolOffset + index })
        )
      }
    }
    const cached = groupedTurnCache.get(response)
    if (cached && sameMessages(cached.sources, turn)) {
      displayed.push(cached.grouped)
      return
    }
    const grouped: ChatMessage = {
      ...response,
      toolCalls: tools.length ? tools : undefined,
      timeline: timeline.length ? timeline : undefined,
      toolsOffered: toolsOffered.size ? [...toolsOffered] : response.toolsOffered,
      reasoning: response.reasoning ?? labeledReasoning?.reasoning,
      reasoningLabel: response.reasoningLabel ?? labeledReasoning?.reasoningLabel
    }
    groupedTurnCache.set(response, { sources: [...turn], grouped })
    displayed.push(grouped)
  }
  for (const message of messages) {
    if (message.role === 'user') {
      flushPending()
      displayed.push(message)
      continue
    }
    if (pending.length && message.role === 'assistant') {
      if (!pending.some((entry) => entry.role === 'assistant' && entry.image)) {
        pending.push(message)
        continue
      }
      flushPending()
    }
    const intermediateThought =
      message.role === 'assistant' &&
      !message.content.trim() &&
      Boolean(message.reasoning?.trim()) &&
      !message.timeline?.length &&
      !message.toolCalls?.length
    if (intermediateThought || message.role === 'tool' || message.toolCalls?.length) {
      pending.push(message)
      continue
    }
    flushPending()
    displayed.push(message)
  }
  flushPending()
  return displayed
}

export function mergeRemotePreviewTools(
  durable: readonly ProjectedSyncedTool[] | undefined,
  preview: ChatStreamPreviewRow | null
): ProjectedSyncedTool[] | undefined {
  const saved = [...(durable ?? [])]
  const live = (preview?.tools ?? []).map((tool) => ({
    name: tool.name,
    result: tool.result ?? '',
    status: tool.status
  }))
  for (const savedTool of saved) {
    const match = live.findIndex(
      (tool) =>
        tool.name === savedTool.name &&
        tool.status !== 'running' &&
        tool.result === savedTool.result
    )
    if (match >= 0) live.splice(match, 1)
  }
  const combined = [...saved, ...live]
  return combined.length ? combined : undefined
}

export function mapRagMessages(raw: RawRagMessage[]): ChatMessage[] {
  return raw.flatMap<ChatMessage>(mapRagMessage)
}

export function mergeDurableAndStreaming(
  durable: ChatMessage[],
  current: ChatMessage[]
): ChatMessage[] {
  const durableIds = new Set(durable.map((message) => message.id))
  const active = current.filter(
    (message) => message.streaming === true && !durableIds.has(message.id)
  )
  return [...durable, ...active]
}

export async function stopLiveWebUseForConversation(
  conversationId: string | null
): Promise<void> {
  if (!conversationId || !window.api.tasks?.list || !window.api.vision?.control) return
  try {
    const tasks = await window.api.tasks.list()
    const live = new Set(['running', 'paused', 'waiting', 'reconnecting'])
    const matching = tasks.filter(
      (task) => task.journeyId === conversationId && live.has(task.status)
    )
    await Promise.all(matching.map((task) => window.api.vision!.control('stop', task.taskId)))
  } catch (error) {
    console.error('Failed to stop Web Use for this Chat:', error)
  }
}

export async function stopLiveTask(
  task: Pick<TaskSession, 'taskId' | 'kind'>
): Promise<boolean> {
  return (await window.api.vision?.control('stop', task.taskId)) ?? false
}
