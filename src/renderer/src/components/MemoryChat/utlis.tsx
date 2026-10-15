import { versionContent } from '../../../../shared/chat-versions'
import {
  isPromptEnhancementReasoningLabel,
  isPromptEnhancementStatus,
  isSupportingChatContext,
  preprocessChatMarkdown
} from '@offgrid/sync'
import { splitCitations } from '@offgrid/rag/documents'
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

const ASK_FENCE = /```ask\s*\n[\s\S]*?```/i
const ARTIFACT_FENCE = /```(?:html|svg|mermaid|jsx|tsx|react|image)\s*\n[\s\S]*?```/gi
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

/** Each `[S#]` tag (grouped tags too) replaced, read the way the shared engine reads them. */
function mapCitations(text: string, citation: (index: number) => string): string {
  return splitCitations(text)
    .map((segment) => (segment.kind === 'citation' ? citation(segment.index) : segment.text))
    .join('')
}

export function messageToSpeakable(raw: string): string {
  return toSpeakableText(
    mapCitations((raw || '').replace(ASK_FENCE, '').replace(ARTIFACT_FENCE, ''), () => '').trim()
  )
}

export function activityLabel(activity?: {
  kind: string
  counts?: Record<string, number>
  name?: string
  label?: string
}): string {
  if (!activity) return ''
  if (activity.kind === 'planning') return 'Planning next action…'
  if (activity.kind === 'preparing_tool_calls')
    return activity.name === 'generate_image' ? 'Preparing image requests…' : 'Preparing actions…'
  if (activity.kind === 'running_tool') return runningToolLabel(activity.name)
  if (activity.kind === 'reading')
    return `Reading the page${(activity.counts?.urls ?? 0) > 1 ? 's' : ''}…`
  if (activity.kind === 'documents') return activity.label || 'Reading documents…'
  if (activity.kind === 'searching') return 'Searching your memory…'
  if (activity.kind === 'memory') {
    const counts = activity.counts || {}
    const total = (counts.summaries || 0) + (counts.entities || 0) + (counts.unified || 0)
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
  if (message.streaming || !message.variants || message.variantIndex == null) return message.content
  return versionContent(message.variants[message.variantIndex], message.content)
}

/** The reply's prose once its artifact code moved into the artifact card. */
export function withoutArtifactFences(content: string): string {
  return content
    .replace(ARTIFACT_FENCE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function renderedMessageContent(message: ChatMessage): string {
  const selected = selectedMessageContent(message)
  if (message.role !== 'assistant') return preprocessChatMarkdown(selected)
  return preprocessChatMarkdown(
    mapCitations(selected.replace(ASK_FENCE, ''), (index) => `[S${index}](cite:${index})`).trim()
  )
}

export function standardMessageRowClass(message: ChatMessage): string {
  const margin = isSupportingMessage(message) ? 'my-1' : 'my-4'
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
  if (message.role === 'user' && width === 'max-w-full') {
    // The preview's user turn: a soft rounded surface, so the two voices read apart at a glance.
    return `rounded-2xl bg-foreground/[0.06] px-4 py-2.5 text-sm leading-relaxed ${width} text-neutral-100`
  }
  const color = message.role === 'user' ? 'text-neutral-100' : 'text-neutral-200'
  return `py-1 text-sm leading-relaxed ${width} ${color}`
}

/**
 * The same bubble as standardMessageBubbleClass, written for the library's MessageContent inside a
 * Message. MessageContent styles a user turn through `group-[.is-user]:` (it outranks a plain
 * utility), so the user-turn surface is restated in that variant; the block/overflow overrides
 * keep the bubble's inner flow as it was.
 */
export function messageContentClass(message: ChatMessage, editing: boolean): string {
  const bubble = standardMessageBubbleClass(message, editing)
  if (bubble === 'hidden') return 'hidden'
  const flow = 'block min-w-0 gap-0 overflow-visible group-[.is-assistant]:text-neutral-200'
  if (message.role !== 'user') return `${flow} ${bubble}`
  // Attachments ride inside the same bubble as the words; only an editor or a picture is wide.
  const wide = Boolean(editing || message.image)
  if (message.context?.taskGuidance) {
    return `${flow} ${bubble} group-[.is-user]:rounded-md group-[.is-user]:bg-green-500/5 group-[.is-user]:px-3.5 group-[.is-user]:py-2.5 group-[.is-user]:text-foreground`
  }
  if (!wide) {
    return `${flow} ${bubble} group-[.is-user]:rounded-2xl group-[.is-user]:bg-foreground/[0.06] group-[.is-user]:px-4 group-[.is-user]:py-2.5 group-[.is-user]:text-neutral-100`
  }
  return `${flow} ${bubble} group-[.is-user]:rounded-none group-[.is-user]:bg-transparent group-[.is-user]:px-0 group-[.is-user]:py-1 group-[.is-user]:text-neutral-100`
}

export function assistantWorkIsSettled(message: ChatMessage): boolean {
  return Boolean(
    !message.streaming && (message.content.trim() || message.image || message.attachments?.length)
  )
}

export function contextResultCount(context: RagContext): number {
  return (
    (context.sources?.length ?? 0) +
    (context.summaries?.length ?? 0) +
    (context.entities?.length ?? 0) +
    (context.unified?.length ?? 0)
  )
}

export { generationErrorContent } from '../../../../shared/chat-generation-error'

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

export function readActiveConversationId(key = ACTIVE_CHAT_TAB_KEY): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function readOpenChatTabs(key = OPEN_CHAT_TABS_KEY): string[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) ?? '[]') as unknown
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
        Boolean(message.toolCalls?.length || message.timeline?.length || message.reasoning?.trim())
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
