import {
  isPromptEnhancementReasoningLabel,
  isPromptEnhancementStatus,
  isSupportingChatContext,
  preprocessChatMarkdown
} from '@offgrid/sync'
import { toSpeakableText } from '@renderer/lib/speakable'
import { runningToolLabel } from '@renderer/lib/tool-display'
import type { ImageGenerationJobContract } from '../../../../shared/image-generation-contract'
import type { AskBlock, ChatMessage, ImageProgress, RagContext } from './types'
import type { ChatVoicePhase } from '../use-chat-voice-turns'
import type { TaskSession } from '@renderer/lib/task-session-store'

export const NEW_CHAT = '__new__'
export const EMPTY_MSGS: ChatMessage[] = []
export const OPEN_CHAT_TABS_KEY = 'offgrid:chat:open-tabs'
export const ACTIVE_CHAT_TAB_KEY = 'offgrid:chat:active-tab'

export const ASK_FENCE = /```ask\s*\n[\s\S]*?```/i
const ARTIFACT_FENCE = /```(?:html|svg|mermaid|jsx|tsx|react|image)\s*\n[\s\S]*?```/gi
const CITATION = /\[S(\d+)\]/g
export const IMAGE_MESSAGE_COLUMN_WIDTH = 'w-full max-w-2xl'

export function imageProgressLabel(
  stage: ImageGenerationJobContract['stage'],
  progress: ImageProgress | null
): string {
  if (stage === 'enhancing') return 'Preparing image…'
  if (stage === 'preparing') return 'Preparing image…'
  if (!progress) return stage === 'decoding' ? 'Decoding image…' : 'Generating image…'
  if (progress.phase !== 'decoding' && progress.step >= progress.total) {
    return 'Finalizing image…'
  }
  const phase = progress.phase === 'decoding' ? 'Decoding' : 'Step'
  return progress.phase === 'decoding'
    ? `${phase} ${progress.step} of ${progress.total}`
    : `Generating image · ${phase} ${progress.step} of ${progress.total}`
}

export function noticeText(content: string): string {
  return content.replace(/^_([\s\S]*)_$/, '$1').trim()
}

export function isPromptEnhancementMessage(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    !message.image &&
    !message.reasoning?.trim() &&
    !message.toolCalls?.length &&
    isPromptEnhancementStatus(message.content)
  )
}

export function parseAsk(content: string): AskBlock | null {
  const match = content.match(/```ask\s*\n([\s\S]*?)```/i)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1]!.trim())
    if (
      parsed &&
      typeof parsed.question === 'string' &&
      Array.isArray(parsed.options) &&
      parsed.options.length
    ) {
      return {
        question: parsed.question,
        options: parsed.options.map(String),
        multiSelect: Boolean(parsed.multiSelect)
      }
    }
  } catch {
    /* not a valid ask block */
  }
  return null
}

export function messageToSpeakable(raw: string): string {
  return toSpeakableText(
    (raw || '').replace(ASK_FENCE, '').replace(ARTIFACT_FENCE, '').replace(CITATION, '').trim()
  )
}

export function activityLabel(activity?: {
  kind: string
  counts?: Record<string, number>
  name?: string
}): string {
  if (!activity) return ''
  if (activity.kind === 'planning') return 'Planning next action…'
  if (activity.kind === 'preparing_tool_calls')
    return activity.name === 'generate_image' ? 'Preparing image requests…' : 'Preparing actions…'
  if (activity.kind === 'running_tool') return runningToolLabel(activity.name)
  if (activity.kind === 'reading')
    return `Reading the page${(activity.counts?.urls ?? 0) > 1 ? 's' : ''}…`
  if (activity.kind === 'searching') return 'Searching your memory…'
  if (activity.kind === 'memory') {
    const counts = activity.counts || {}
    const total =
      (counts.memories || 0) +
      (counts.summaries || 0) +
      (counts.entities || 0) +
      (counts.facts || 0) +
      (counts.unified || 0)
    return `Searched your memory — ${total} result${total === 1 ? '' : 's'}`
  }
  if (activity.kind === 'project') {
    const counts = activity.counts || {}
    return `Searched project — ${counts.sources || 0} sources · ${counts.projectChats || 0} chats`
  }
  return 'Working…'
}

export function isSupportingMessage(message: ChatMessage): boolean {
  return isSupportingChatContext({
    answer: message.content,
    reasoning: message.reasoning,
    reasoningLabel: message.reasoningLabel
  })
}

