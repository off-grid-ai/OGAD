/**
 * Pure projections and shapes for one rendered chat message.
 *
 * No JSX and no component state: what a turn LOOKS like (its class, its rendered content, its
 * speech state, how much context it cites) and the contracts a row is handed - the projection
 * `MessageRowState` in, the intent `MessageRowActions` out.
 */
import { toSpeakableText } from '@renderer/lib/speakable'
import { attachmentKindFor, isPromptEnhancementStatus, isSupportingChatContext, preprocessChatMarkdown, type SyncedMessageRole } from '@offgrid/application'
import { type IncomingSharedFile } from '@renderer/lib/sync-hooks'
import { chatMarkdownComponents } from './chat-markdown-components'
import { type Artifact } from '@renderer/lib/artifact-parser'
import { type DemoPreset } from './explore/presetCatalog'
import { type AskBlock, type ChatMessage, type RagContext } from '@renderer/lib/chat-transcript-types'
import { navigateSearchHit } from '@renderer/lib/search-navigation'
import { runningToolLabel } from '@renderer/lib/tool-display'
import { type TaskSession } from '@renderer/lib/task-session-store'
import { captureUrlForPath } from '../../../shared/ogcapture-url'

export function noticeText(content: string): string {
  return content.replace(/^_([\s\S]*)_$/, '$1').trim()
}

/**
 * Mobile persists this short-lived row while it rewrites an image prompt, then updates the SAME
 * message to a labelled reasoning block. It is lifecycle state, not an assistant answer: drawing
 * reply actions on it made Speak / Copy / Regenerate target text that was about to be replaced.
 */
export function isPromptEnhancementMessage(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    !message.image &&
    !message.reasoning?.trim() &&
    !message.toolCalls?.length &&
    isPromptEnhancementStatus(message.content)
  )
}

// Detect a model-emitted interactive question: ```ask { question, options, multiSelect }```
export function parseAsk(content: string): AskBlock | null {
  const m = content.match(/```ask\s*\n([\s\S]*?)```/i)
  if (!m) return null
  try {
    const j = JSON.parse(m[1]!.trim())
    if (j && typeof j.question === 'string' && Array.isArray(j.options) && j.options.length) {
      return { question: j.question, options: j.options.map(String), multiSelect: !!j.multiSelect }
    }
  } catch {
    /* not a valid ask block */
  }
  return null
}

const ASK_FENCE = /```ask\s*\n[\s\S]*?```/i
// Artifact code (html/svg/mermaid/react/image) is rendered on the side canvas, not
// dumped inline — strip the fenced block from the chat bubble and show a card instead.
const ARTIFACT_FENCE = /```(?:html|svg|mermaid|jsx|tsx|react|image)\s*\n[\s\S]*?```/gi
const CITATION = /\[S(\d+)\]/g

/** Turn a raw message into clean, speakable/readable text: drop app-only fenced blocks
 *  and citation markers, then strip markdown via the shared parser. The single entry
 *  point for EVERY message->speech/transcript path (Speak button + voice-mode bubble)
 *  so none can leak raw markdown to the engine or the transcript. */
export function messageToSpeakable(raw: string): string {
  return toSpeakableText(
    (raw || '').replace(ASK_FENCE, '').replace(ARTIFACT_FENCE, '').replace(CITATION, '').trim()
  )
}

// Human label for a live retrieval/activity step shown while the model works.
export function activityLabel(a?: {
  kind: string
  counts?: Record<string, number>
  name?: string
}): string {
  if (!a) return ''
  if (a.kind === 'planning') return 'Planning next action…'
  if (a.kind === 'running_tool') return runningToolLabel(a.name)
  if (a.kind === 'reading') return `Reading the page${(a.counts?.urls ?? 0) > 1 ? 's' : ''}…`
  if (a.kind === 'searching') return 'Searching your memory…'
  if (a.kind === 'memory') {
    const c = a.counts || {}
    const total =
      (c.memories || 0) + (c.summaries || 0) + (c.entities || 0) + (c.facts || 0) + (c.unified || 0)
    return `Searched your memory — ${total} result${total === 1 ? '' : 's'}`
  }
  if (a.kind === 'project') {
    const c = a.counts || {}
    return `Searched project — ${c.sources || 0} sources · ${c.projectChats || 0} chats`
  }
  return 'Working…'
}

export type StoredMessageAttachment = NonNullable<ChatMessage['attachments']>[number]
export type OpenImage = { url: string; path?: string }

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
  const margin = isSupportingMessage(message) ? 'mb-2' : 'mb-5'
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
  // A turn carrying a picture gets a COLUMN, not the full 85%.
  //
  // A generated image already did this; an attached one never did, so it inherited a bubble as wide
  // as its prompt - some 1700px on a maximised window - and a picture told to fill that width was
  // gigantic. The same cap makes the two kinds of picture behave the same way.
  const width =
    editing || message.image || message.attachments?.length ? 'w-full max-w-2xl' : 'max-w-[85%]'
  const color = message.context?.taskGuidance
    ? 'border border-green-500/50 bg-green-500/5 text-foreground'
    : message.role === 'user'
      ? 'bg-neutral-800 text-neutral-100'
      : 'border border-neutral-800 bg-neutral-900/40 text-neutral-200'
  return `rounded-md px-3.5 py-2.5 text-sm leading-relaxed ${width} ${color}`
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

export function generationErrorContent(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const message = raw
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800)
  return message || 'Sorry, something went wrong while generating a response.'
}

export const digitsOnly = (value: string): string => value.replace(/[^0-9]/g, '')

export type SpeechControlState = 'idle' | 'loading' | 'playing'

export function speechControlState(
  messageId: string,
  speakingId: string | null,
  loadingId: string | null
): SpeechControlState {
  if (loadingId === messageId) return 'loading'
  if (speakingId === messageId) return 'playing'
  return 'idle'
}

export function recordedClipUrl(message: ChatMessage): string | undefined {
  if (message.audioUrl) return message.audioUrl
  const clip = message.attachments?.find(
    (a) => !!a.path && attachmentKindFor({ fileName: a.name }) === 'audio'
  )
  return clip?.path ? captureUrlForPath(clip.path) : undefined
}

export type UnifiedContextItem = NonNullable<RagContext['unified']>[number]

export type ContextNavigation = Readonly<{
  onNavigateToMemory?: (memoryId: number) => void
  onNavigateToChat?: (sessionId: string) => void
  onNavigateToMeeting?: (meetingId: number) => void
  onNavigateToEntity?: (entityId: number) => void
  onOpenProject?: (projectId: string) => void
  onSeekReplay?: (timestamp: number) => void
  installedSkillNames?: readonly string[]
  onOpenInstalledSkill?: (name: string) => void
  onOpenSkillPreset?: (preset: DemoPreset) => void
}>

export type MessageRowState = Readonly<{
  autoPlayId: string | null
  copiedKey: string | null
  editingId: string | null
  loading: boolean
  speakingId: string | null
  speakLoadingId: string | null
  speakError: { id: string; message: string } | null
  ttsEnabled: boolean
  ttsSpeed: number
  latestVoiceAssistantId: string | null
  askSelections: Readonly<Record<string, readonly string[]>>
  incomingFiles: readonly IncomingSharedFile[]
  showGenerationDetails: boolean
  regenerationDisabled: boolean
}>

type AskOptionSelection = Readonly<{
  message: ChatMessage
  ask: AskBlock
  option: string
  selected: boolean
}>

export type MessageRowActions = Readonly<{
  copy: (text: string, key?: string) => void
  regenerate: (messageId: string) => void
  openImage: (image: OpenImage) => void
  openAttachment: (attachment: StoredMessageAttachment) => void
  startEdit: (message: ChatMessage) => void
  cancelEdit: () => void
  saveEdit: (messageId: string, text: string) => void
  retryImageMemory: (retry: NonNullable<ChatMessage['imageMemoryRetry']>) => void
  openArtifact: (artifact: Artifact) => void
  selectAskOption: (selection: AskOptionSelection) => void
  submitAsk: (selected: readonly string[]) => void
  speak: (messageId: string, content: string) => void
  voicePlaybackChange: (messageId: string, active: boolean) => void
  selectVariant: (messageId: string, direction: -1 | 1) => void
}>

export type MessageRowProps = Readonly<{
  message: ChatMessage
  nextMessageRole?: SyncedMessageRole
  liveTask?: TaskSession
  voiceMode: boolean
  state: MessageRowState
  actions: MessageRowActions
  navigation: ContextNavigation
}>

export const markdownComponents = chatMarkdownComponents

export function openUnifiedContext(item: UnifiedContextItem, navigation: ContextNavigation): void {
  navigateSearchHit(
    {
      ...item,
      key: item.key ?? `${item.kind}:${String(item.refId ?? item.ts)}`,
      refId: item.refId ?? 0,
      url: item.url ?? null,
      score: item.score ?? 0,
      imagePath: item.imagePath ?? null
    },
    {
      selectEntity: (entityId) => navigation.onNavigateToEntity?.(entityId),
      selectMemory: (memoryId) => navigation.onNavigateToMemory?.(memoryId),
      openMeeting: (meetingId) => {
        if (meetingId != null) navigation.onNavigateToMeeting?.(meetingId)
      },
      openChat: (target) => {
        if (target?.conversationId) navigation.onNavigateToChat?.(target.conversationId)
        if (target?.projectId) navigation.onOpenProject?.(target.projectId)
      },
      openReplay: (timestamp) => navigation.onSeekReplay?.(timestamp)
    }
  )
}