export function selectedMessageContent(message: ChatMessage): string {
  if (!message.variants || message.variantIndex == null) return message.content
  return message.variants[message.variantIndex] ?? message.content
}

export function renderedMessageContent(message: ChatMessage): string {
  const selected = selectedMessageContent(message)
  if (message.role !== 'assistant') return preprocessChatMarkdown(selected)
  return preprocessChatMarkdown(
    selected
      .replace(ASK_FENCE, '')
      .replace(/\[S(\d+)\]/g, '[S$1](cite:$1)')
      .trim()
  )
}

export function standardMessageRowClass(message: ChatMessage): string {
  const margin = isSupportingMessage(message) ? 'my-1' : 'my-2.5'
  const alignment = message.role === 'user' ? 'items-end' : 'items-start'
  return `${margin} flex flex-col ${alignment}`
}

export function standardMessageBubbleClass(message: ChatMessage, editing: boolean): string {
  const emptyAssistant =
    message.role === 'assistant' &&
    !message.content.trim() &&
    !message.image &&
    !message.imageMemoryRetry
  if (emptyAssistant) return 'hidden'
  const width =
    editing || message.image || message.attachments?.length
      ? IMAGE_MESSAGE_COLUMN_WIDTH
      : 'max-w-full'
  if (message.context?.taskGuidance) {
    return `rounded-md border border-green-500/50 bg-green-500/5 px-3.5 py-2.5 text-sm leading-relaxed text-foreground ${width}`
  }
  const color = message.role === 'user' ? 'text-neutral-100' : 'text-neutral-200'
  return `py-1 text-sm leading-relaxed ${width} ${color}`
}

export function assistantWorkIsSettled(message: ChatMessage): boolean {
  return Boolean(
    !message.streaming && (message.content.trim() || message.image || message.attachments?.length)
  )
}

export function contextResultCount(context: RagContext): number {
  return (
    (context.sources?.length ?? 0) +
    (context.memories?.length ?? 0) +
    (context.summaries?.length ?? 0) +
    (context.entities?.length ?? 0) +
    (context.entityFacts?.length ?? 0) +
    (context.unified?.length ?? 0)
  )
}

/** The main process rethrows the real reason; Electron wraps it as "Error invoking remote method". */
export function generationErrorContent(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const message = raw
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800)
  return message || 'Sorry, something went wrong while generating a response.'
}

export function nextVoicePlaybackOwner(
  current: string | null,
  messageId: string,
  active: boolean
): string | null {
  if (active) return messageId
  return current === messageId ? null : current
}

export function textRecordingButtonLabel(phase: ChatVoicePhase): string {
  if (phase === 'transcribing') return 'Cancel transcription'
  if (phase !== 'idle') return 'Stop recording'
  return 'Record voice'
}

export function textRecordingTooltip(phase: ChatVoicePhase, transcriptionLabel: string): string {
  if (phase === 'transcribing') {
    return `Transcribing with ${transcriptionLabel} - click to cancel`
  }
  if (phase !== 'idle') return 'Stop recording'
  return 'Record voice'
}

export function stopFailureMessage(kind: TaskSession['kind']): string {
  return `${kind === 'web_use' ? 'Web Use' : 'Computer Use'} could not be stopped on this device.`
}

export function readActiveConversationId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_CHAT_TAB_KEY)
  } catch {
    return null
  }
}

export function readOpenChatTabs(): string[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(OPEN_CHAT_TABS_KEY) ?? '[]') as unknown
    return Array.isArray(saved)
      ? saved.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

export function findDurableWorkMessageId(messages: readonly ChatMessage[]): string | undefined {
  let currentTurnStart = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      currentTurnStart = index + 1
      break
    }
  }
  return [...messages.slice(currentTurnStart)]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' &&
        !isPromptEnhancementMessage(message) &&
        !isPromptEnhancementReasoningLabel(message.reasoningLabel) &&
        Boolean(
          message.toolCalls?.length || message.timeline?.length || message.reasoning?.trim()
        )
    )?.id
}

export function preferredImageModel(models: readonly string[]): string {
  const usable = models.filter((model) => !/coreml/i.test(model))
  return (
    usable.find((model) => /dreamshaper/i.test(model)) ||
    usable.find((model) => /lightning|turbo/i.test(model)) ||
    usable.find((model) => /z[-_]?image/i.test(model)) ||
    usable.find((model) => /sdxl|xl/i.test(model)) ||
    usable[0] ||
    models[0] ||
    ''
  )
}
