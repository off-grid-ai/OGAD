import { useCallback, useEffect, useRef, useState } from 'react'
import { shouldQueue, enqueue, dequeue, queuedCount, clearQueue } from '@renderer/lib/chat-queue'
import { buildSendHistory } from '@renderer/lib/chat-history'
import { waitingLabel } from '@renderer/lib/chat-labels'
import { parseSqliteUtc, shiftLocalDay, startOfLocalDay, timeAgo } from '@renderer/lib/time'
import { writeClipboardWithFallback } from '@renderer/lib/clipboard-write'
import { motion, AnimatePresence } from 'motion/react'
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle
} from 'react-resizable-panels'
import { toSpeakableText } from '@renderer/lib/speakable'
import { isAgenticTurn } from '@renderer/lib/agentic-active'
import { applyStreamEvent, hasLiveStreamActivity } from '@renderer/lib/stream-reducer'
import { useActiveModelSummary } from '@renderer/hooks/useActiveModelSummary'
import { shouldFollowBottom } from '@renderer/lib/scroll-follow'
import {
  chatListPreviewLine,
  attachmentKindFor,
  describeAttachment,
  isPromptEnhancementReasoningLabel,
  isPromptEnhancementStatus,
  isSupportingChatContext,
  PROMPT_ENHANCEMENT_REASONING_LABEL,
  preprocessChatMarkdown,
  projectSyncedMessageTurn,
  type ProjectedSyncedTool,
  type RecordProvenance,
  type SyncedMessageRole,
  type SyncedTurnStatus
} from '@offgrid/sync'
import type { VoiceTurnMode } from '@offgrid/speech'
import ReactMarkdown, { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { getSlot, SLOTS } from '@/bootstrap/slotRegistry'
import { callHook } from '@/bootstrap/hookRegistry'
import { useRendererEntitlement } from '@/bootstrap/useRendererEntitlement'
import {
  SYNC_SUBSCRIBE_INCOMING_FILES_HOOK,
  type IncomingSharedFile
} from '@renderer/lib/sync-hooks'
import { ChatLoadingCard } from './ChatLoadingCard'
import { chatMarkdownComponents } from './chat-markdown-components'
import { ChatThinkingBlock } from './ChatThinkingBlock'
import { ChatToolRows } from './ChatToolRows'
import { ArtifactCanvas, parseArtifact, type Artifact } from './ArtifactCanvas'
import { VoiceBubble } from './VoiceBubble'
import { stopAllVoicePlayback } from '@renderer/lib/voice-playback-bus'
import { ChatVoiceComposer, VoiceModeControl } from './ChatVoiceComposer'
import { ExploreSection } from './explore/ExploreSection'
import { REQUEST_FORM_URL, presetForSkillName, type DemoPreset } from './explore/presetCatalog'
import { useChatVoiceTurns, type ChatVoicePhase } from './use-chat-voice-turns'
import { SkillsPanel } from './SkillsPanel'
import { ModelPicker } from './ModelPicker'
import { SettingsPanel } from './SettingsPanel'
import { LoadingDots } from './ui/loading-dots'
import { SidePanel } from './SidePanel'
import { ConversationTitleActions } from './ConversationTitleActions'
import { resolveImageParams, setOverride, type ImageParamStore } from '@renderer/lib/image-params'
import { IMAGE_SETTINGS_CHANGED_EVENT } from '@renderer/lib/image-settings-events'
import {
  DEFAULT_VOICE_PREFERENCES,
  VOICE_PREFERENCES_CHANGED_EVENT,
  readVoicePreferences,
  type VoicePreferences
} from '@renderer/lib/voice-preferences'
import { shouldAutoRouteImage, cleanImagePrompt } from '@renderer/lib/image-intent'
import {
  buildAssistantContext,
  readReasoning,
  readResponseCutoff
} from '@renderer/lib/message-persistence'
import {
  readGeneratedImageReference,
  withGeneratedImageReference
} from '../../../shared/generated-image-reference'
import type { RagConversationContract, ResponseCutoffContract } from '../../../shared/ipc-contracts'
import type { SearchHit } from '../types'
import { navigateSearchHit } from '@renderer/lib/search-navigation'
import { runningToolLabel } from '@renderer/lib/tool-display'
import {
  parseImageMemoryGuardError,
  type ImageGenerationJobContract,
  type ImageGenerationRequestContract
} from '../../../shared/image-generation-contract'
import { Button } from '@renderer/components/ui/button'
import { ActionGateDock } from '@renderer/components/actions/ActionGateDock'
import { VisionSupervisorOverlay } from '@renderer/components/vision/VisionSupervisorOverlay'
import { TaskPanelTrigger } from '@renderer/components/tasks/TaskPanelTrigger'
import { TaskLiveActivity } from '@renderer/components/browser/tasks/TaskLiveActivity'
import {
  guidanceTaskForJourney,
  useTaskSessions,
  type TaskSession
} from '@renderer/lib/task-session-store'
import { submitTaskGuidance } from '@renderer/lib/task-guidance-client'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '@renderer/components/ui/dropdown-menu'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'
import { captureUrlForPath } from '../../../shared/ogcapture-url'
import {
  Plus,
  Paperclip,
  Image as ImageIcon,
  Sparkle as Sparkles,
  FolderPlus,
  Wrench,
  Plug,
  SlidersHorizontal,
  Brain,
  Cpu,
  Prohibit,
  Check,
  X,
  FolderOpen,
  CaretDown,
  Lightning,
  WarningCircle
} from '@phosphor-icons/react'

type RagMemory = { id: number; content?: string; text?: string }
type RagSummary = { session_id: string; summary?: string; title?: string; app_name?: string }
type RagEntity = { id: number; name?: string }
type RagEntityFact = { fact?: string } | string

type RagContext = {
  masterMemory?: string | null
  memories?: RagMemory[]
  messages?: unknown[]
  summaries?: RagSummary[]
  entities?: RagEntity[]
  entityFacts?: RagEntityFact[]
  unified?: Array<
    Omit<SearchHit, 'key' | 'refId' | 'url' | 'score'> & {
      key?: string
      refId?: number
      url?: string | null
      score?: number
    }
  >
  image?: string
  imageMetadata?: ImageGenerationMetadata
  sources?: { name: string; position: number; score: number }[]
  attachments?: { name: string; kind: string; text?: string; path?: string }[]
  taskGuidance?: {
    taskId: string
    state: 'accepted' | 'applied'
    attachmentNames?: string[]
  }
}

type ImageGenerationMetadata = {
  width: number
  height: number
  steps: number
  cfgScale: number
  seed: number
  model?: string
}

type ChatMessage = {
  id: string
  role: SyncedMessageRole
  content: string
  context?: RagContext
  image?: string
  imagePath?: string
  imageMetadata?: ImageGenerationMetadata
  toolCalls?: ProjectedSyncedTool[]
  toolName?: string
  toolCallId?: string
  turnStatus?: SyncedTurnStatus
  /** The app said this ("Model loaded: …"), not the model. Drawn as a quiet marker, never a bubble. */
  notice?: boolean
  /** What this turn's reasoning block is called, when it named itself ("Enhanced prompt"). */
  reasoningLabel?: string
  generationTimeMs?: number
  provenance?: RecordProvenance
  reasoning?: string
  cutoff?: ResponseCutoffContract
  imageMemoryRetry?: {
    request: ImageGenerationRequestContract
    prompt: string
    conversationId: string
    projectId: string | null
  }
  streaming?: boolean
  activity?: { kind: string; counts?: Record<string, number>; name?: string }
  attachments?: { name: string; kind: string; text?: string; path?: string }[]
  variants?: string[] // regenerated answers (navigate with ‹ ›)
  variantIndex?: number
  audioUrl?: string // voice-mode: recorded clip for a user voice note
  audioDuration?: number // seconds, when known from the recording
}

function completedImageMessage(
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

type ChatMode = 'ask' | 'image'

type ImageProgress = {
  step: number
  total: number
  secPerStep: number
  preview?: string
  phase?: 'sampling' | 'decoding'
}

function imageProgressLabel(
  stage: ImageGenerationJobContract['stage'],
  progress: ImageProgress | null
): string {
  if (stage === 'enhancing') return 'Preparing image…'
  if (stage === 'preparing') return 'Preparing image…'
  if (!progress) return stage === 'decoding' ? 'Decoding image…' : 'Generating image…'
  const phase = progress.phase === 'decoding' ? 'Decoding' : 'Step'
  return progress.phase === 'decoding'
    ? `${phase} ${progress.step} of ${progress.total}`
    : `Generating image · ${phase} ${progress.step} of ${progress.total}`
}

/**
 * Tell main the generated assistant message is durable, and WHICH message it is.
 *
 * The message id is the point. The image was offered to the mesh before the message existed, so the
 * file record could not say what it hung under, and every peer filed the picture in its gallery and
 * left the chat empty. Naming the message here is what completes the record.
 */
async function announceImageMessagePersisted(
  conversationId: string,
  messageId: string
): Promise<void> {
  try {
    await window.api.imageGenConversationPersisted?.(conversationId, messageId)
  } catch {
    /* The message is already durable; a later mount still loads it from SQLite. */
  }
}

/**
 * A notice is stored with markdown emphasis wrapped around it (`_Model loaded: Qwen3.5 0.8B_`),
 * and this line is drawn as plain text, so the markers would otherwise be read out literally.
 */
function noticeText(content: string): string {
  return content.replace(/^_([\s\S]*)_$/, '$1').trim()
}

/**
 * Mobile persists this short-lived row while it rewrites an image prompt, then updates the SAME
 * message to a labelled reasoning block. It is lifecycle state, not an assistant answer: drawing
 * reply actions on it made Speak / Copy / Regenerate target text that was about to be replaced.
 */
function isPromptEnhancementMessage(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    !message.image &&
    !message.reasoning?.trim() &&
    !message.toolCalls?.length &&
    isPromptEnhancementStatus(message.content)
  )
}

type AskBlock = { question: string; options: string[]; multiSelect: boolean }

// Detect a model-emitted interactive question: ```ask { question, options, multiSelect }```
function parseAsk(content: string): AskBlock | null {
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
function messageToSpeakable(raw: string): string {
  return toSpeakableText(
    (raw || '').replace(ASK_FENCE, '').replace(ARTIFACT_FENCE, '').replace(CITATION, '').trim()
  )
}

// Human label for a live retrieval/activity step shown while the model works.
function activityLabel(a?: {
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

type Attachment = {
  id: string
  name: string
  kind: 'text' | 'pdf' | 'docx' | 'image' | 'audio' | 'video' | 'pasted'
  text: string
  path?: string // images: persisted path passed to the vision model
  mimeType?: string
  fileSize?: number
  createdAt?: string
  preview?: string // images: a local object URL shown immediately while processing
  status: 'loading' | 'ready' | 'error'
  error?: string
}

/**
 * The attachments of a persisted user turn, as a send can use them.
 *
 * A turn's attachments had two homes: the composer's transient `attachments` state, cleared the
 * moment the turn was sent, and the row persisted in the message context. Only the first was ever
 * read on the way to the model, so Resend / Regenerate / Edit replayed the TEXT of a turn and
 * silently dropped its images - the model then answered "I don't see an image attached" for a
 * message that visibly had one. The persisted row is the durable home (the files live under
 * uploads/), so every replay path rebuilds from it and the composer state is only ever the source
 * for the FIRST send.
 *
 * Status is 'ready' by construction: a turn only reaches the database once its attachments were.
 * The stored row keeps what a replay needs (name, kind, text, path) and not the composer-only
 * fields, so the id is rebuilt from the path - stable across replays of the same turn.
 */
type StoredAttachment = { name: string; kind: string; text?: string; path?: string }

function attachmentsOf(message: { attachments?: StoredAttachment[] }): Attachment[] {
  return (message.attachments ?? []).map((a, i) => ({
    id: `stored-${i}-${a.path ?? a.name}`,
    name: a.name,
    kind: a.kind as Attachment['kind'],
    text: a.text ?? '',
    path: a.path,
    status: 'ready' as const
  }))
}

type Conversation = RagConversationContract

type ProjectLite = { id: string; name: string }

interface MemoryChatProps {
  readonly onNavigateToMemory?: (memoryId: number) => void
  readonly onNavigateToChat?: (sessionId: string) => void
  readonly onNavigateToMeeting?: (meetingId: number) => void
  readonly onNavigateToEntity?: (entityId: number) => void
  /** Open the Projects screen focused on this chat's linked project. */
  readonly onOpenProject?: (projectId: string) => void
  /** Open the Replay screen seeked to a capture's moment (epoch ms). */
  readonly onSeekReplay?: (ts: number) => void
  /** Open the catalog-owned setup/run surface for a skill mention. */
  readonly onOpenSkillPreset?: (preset: DemoPreset) => void
  /** Open a specific conversation, or start a new one scoped to a project. */
  readonly openTarget?: Readonly<{
    conversationId?: string
    projectId?: string
    openGallery?: boolean
    /** Start a fresh chat and auto-send this prompt (an Explore preset handed off from a landing surface). */
    seedPrompt?: string
    /** Open the composer with this text. The user still confirms the send. */
    draftPrompt?: string
  }> | null
  readonly onTargetConsumed?: () => void
  /** Keep the surrounding task workspace scoped to the conversation shown here. */
  readonly onActiveConversationChange?: (conversationId: string | null) => void
}

function parseRagContext(context: unknown): RagContext | undefined {
  if (typeof context === 'string') {
    try {
      return JSON.parse(context) as RagContext
    } catch {
      return undefined
    }
  }
  return context && typeof context === 'object' ? (context as RagContext) : undefined
}

type RawRagMessage = {
  uuid?: unknown
  id?: unknown
  role: SyncedMessageRole
  content: string
  context?: unknown
  created_at?: string
  origin_device_id?: unknown
  origin_device_name?: unknown
}

function readRagProvenance(message: RawRagMessage): ChatMessage['provenance'] {
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
    !(turn.answer ?? turn.content).trim() &&
    turn.reasoning === undefined
  )
}

type ProjectedTurn = NonNullable<ReturnType<typeof projectSyncedMessageTurn>>

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
    context,
    reasoning: turn.reasoning ?? readReasoning(context),
    cutoff: readResponseCutoff(context),
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
  // Shared excludes this temporary row from the portable answer projection. Desktop still needs
  // the local row until the same UUID becomes the durable Enhanced prompt disclosure.
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
  // Mobile tool turns can persist a delimiter-only intermediate assistant row before the
  // tool result and final answer. It carries no thought content and must not become a visible
  // "<think> </think>" bubble on Desktop.
  // A turn with nothing in it is not a bubble. Mobile's tool loop persists a delimiter-only
  // assistant row before the tool result and the final answer; it used to arrive as the literal
  // "<think></think>" and was matched as that string. The shared projection now splits inline
  // reasoning out, so the same row arrives empty instead - test emptiness, which covers both and
  // any other way a turn can carry nothing.
  return [projectChatMessage(turn, context)]
}

function mapRagMessages(raw: RawRagMessage[]): ChatMessage[] {
  return raw.flatMap<ChatMessage>(mapRagMessage)
}

function ImageMetadata({
  metadata
}: Readonly<{
  metadata?: ImageGenerationMetadata
}>): React.JSX.Element | null {
  if (!metadata) return null
  return (
    <p aria-label="Image generation metadata" className="mt-1.5 text-[10px] text-neutral-600">
      {metadata.width} × {metadata.height} · {metadata.steps} steps · CFG {metadata.cfgScale} · seed{' '}
      {metadata.seed}
      {metadata.model ? ` · ${metadata.model}` : ''}
    </p>
  )
}

function ChatImagePreview({
  src,
  path,
  alt = 'Generated',
  metadata,
  className,
  fill = false,
  onOpen
}: Readonly<{
  src: string
  path?: string
  alt?: string
  metadata?: ImageGenerationMetadata
  className: string
  /** Widen the box to its container, for a picture whose own width is meant to fill it. Off by
   *  default: a preview with its own max-width would otherwise get a click target spanning the
   *  whole bubble, so clicking the empty space beside it would open the viewer. */
  fill?: boolean
  onOpen: (image: { url: string; path?: string }) => void
}>): React.JSX.Element {
  return (
    <div className={fill ? 'w-full' : undefined}>
      <button
        type="button"
        aria-label={`Open ${alt}`}
        onClick={() => onOpen({ url: src, path })}
        className={fill ? 'block w-full max-w-full' : 'block max-w-full'}
      >
        <img src={src} alt={alt} className={className} />
      </button>
      <ImageMetadata metadata={metadata} />
    </div>
  )
}

type StoredMessageAttachment = NonNullable<ChatMessage['attachments']>[number]
type OpenImage = { url: string; path?: string }

function isSupportingMessage(message: ChatMessage): boolean {
  return isSupportingChatContext({
    answer: message.content,
    reasoning: message.reasoning,
    reasoningLabel: message.reasoningLabel
  })
}

function selectedMessageContent(message: ChatMessage): string {
  if (!message.variants || message.variantIndex == null) return message.content
  return message.variants[message.variantIndex] ?? message.content
}

function renderedMessageContent(message: ChatMessage): string {
  const selected = selectedMessageContent(message)
  if (message.role !== 'assistant') return preprocessChatMarkdown(selected)
  return preprocessChatMarkdown(
    selected
      .replace(ASK_FENCE, '')
      .replace(/\[S(\d+)\]/g, '[S$1](cite:$1)')
      .trim()
  )
}

function standardMessageRowClass(message: ChatMessage): string {
  const margin = isSupportingMessage(message) ? 'mb-2' : 'mb-5'
  const alignment = message.role === 'user' ? 'items-end' : 'items-start'
  return `${margin} flex flex-col ${alignment}`
}

function standardMessageBubbleClass(message: ChatMessage, editing: boolean): string {
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

function contextResultCount(context: RagContext): number {
  return (
    (context.sources?.length ?? 0) +
    (context.memories?.length ?? 0) +
    (context.summaries?.length ?? 0) +
    (context.entities?.length ?? 0) +
    (context.entityFacts?.length ?? 0) +
    (context.unified?.length ?? 0)
  )
}

function NoticeMessageRow({ message }: Readonly<{ message: ChatMessage }>): React.JSX.Element {
  return (
    <div className="mb-4 flex justify-center">
      <span className="px-3 text-center text-[11px] leading-relaxed text-neutral-500">
        {noticeText(message.content)}
      </span>
    </div>
  )
}

function PromptEnhancementMessageRow({
  message
}: Readonly<{ message: ChatMessage }>): React.JSX.Element {
  return (
    <div className="mb-5 flex flex-col items-start" data-testid="prompt-enhancement-status">
      <ChatLoadingCard label={message.content.trim()} />
    </div>
  )
}

function ToolMessageTimelineRow({
  messages
}: Readonly<{ messages: ChatMessage[] }>): React.JSX.Element {
  return (
    <div
      className="mb-2 flex flex-col items-start"
      data-testid={`chat-tool-timeline-${messages[0]?.id ?? 'unknown'}`}
    >
      <ChatToolRows
        tools={messages.map((message) => ({
          name: message.toolName || 'Tool result',
          result: message.content,
          status: message.turnStatus === 'failed' ? 'failed' : 'completed',
          ...(message.generationTimeMs === undefined
            ? {}
            : { durationMs: message.generationTimeMs })
        }))}
      />
    </div>
  )
}

function VoiceMessageRow({
  message,
  autoPlay,
  copied,
  showTranscriptInitially,
  playbackSpeed,
  onPlaybackStateChange,
  onCopy,
  onOpenImage,
  onRegenerate
}: Readonly<{
  message: ChatMessage
  autoPlay: boolean
  copied: boolean
  showTranscriptInitially: boolean
  playbackSpeed: number
  onPlaybackStateChange: (messageId: string, active: boolean) => void
  onCopy: (text: string, key?: string) => void
  onOpenImage: (image: OpenImage) => void
  onRegenerate: (messageId: string) => void
}>): React.JSX.Element {
  const alignment = message.role === 'user' ? 'items-end' : 'items-start'
  const reportPlayback = useCallback(
    (active: boolean) => onPlaybackStateChange(message.id, active),
    [message.id, onPlaybackStateChange]
  )
  let body: React.JSX.Element
  if (message.role === 'user') {
    body = (
      <VoiceBubble
        messageId={message.id}
        isUser
        transcript={messageToSpeakable(message.content)}
        audioUrl={recordedClipUrl(message)}
        durationSeconds={message.audioDuration}
        synthesize={(text) => window.api.speak(text)}
        onPlaybackStateChange={reportPlayback}
        copied={copied}
        onCopy={(text) => onCopy(text, message.id)}
        defaultSpeed={playbackSpeed}
      />
    )
  } else if (isSupportingMessage(message)) {
    body = <ChatThinkingBlock content={message.reasoning ?? ''} label={message.reasoningLabel} />
  } else if (message.image) {
    body = (
      <>
        {message.reasoning?.trim() ? (
          <ChatThinkingBlock
            content={message.reasoning}
            live={Boolean(message.streaming)}
            label={message.reasoningLabel}
          />
        ) : null}
        <ChatImagePreview
          src={message.image}
          path={message.imagePath}
          metadata={message.imageMetadata}
          className="max-w-[20rem] cursor-zoom-in rounded-md border border-neutral-800 transition-opacity hover:opacity-90"
          onOpen={onOpenImage}
        />
      </>
    )
  } else {
    body = (
      <>
        {message.reasoning?.trim() ? (
          <ChatThinkingBlock
            content={message.reasoning}
            live={Boolean(message.streaming)}
            label={message.reasoningLabel}
          />
        ) : null}
        <VoiceBubble
          messageId={message.id}
          transcript={messageToSpeakable(selectedMessageContent(message))}
          isLoading={Boolean(message.streaming)}
          autoPlay={autoPlay}
          showTranscriptInitially={showTranscriptInitially}
          defaultSpeed={playbackSpeed}
          synthesize={(text) => window.api.speak(text)}
          onPlaybackStateChange={reportPlayback}
          copied={copied}
          onCopy={(text) => onCopy(text, message.id)}
          onRetry={() => onRegenerate(message.id)}
        />
      </>
    )
  }
  return <div className={`mb-4 flex flex-col gap-1.5 ${alignment}`}>{body}</div>
}

// Live web-task step narration, surfaced in the streaming turn (not below the browser).
// Self-contained: subscribes to the browser step feed and shows the last few notes while a
// task runs; a new running task resets it, and it renders nothing when there are no steps.
function WebTaskStepFeed(): React.JSX.Element | null {
  const [steps, setSteps] = useState<string[]>([])
  useEffect(() => {
    const offStep = window.api.browser?.onStep?.((e) => {
      const note = (e as { note?: string })?.note
      if (typeof note === 'string') {
        setSteps((prev) => [...prev, note])
      }
    })
    const offState = window.api.browser?.onTaskState?.((e) => {
      if ((e as { status?: string })?.status === 'running') {
        setSteps([])
      }
    })
    return () => {
      offStep?.()
      offState?.()
    }
  }, [])
  if (steps.length === 0) {
    return null
  }
  return (
    <div className="max-w-[85%] space-y-0.5 border-l-2 border-neutral-800 pl-3 text-[11px] leading-4 text-neutral-500">
      {steps.slice(-6).map((note, i) => (
        <div key={`${steps.length}-${i}`} className="truncate">
          {note}
        </div>
      ))}
    </div>
  )
}

function MessageThinkingHeader({ message }: Readonly<{ message: ChatMessage }>): React.JSX.Element {
  if (message.role !== 'assistant') return <></>
  if (message.streaming) {
    const activity = activityLabel(message.activity)
    const showLiveActivity = hasLiveStreamActivity(message)
    return (
      <div className="mb-1.5 flex flex-col gap-1.5">
        {showLiveActivity ? <LoadingDots /> : null}
        {message.reasoning?.trim() ? <ChatThinkingBlock content={message.reasoning} live /> : null}
        {showLiveActivity && activity ? (
          <span className="text-[11px] text-neutral-500">{activity}</span>
        ) : null}
        {showLiveActivity ? <WebTaskStepFeed /> : null}
      </div>
    )
  }
  if (!message.reasoning?.trim()) return <></>
  const supporting = isSupportingMessage(message)
  return (
    <div
      className={
        supporting
          ? // The same box a tool row uses. This pill sits BETWEEN tool rows in a tool-calling turn,
            // and at px-3.5/py-2.5 it was visibly fatter than the rows either side of it, so a
            // sequence of reasoning and calls read as two competing shapes rather than one list.
            'rounded-sm border border-neutral-800 bg-neutral-900/40 px-2 py-1'
          : 'mb-1'
      }
      data-testid={supporting ? 'supporting-context-bubble' : undefined}
    >
      <ChatThinkingBlock content={message.reasoning} label={message.reasoningLabel} />
    </div>
  )
}

function IncomingFileRows({
  files
}: Readonly<{ files: readonly IncomingSharedFile[] }>): React.JSX.Element {
  return (
    <>
      {files.map((incoming) => (
        <div
          key={`incoming-${incoming.syncId}`}
          data-testid="incoming-shared-file"
          className="mb-2 flex w-fit items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-2 py-1"
        >
          <LoadingDots size="small" />
          <span className="max-w-[16rem] truncate text-[10px] text-neutral-400">
            {incoming.name}
          </span>
        </div>
      ))}
    </>
  )
}

function MessageAttachments({
  attachments,
  onOpenAttachment,
  onOpenImage
}: Readonly<{
  attachments: readonly StoredMessageAttachment[]
  onOpenAttachment: (attachment: StoredMessageAttachment) => void
  onOpenImage: (image: OpenImage) => void
}>): React.JSX.Element {
  return (
    <div className="@container mb-2 flex w-full flex-wrap gap-1.5">
      {attachments.map((attachment, index) => {
        if (attachment.kind === 'image' && attachment.path) {
          const source = captureUrlForPath(attachment.path)
          return (
            <ChatImagePreview
              key={`${attachment.path}-${index}`}
              src={source}
              path={attachment.path}
              alt={attachment.name || 'Shared image'}
              fill
              // Full width, never taller than it is wide, and CROPPED - the way WhatsApp does it.
              //
              // Capped by height alone, a portrait photo stood narrow in a bubble as wide as the
              // prompt, with a band of empty grey beside it. Filling the width is what removes that
              // band; `100cqw` is the row's own width, so the ceiling follows the bubble at any
              // window size and an extreme portrait cannot tower. `cover` is what stops the band
              // coming back as letterboxing - a contained portrait just moves the grey to both
              // sides of a square. It crops from the bottom, and the whole picture is one click
              // away, which is where anyone who wants to READ a screenshot goes.
              className="max-h-[100cqw] w-full cursor-zoom-in rounded-md border border-neutral-800 object-cover object-top transition-opacity hover:opacity-90"
              onOpen={onOpenImage}
            />
          )
        }
        // The UI holds no opinion about what a PDF is: sync answers, this draws.
        const view = describeAttachment({
          fileName: attachment.name,
          mimeType: (attachment as { mimeType?: string }).mimeType,
          path: attachment.path,
          text: attachment.text
        })
        const viewable = view.viewable
        return (
          <button
            key={`${attachment.name}-${index}`}
            type="button"
            disabled={!viewable}
            onClick={() => onOpenAttachment(attachment)}
            title={viewable ? 'Click to view' : undefined}
            className="flex items-center gap-1 rounded-md bg-neutral-700/60 px-2 py-1 text-[10px] text-neutral-200 transition-colors enabled:cursor-pointer enabled:hover:bg-neutral-600/60"
          >
            <Paperclip className="h-3 w-3 text-neutral-400" />
            <span className="max-w-[12rem] truncate">{attachment.name}</span>
            <span className="text-neutral-500">{view.badge}</span>
          </button>
        )
      })}
    </div>
  )
}

function MessageEditor({
  messageId,
  text,
  onChange,
  onCancel,
  onSave
}: Readonly<{
  messageId: string
  text: string
  onChange: (text: string) => void
  onCancel: () => void
  onSave: (messageId: string) => void
}>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <textarea
        autoFocus
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onSave(messageId)
          }
          if (event.key === 'Escape') onCancel()
        }}
        rows={Math.min(10, text.split('\n').length + 1)}
        className="w-full resize-none rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-green-500"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onSave(messageId)}
          className="rounded-md bg-green-600 px-3 py-1 text-xs text-white transition-colors hover:bg-green-500"
        >
          Save & submit
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-400 transition-colors hover:text-neutral-200"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

const markdownComponents = chatMarkdownComponents

function makeCiteComponents(
  unified: RagContext['unified'],
  navigation: ContextNavigation
): Components {
  return {
    ...markdownComponents,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a: ({ href, children }: any) => {
      const match = typeof href === 'string' ? /^cite:(\d+)$/.exec(href) : null
      if (!match || !unified) {
        const DefaultAnchor = markdownComponents.a
        return DefaultAnchor ? (
          <DefaultAnchor href={href}>{children}</DefaultAnchor>
        ) : (
          <>{children}</>
        )
      }
      const source = unified[Number.parseInt(match[1]!, 10) - 1]
      return (
        <button
          type="button"
          onClick={() => {
            if (source) openUnifiedContext(source, navigation)
          }}
          title={
            source
              ? `${source.kind} · ${source.surface}${source.title ? ` · ${source.title}` : ''}`
              : 'source'
          }
          className="mx-0.5 inline-flex items-center rounded-sm border border-green-500/40 bg-green-500/10 px-1 align-baseline text-[0.72em] font-semibold text-green-500 transition-colors hover:bg-green-500/20"
        >
          {children}
        </button>
      )
    }
  }
}

const SKILL_MENTION_LINK_PREFIX = '#offgrid-skill-'

function renderUserSkillMention(content: string, installedSkillNames: readonly string[]): string {
  const match = /^\/([a-z0-9][a-z0-9_-]*)(?=\s|$)/i.exec(content)
  if (!match) return content
  const name = match[1]!
  const isInstalled = installedSkillNames.some(
    (installedName) => installedName.toLowerCase() === name.toLowerCase()
  )
  if (!isInstalled && !presetForSkillName(name)) return content
  return `[/${name}](${SKILL_MENTION_LINK_PREFIX}${encodeURIComponent(name)})${content.slice(match[0].length)}`
}

function makeUserMessageComponents(navigation: ContextNavigation): Components {
  return {
    ...markdownComponents,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a: ({ href, children }: any) => {
      const encodedName =
        typeof href === 'string' && href.startsWith(SKILL_MENTION_LINK_PREFIX)
          ? href.slice(SKILL_MENTION_LINK_PREFIX.length)
          : null
      if (!encodedName) {
        const DefaultAnchor = markdownComponents.a
        return DefaultAnchor ? (
          <DefaultAnchor href={href}>{children}</DefaultAnchor>
        ) : (
          <>{children}</>
        )
      }

      const name = /^[a-z0-9][a-z0-9_-]*$/i.test(encodedName) ? encodedName : null
      if (!name) return <>{children}</>
      const preset = presetForSkillName(name)
      const isInstalled = navigation.installedSkillNames?.some(
        (installedName) => installedName.toLowerCase() === name.toLowerCase()
      )
      if (!preset && !isInstalled) return <>{children}</>

      return (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="mx-0.5 inline-flex h-6 border-green-500/40 bg-green-500/10 px-1.5 align-baseline font-mono font-normal text-green-500 shadow-none hover:bg-green-500/20 hover:text-green-400"
          aria-label={`Open /${name} skill`}
          title={`Open /${name}`}
          onClick={() => {
            if (preset && navigation.onOpenSkillPreset) navigation.onOpenSkillPreset(preset)
            else navigation.onOpenInstalledSkill?.(name)
          }}
        >
          {children}
        </Button>
      )
    }
  }
}

function MessageMarkdown({
  message,
  navigation
}: Readonly<{
  message: ChatMessage
  navigation: ContextNavigation
}>): React.JSX.Element {
  const components =
    message.role === 'assistant'
      ? makeCiteComponents(message.context?.unified, navigation)
      : makeUserMessageComponents(navigation)
  const content =
    message.role === 'user'
      ? renderUserSkillMention(
          renderedMessageContent(message),
          navigation.installedSkillNames ?? []
        )
      : renderedMessageContent(message)
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
      {content}
    </ReactMarkdown>
  )
}

function ResponseCutoffNotice({
  cutoff
}: Readonly<{ cutoff?: ResponseCutoffContract }>): React.JSX.Element | null {
  if (!cutoff) return null
  return (
    <p
      role="status"
      className="mt-2 flex items-start gap-1.5 border-t border-amber-500/20 pt-2 text-[11px] text-amber-400"
    >
      <WarningCircle className="mt-0.5 h-3 w-3 shrink-0" weight="fill" />
      Response stopped at the configured {cutoff.maxTokens.toLocaleString()}-token limit.
    </p>
  )
}

function ImageMemoryRetryAction({
  message,
  loading,
  onRetry
}: Readonly<{
  message: ChatMessage
  loading: boolean
  onRetry: (retry: NonNullable<ChatMessage['imageMemoryRetry']>) => void
}>): React.JSX.Element | null {
  const retry = message.imageMemoryRetry
  if (!retry) return null
  return (
    <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
      <p className="min-w-0 flex-1 text-[10px] text-muted-foreground">
        Running this model may make your Mac unresponsive.
      </p>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={loading}
        onClick={() => onRetry(retry)}
        className="shrink-0 active:scale-95"
      >
        Run anyway
      </Button>
    </div>
  )
}

function ArtifactCard({
  artifact,
  onOpen
}: Readonly<{
  artifact: Artifact | null
  onOpen: (artifact: Artifact) => void
}>): React.JSX.Element | null {
  if (!artifact) return null
  return (
    <button
      type="button"
      onClick={() => onOpen(artifact)}
      className="mt-2 flex w-full items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2.5 text-left transition-colors hover:border-green-500/60"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-800 bg-neutral-950 text-green-500">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-neutral-200">
          {artifact.title || `${artifact.kind.toUpperCase()} artifact`}
        </span>
        <span className="block text-[11px] text-neutral-500">Click to open in the canvas →</span>
      </span>
    </button>
  )
}

function AskCard({
  ask,
  selected,
  onSelect,
  onSubmit
}: Readonly<{
  ask: AskBlock | null
  selected: readonly string[]
  onSelect: (option: string, selected: boolean) => void
  onSubmit: () => void
}>): React.JSX.Element | null {
  if (!ask) return null
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <p className="text-xs text-neutral-400">{ask.question}</p>
      <div className="flex flex-wrap gap-1.5">
        {ask.options.map((option) => {
          const active = selected.includes(option)
          const className = active
            ? 'border-green-500 text-green-500'
            : 'border-neutral-700 text-neutral-300 hover:border-green-500 hover:text-green-500'
          return (
            <button
              key={option}
              type="button"
              onClick={() => onSelect(option, active)}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${className}`}
            >
              {option}
            </button>
          )
        })}
      </div>
      {ask.multiSelect && selected.length > 0 ? (
        <button
          type="button"
          onClick={onSubmit}
          className="mt-1 self-start rounded-md bg-green-600 px-3 py-1 text-xs text-white transition-colors hover:bg-green-500"
        >
          Submit ({selected.length})
        </button>
      ) : null}
    </div>
  )
}

function CopyAction({
  copied,
  onCopy
}: Readonly<{ copied: boolean; onCopy: () => void }>): React.JSX.Element {
  const color = copied ? 'text-green-500' : 'text-neutral-600 hover:text-green-500'
  return (
    <button
      type="button"
      onClick={onCopy}
      className={`flex items-center gap-1 text-[11px] transition-colors ${color}`}
      title="Copy"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" weight="bold" />
      ) : (
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 16h8M8 12h8m-7 8h6a2 2 0 002-2V6a2 2 0 00-2-2h-3.586a1 1 0 00-.707.293l-2.414 2.414A1 1 0 009 7.414V18a2 2 0 002 2z"
          />
        </svg>
      )}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function RegenerateAction({
  label,
  title,
  onRegenerate
}: Readonly<{
  label: string
  title: string
  onRegenerate: () => void
}>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onRegenerate}
      className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500"
      title={title}
    >
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        />
      </svg>
      {label}
    </button>
  )
}

function UserMessageActions({
  copied,
  onCopy,
  onEdit,
  onRegenerate
}: Readonly<{
  copied: boolean
  onCopy: () => void
  onEdit: () => void
  onRegenerate: () => void
}>): React.JSX.Element {
  return (
    <div className="mt-1.5 flex items-center gap-3">
      <CopyAction copied={copied} onCopy={onCopy} />
      <RegenerateAction
        label="Resend"
        title="Regenerate the reply to this message"
        onRegenerate={onRegenerate}
      />
      <button
        type="button"
        onClick={onEdit}
        className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500"
        title="Edit this message"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
          />
        </svg>
        Edit
      </button>
    </div>
  )
}

type SpeechControlState = 'idle' | 'loading' | 'playing'

function speechControlState(
  messageId: string,
  speakingId: string | null,
  loadingId: string | null
): SpeechControlState {
  if (loadingId === messageId) return 'loading'
  if (speakingId === messageId) return 'playing'
  return 'idle'
}

function SpeechAction({
  state,
  onSpeak
}: Readonly<{
  state: SpeechControlState
  onSpeak: () => void
}>): React.JSX.Element {
  let label = 'Speak'
  let icon: React.JSX.Element = (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M11 5L6 9H2v6h4l5 4V5z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14"
      />
    </svg>
  )
  if (state === 'loading') {
    label = 'Generating…'
    icon = (
      <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
    )
  } else if (state === 'playing') {
    label = 'Stop'
    icon = (
      <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
        <rect x="6" y="5" width="4" height="14" rx="1" />
        <rect x="14" y="5" width="4" height="14" rx="1" />
      </svg>
    )
  }
  const color = state === 'idle' ? 'text-neutral-600 hover:text-green-500' : 'text-green-500'
  return (
    <button
      type="button"
      onClick={onSpeak}
      className={`flex items-center gap-1 text-[11px] transition-colors ${color}`}
      title={label}
    >
      {icon}
      {label}
    </button>
  )
}

function VariantNavigation({
  message,
  onSelect
}: Readonly<{
  message: ChatMessage
  onSelect: (direction: -1 | 1) => void
}>): React.JSX.Element | null {
  if (!message.variants || message.variants.length <= 1) return null
  const index = message.variantIndex ?? 0
  return (
    <span className="flex items-center gap-1 text-[11px] text-neutral-500">
      <button
        type="button"
        onClick={() => onSelect(-1)}
        disabled={index <= 0}
        className="transition-colors hover:text-green-500 disabled:opacity-30"
      >
        ‹
      </button>
      <span>
        {index + 1}/{message.variants.length}
      </span>
      <button
        type="button"
        onClick={() => onSelect(1)}
        disabled={index >= message.variants.length - 1}
        className="transition-colors hover:text-green-500 disabled:opacity-30"
      >
        ›
      </button>
    </span>
  )
}

function AssistantMessageActions({
  message,
  artifact,
  copied,
  speechState,
  speechError,
  speechEnabled,
  onCopy,
  onOpenArtifact,
  onRegenerate,
  onSelectVariant,
  onSpeak
}: Readonly<{
  message: ChatMessage
  artifact: Artifact | null
  copied: boolean
  speechState: SpeechControlState
  speechError?: string
  speechEnabled: boolean
  onCopy: () => void
  onOpenArtifact: (artifact: Artifact) => void
  onRegenerate: () => void
  onSelectVariant: (direction: -1 | 1) => void
  onSpeak: () => void
}>): React.JSX.Element | null {
  if (message.image || isSupportingMessage(message)) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
      {speechEnabled ? <SpeechAction state={speechState} onSpeak={onSpeak} /> : null}
      <CopyAction copied={copied} onCopy={onCopy} />
      <RegenerateAction label="Regenerate" title="Regenerate" onRegenerate={onRegenerate} />
      <VariantNavigation message={message} onSelect={onSelectVariant} />
      {artifact ? (
        <button
          type="button"
          onClick={() => onOpenArtifact(artifact)}
          className="flex items-center gap-1 text-[11px] text-green-500 transition-colors hover:text-emerald-500"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 17V7h10v10M9 17H5a2 2 0 01-2-2V5a2 2 0 012-2h10a2 2 0 012 2v2"
            />
          </svg>
          Open canvas
        </button>
      ) : null}
      {speechError ? (
        <p role="alert" className="basis-full text-[11px] leading-4 text-red-400">
          {speechError}
        </p>
      ) : null}
    </div>
  )
}

type ContextNavigation = Readonly<{
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

type UnifiedContextItem = NonNullable<RagContext['unified']>[number]

function openUnifiedContext(item: UnifiedContextItem, navigation: ContextNavigation): void {
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

function UnifiedContextSection({
  items,
  navigation
}: Readonly<{
  items?: readonly UnifiedContextItem[]
  navigation: ContextNavigation
}>): React.JSX.Element | null {
  if (!items?.length) return null
  return (
    <div className="mb-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        Sources ({items.length}) — cited as [S#]
      </div>
      <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-3">
        {items.map((item, index) => {
          const title = item.title && item.title !== item.surface ? item.title : item.snippet
          const replaySuffix = item.kind === 'screen' ? ' · open in Replay →' : ''
          return (
            <button
              key={`${item.kind}-${item.refId ?? item.ts}-${index}`}
              type="button"
              onClick={() => openUnifiedContext(item, navigation)}
              title={`${item.kind} · ${item.surface}${item.title ? ` · ${item.title}` : ''}${replaySuffix}`}
              className="flex flex-col gap-1 overflow-hidden rounded-md border border-neutral-800 p-2 text-left text-[11px] text-neutral-400 transition-colors hover:border-green-500"
            >
              {item.kind === 'screen' && item.imagePath ? (
                <img
                  src={captureUrlForPath(item.imagePath)}
                  alt=""
                  className="mb-0.5 h-16 w-full rounded border border-neutral-800 object-cover"
                />
              ) : null}
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-green-500">[S{index + 1}]</span>
                <span className="rounded-sm border border-neutral-700 px-1 text-[9px] uppercase tracking-wide text-neutral-500">
                  {item.kind}
                </span>
              </div>
              <span className="line-clamp-2 text-neutral-300">{title}</span>
              <span className="truncate text-[10px] text-neutral-600">
                {item.surface}
                {replaySuffix}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SourceScoresSection({
  sources
}: Readonly<{
  sources?: readonly NonNullable<RagContext['sources']>[number][]
}>): React.JSX.Element | null {
  if (!sources?.length) return null
  return (
    <div className="mb-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        Sources ({sources.length})
      </div>
      <div className="space-y-1">
        {sources.slice(0, 8).map((source, index) => (
          <div
            key={`${source.name}-${index}`}
            className="flex items-center gap-2 rounded-md border border-neutral-800 p-2 text-[11px] text-neutral-400"
          >
            <span className="min-w-0 flex-1 truncate">{source.name}</span>
            <span className="shrink-0 text-neutral-600">{(source.score * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function MasterMemorySection({
  content
}: Readonly<{ content?: string | null }>): React.JSX.Element | null {
  if (!content) return null
  return (
    <div className="mb-3 rounded-md border border-neutral-800 p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">Master memory</div>
      <div className="text-neutral-300">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
          {preprocessChatMarkdown(content)}
        </ReactMarkdown>
      </div>
    </div>
  )
}

function MemoriesContextSection({
  memories,
  onNavigate
}: Readonly<{
  memories?: readonly RagMemory[]
  onNavigate?: (memoryId: number) => void
}>): React.JSX.Element | null {
  if (!memories?.length) return null
  return (
    <div className="mb-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        Memories ({memories.length})
      </div>
      <div className="space-y-1">
        {memories.slice(0, 5).map((memory, index) => (
          <button
            key={memory.id || index}
            type="button"
            onClick={() => onNavigate?.(memory.id)}
            className="block w-full rounded-md border border-neutral-800 p-2 text-left transition-colors hover:border-neutral-700"
          >
            <p className="line-clamp-2 text-[11px] text-neutral-400">
              {memory.content || memory.text || 'Memory'}
            </p>
          </button>
        ))}
      </div>
    </div>
  )
}

function SummariesContextSection({
  summaries,
  onNavigate
}: Readonly<{
  summaries?: readonly RagSummary[]
  onNavigate?: (sessionId: string) => void
}>): React.JSX.Element | null {
  if (!summaries?.length) return null
  return (
    <div className="mb-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        Related chats ({summaries.length})
      </div>
      <div className="space-y-1">
        {summaries.slice(0, 5).map((summary, index) => (
          <button
            key={summary.session_id || index}
            type="button"
            onClick={() => onNavigate?.(summary.session_id)}
            className="block w-full rounded-md border border-neutral-800 p-2 text-left transition-colors hover:border-neutral-700"
          >
            <p className="line-clamp-2 text-[11px] text-neutral-400">
              {summary.summary || summary.title || 'Chat'}
            </p>
            {summary.app_name ? (
              <span className="mt-1 inline-block text-[10px] text-neutral-600">
                {summary.app_name}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}

function EntitiesContextSection({
  entities,
  onNavigate
}: Readonly<{
  entities?: readonly RagEntity[]
  onNavigate?: (entityId: number) => void
}>): React.JSX.Element | null {
  if (!entities?.length) return null
  return (
    <div className="mb-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        Entities ({entities.length})
      </div>
      <div className="flex flex-wrap gap-1">
        {entities.slice(0, 10).map((entity, index) => (
          <button
            key={entity.id || index}
            type="button"
            onClick={() => onNavigate?.(entity.id)}
            className="rounded-md border border-neutral-800 px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:border-green-500 hover:text-green-500"
          >
            {entity.name || 'Entity'}
          </button>
        ))}
      </div>
    </div>
  )
}

function EntityFactsContextSection({
  facts
}: Readonly<{ facts?: readonly RagEntityFact[] }>): React.JSX.Element | null {
  if (!facts?.length) return null
  return (
    <div>
      <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
        Entity facts ({facts.length})
      </div>
      <div className="space-y-1">
        {facts.slice(0, 5).map((fact, index) => (
          <div key={index} className="rounded-md border border-neutral-800 p-2">
            <p className="line-clamp-2 text-[11px] text-neutral-400">
              {typeof fact === 'string' ? fact : fact.fact}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

function ContextDisclosure({
  context,
  navigation
}: Readonly<{
  context?: RagContext
  navigation: ContextNavigation
}>): React.JSX.Element | null {
  if (!context) return null
  const resultCount = contextResultCount(context)
  if (resultCount === 0) return null
  return (
    <Collapsible className="mt-2 w-full max-w-[90%]">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-left text-xs text-neutral-400 transition-colors hover:border-neutral-700">
        <svg
          className="h-3.5 w-3.5 text-green-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span className="flex-1">Searched your memory — {resultCount} results</span>
        <svg
          className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 max-h-[400px] max-w-full overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900/40 p-4 text-sm">
        <UnifiedContextSection items={context.unified} navigation={navigation} />
        <SourceScoresSection sources={context.sources} />
        <MasterMemorySection content={context.masterMemory} />
        <MemoriesContextSection
          memories={context.memories}
          onNavigate={navigation.onNavigateToMemory}
        />
        <SummariesContextSection
          summaries={context.summaries}
          onNavigate={navigation.onNavigateToChat}
        />
        <EntitiesContextSection
          entities={context.entities}
          onNavigate={navigation.onNavigateToEntity}
        />
        <EntityFactsContextSection facts={context.entityFacts} />
      </CollapsibleContent>
    </Collapsible>
  )
}

type MessageRowState = Readonly<{
  autoPlayId: string | null
  copiedKey: string | null
  editingId: string | null
  editText: string
  loading: boolean
  speakingId: string | null
  speakLoadingId: string | null
  speakError: { id: string; message: string } | null
  ttsEnabled: boolean
  ttsSpeed: number
  latestVoiceAssistantId: string | null
  askSelections: Readonly<Record<string, readonly string[]>>
  incomingFiles: readonly IncomingSharedFile[]
}>

type AskOptionSelection = Readonly<{
  message: ChatMessage
  ask: AskBlock
  option: string
  selected: boolean
}>

type MessageRowActions = Readonly<{
  copy: (text: string, key?: string) => void
  regenerate: (messageId: string) => void
  openImage: (image: OpenImage) => void
  openAttachment: (attachment: StoredMessageAttachment) => void
  startEdit: (message: ChatMessage) => void
  changeEditText: (text: string) => void
  cancelEdit: () => void
  saveEdit: (messageId: string) => void
  retryImageMemory: (retry: NonNullable<ChatMessage['imageMemoryRetry']>) => void
  openArtifact: (artifact: Artifact) => void
  selectAskOption: (selection: AskOptionSelection) => void
  submitAsk: (selected: readonly string[]) => void
  speak: (messageId: string, content: string) => void
  voicePlaybackChange: (messageId: string, active: boolean) => void
  selectVariant: (messageId: string, direction: -1 | 1) => void
}>

type MessageRowProps = Readonly<{
  message: ChatMessage
  nextMessageRole?: SyncedMessageRole
  voiceMode: boolean
  state: MessageRowState
  actions: MessageRowActions
  navigation: ContextNavigation
}>

function MessageBubble({
  message,
  state,
  actions,
  navigation
}: Readonly<{
  message: ChatMessage
  state: MessageRowState
  actions: MessageRowActions
  navigation: ContextNavigation
}>): React.JSX.Element {
  const editing = state.editingId === message.id
  const artifact = message.role === 'assistant' ? parseArtifact(message.content) : null
  const ask = message.role === 'assistant' ? parseAsk(message.content) : null
  const selected = state.askSelections[message.id] ?? []
  return (
    <div className={standardMessageBubbleClass(message, editing)}>
      {message.context?.taskGuidance ? (
        <div className="mb-2 flex items-center justify-between gap-3 border-b border-green-500/20 pb-2 text-[9px] uppercase tracking-wide text-green-600 dark:text-green-400">
          <span>Task guidance</span>
          <span>{message.context.taskGuidance.state}</span>
        </div>
      ) : null}
      <IncomingFileRows files={state.incomingFiles} />
      {message.attachments?.length ? (
        <MessageAttachments
          attachments={message.attachments}
          onOpenAttachment={actions.openAttachment}
          onOpenImage={actions.openImage}
        />
      ) : null}
      {message.image ? (
        <ChatImagePreview
          src={message.image}
          path={message.imagePath}
          metadata={message.imageMetadata}
          className="mb-2 w-full max-w-full cursor-zoom-in rounded-md border border-neutral-800 object-contain transition-opacity hover:opacity-90"
          onOpen={actions.openImage}
        />
      ) : null}
      {editing ? (
        <MessageEditor
          messageId={message.id}
          text={state.editText}
          onChange={actions.changeEditText}
          onCancel={actions.cancelEdit}
          onSave={actions.saveEdit}
        />
      ) : (
        <MessageMarkdown message={message} navigation={navigation} />
      )}
      <ResponseCutoffNotice cutoff={message.cutoff} />
      <ImageMemoryRetryAction
        message={message}
        loading={state.loading}
        onRetry={actions.retryImageMemory}
      />
      <ArtifactCard artifact={artifact} onOpen={actions.openArtifact} />
      <AskCard
        ask={ask}
        selected={selected}
        onSelect={(option, active) => {
          if (ask) actions.selectAskOption({ message, ask, option, selected: active })
        }}
        onSubmit={() => actions.submitAsk(selected)}
      />
    </div>
  )
}

function StandardMessageRow({
  message,
  state,
  actions,
  navigation
}: Omit<MessageRowProps, 'nextMessageRole' | 'voiceMode'>): React.JSX.Element {
  const artifact = message.role === 'assistant' ? parseArtifact(message.content) : null
  const copied = state.copiedKey === message.id
  const speechState = speechControlState(message.id, state.speakingId, state.speakLoadingId)
  const speechError = state.speakError?.id === message.id ? state.speakError.message : undefined
  return (
    <div className={standardMessageRowClass(message)} data-testid={`chat-message-${message.id}`}>
      <MessageThinkingHeader message={message} />
      <MessageBubble message={message} state={state} actions={actions} navigation={navigation} />
      <ChatToolRows tools={message.toolCalls} />
      {message.role === 'user' ? (
        message.context?.taskGuidance ? (
          <div className="mt-1.5 flex items-center gap-3">
            <CopyAction copied={copied} onCopy={() => actions.copy(message.content, message.id)} />
          </div>
        ) : (
          <UserMessageActions
            copied={copied}
            onCopy={() => actions.copy(message.content, message.id)}
            onEdit={() => actions.startEdit(message)}
            onRegenerate={() => actions.regenerate(message.id)}
          />
        )
      ) : (
        <AssistantMessageActions
          message={message}
          artifact={artifact}
          copied={copied}
          speechState={speechState}
          speechError={speechError}
          speechEnabled={state.ttsEnabled}
          onCopy={() => actions.copy(message.content, message.id)}
          onOpenArtifact={actions.openArtifact}
          onRegenerate={() => actions.regenerate(message.id)}
          onSelectVariant={(direction) => actions.selectVariant(message.id, direction)}
          onSpeak={() => actions.speak(message.id, message.content)}
        />
      )}
      {message.role === 'assistant' ? (
        <ContextDisclosure context={message.context} navigation={navigation} />
      ) : null}
    </div>
  )
}

/**
 * Draw a document's actual bytes.
 *
 * main serves an uploaded file as a data URL (`files:data-url`) precisely so Chromium's built-in
 * viewer can render a PDF natively rather than dumping parsed text - but nothing ever called it, so
 * every document fell through to the text pane and showed an empty page. The handler boundary-checks
 * the path against the uploads directory, so this cannot be pointed at arbitrary files.
 */
/**
 * The recorded clip for a voice note, when the message carries one.
 *
 * A note recorded HERE arrives with audioUrl already set. One that SYNCED from a phone arrives as an
 * ordinary audio attachment with a path and no url - so VoiceBubble saw no clip and fell back to
 * synthesizing the transcript with Kokoro, reading the user's own words back in the assistant's
 * voice instead of playing what they actually said.
 *
 * Kind comes from the shared attachment-kind rule rather than an extension check here, so desktop
 * and mobile agree on what counts as audio.
 */
function recordedClipUrl(message: ChatMessage): string | undefined {
  if (message.audioUrl) return message.audioUrl
  const clip = message.attachments?.find(
    (a) => !!a.path && attachmentKindFor({ fileName: a.name }) === 'audio'
  )
  return clip?.path ? captureUrlForPath(clip.path) : undefined
}

function DocumentPane({ path, title }: { path: string; title: string }): React.JSX.Element {
  // The SAME transport images use. The loopback media server already serves `uploads` (see
  // media-roots.ts) with canonicalisation and root admission, and captureUrlForPath is how every
  // other local file reaches the renderer.
  //
  // The first attempt used a data: URL from files:data-url and drew a blank page: frame-src did not
  // allow data:, so Chromium blocked the frame silently. Reusing the media origin keeps one file
  // path for all local media instead of adding a second, weaker one to the CSP.
  const src = captureUrlForPath(path)
  if (!src) {
    return (
      <div className="w-full max-w-3xl rounded-md border border-neutral-800 bg-neutral-950 p-5 text-sm text-neutral-400">
        This file could not be opened. Its bytes are not on this device.
      </div>
    )
  }
  return (
    <iframe
      src={src}
      title={title}
      className="h-full max-h-full w-full max-w-3xl rounded-md border border-neutral-800 bg-neutral-950"
    />
  )
}

/**
 * A voice note, played rather than looked at.
 *
 * attachment-kind already answers `renderer: 'audio'`; the viewer simply had no branch for it, so a
 * .wav fell through to the text pane and drew an empty page - a note that HAD synced looked like a
 * note that had not. Same media-origin transport as images and documents, so there is one way local
 * bytes reach the renderer.
 */
function AudioPane({ path, title }: { path: string; title: string }): React.JSX.Element {
  const src = captureUrlForPath(path)
  if (!src) {
    return (
      <div className="w-full max-w-3xl rounded-md border border-neutral-800 bg-neutral-950 p-5 text-sm text-neutral-400">
        This voice note could not be played. Its bytes are not on this device.
      </div>
    )
  }
  return (
    <div className="w-full max-w-3xl rounded-md border border-neutral-800 bg-neutral-950 p-5">
      <div className="mb-3 truncate text-xs text-neutral-400">{title}</div>
      <audio src={src} controls autoPlay className="w-full" />
    </div>
  )
}

function MessageRow({
  message,
  voiceMode,
  state,
  actions,
  navigation
}: MessageRowProps): React.JSX.Element {
  let body: React.JSX.Element
  if (message.notice) {
    body = <NoticeMessageRow message={message} />
  } else if (isPromptEnhancementMessage(message)) {
    body = <PromptEnhancementMessageRow message={message} />
  } else if (message.role === 'tool') {
    body = <ToolMessageTimelineRow messages={[message]} />
  } else if (voiceMode) {
    body = (
      <VoiceMessageRow
        message={message}
        autoPlay={state.autoPlayId === message.id}
        copied={state.copiedKey === message.id}
        showTranscriptInitially={state.latestVoiceAssistantId === message.id}
        playbackSpeed={state.ttsSpeed}
        onPlaybackStateChange={actions.voicePlaybackChange}
        onCopy={actions.copy}
        onOpenImage={actions.openImage}
        onRegenerate={actions.regenerate}
      />
    )
  } else {
    body = (
      <StandardMessageRow
        message={message}
        state={state}
        actions={actions}
        navigation={navigation}
      />
    )
  }
  return body
}

// Core (free) suggestions — generic chat/build/image. Pro adds memory-aware ones.
const ASK_EXAMPLES = [
  'Explain how RAG works, simply',
  'Write a Python function to dedupe a list',
  'Draft a friendly out-of-office email',
  'Generate an image of a mountain cabin at dawn'
]
const ASK_EXAMPLES_PRO = [
  'What did I work on today?',
  'Summarize my last meeting',
  'What have I spent the most time on this week?',
  'What open action items do I have?'
]
const IMAGE_EXAMPLES = [
  'A serene mountain lake at dawn, photorealistic',
  'Minimal logo mark for a coffee brand, flat',
  'Cyberpunk city street at night, neon, rain',
  'Studio portrait of a husky, soft lighting'
]

// Visual style presets. The prompt modifier and bundled preview share this key.
const STYLE_PRESETS: { name: string; prompt: string }[] = [
  {
    name: 'Photoreal',
    prompt: 'photorealistic, sharp focus, high detail, 50mm photo'
  },
  {
    name: 'Cinematic',
    prompt: 'cinematic film still, dramatic lighting, shallow depth of field, color graded'
  },
  {
    name: 'Anime',
    prompt: 'anime illustration, clean lineart, vibrant colors'
  },
  {
    name: 'Sketch',
    prompt: 'detailed pencil sketch on paper, monochrome line art'
  },
  {
    name: 'Watercolor',
    prompt: 'watercolor painting, soft washes, paper texture'
  },
  {
    name: 'Oil painting',
    prompt: 'oil painting, visible brushstrokes, classical, rich color'
  },
  {
    name: 'Monochrome',
    prompt: 'black and white, high contrast, monochrome'
  },
  {
    name: 'Neon',
    prompt: 'neon-lit cyberpunk, glowing lights, night, moody'
  },
  {
    name: '3D render',
    prompt: '3D render, octane, soft studio lighting, subsurface detail'
  },
  {
    name: 'Steampunk',
    prompt: 'steampunk, brass and gears, victorian, intricate'
  },
  {
    name: 'Surreal',
    prompt: 'surreal, dreamlike, imaginative composition'
  },
  {
    name: 'Vintage film',
    prompt: 'vintage film photograph, faded colors, grain, 1970s'
  },
  {
    name: 'Minimal',
    prompt: 'minimal flat design, clean, simple shapes, lots of negative space'
  },
  {
    name: 'Risograph',
    prompt: 'risograph print, halftone texture, limited palette'
  },
  {
    name: 'Fantasy art',
    prompt: 'epic fantasy concept art, dramatic, highly detailed'
  },
  {
    name: 'Studio portrait',
    prompt: 'studio portrait, soft key light, bokeh background'
  }
]

function styleKey(name: string): string {
  return name.replace(/[^\w-]+/g, '_')
}

function StylePresetPicker({
  activeStyle,
  compact = false,
  styleThumbs,
  onChange
}: Readonly<{
  activeStyle: string | null
  compact?: boolean
  styleThumbs: Record<string, string>
  onChange: (style: string | null) => void
}>): React.JSX.Element {
  return (
    <div className={compact ? 'mb-2 w-full' : 'mt-4 w-full'}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-neutral-600">Style</span>
        {activeStyle ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-[10px] text-neutral-600 transition-colors hover:text-neutral-300"
          >
            Clear {activeStyle}
          </button>
        ) : null}
      </div>
      <div
        className={`grid w-full grid-cols-2 gap-2.5 sm:grid-cols-4 ${compact ? 'lg:grid-cols-8' : ''}`}
      >
        {STYLE_PRESETS.map((style) => {
          const thumb = styleThumbs[styleKey(style.name)]
          const selected = activeStyle === style.name
          return (
            <button
              key={style.name}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(selected ? null : style.name)}
              className={`group relative overflow-hidden rounded-md border transition-all ${compact ? 'h-48' : 'aspect-[16/9]'} ${
                selected
                  ? 'border-green-500 ring-1 ring-green-500'
                  : 'border-neutral-800 hover:border-neutral-600'
              }`}
            >
              {thumb ? (
                <img
                  src={captureUrlForPath(thumb)}
                  alt={style.name}
                  className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
              ) : (
                <span className="absolute inset-0 bg-neutral-900" />
              )}
              <span className="absolute inset-x-0 bottom-0 bg-black/70 px-2 py-1.5 text-left text-[11px] font-medium text-white">
                {style.name}
              </span>
              {selected ? (
                <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-green-500 text-neutral-950">
                  <Check className="h-3 w-3" weight="bold" />
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const NEW_CHAT = '__new__' // bucket key for a fresh, not-yet-saved conversation
const EMPTY_MSGS: ChatMessage[] = []

function nextVoicePlaybackOwner(
  current: string | null,
  messageId: string,
  active: boolean
): string | null {
  if (active) return messageId
  return current === messageId ? null : current
}

function textRecordingButtonLabel(phase: ChatVoicePhase): string {
  if (phase === 'transcribing') return 'Cancel transcription'
  if (phase !== 'idle') return 'Stop recording'
  return 'Record voice'
}

function textRecordingTooltip(phase: ChatVoicePhase, transcriptionLabel: string): string {
  if (phase === 'transcribing') {
    return `Transcribing with ${transcriptionLabel} - click to cancel`
  }
  if (phase !== 'idle') return 'Stop recording'
  return 'Record voice'
}

async function stopLiveWebUseForConversation(conversationId: string | null): Promise<void> {
  if (!conversationId || !window.api.tasks?.list || !window.api.browser?.stopTask) return
  try {
    const tasks = await window.api.tasks.list()
    const live = new Set(['running', 'paused', 'waiting', 'reconnecting'])
    const matching = tasks.filter(
      (task) =>
        task.kind === 'web_use' && task.journeyId === conversationId && live.has(task.status)
    )
    await Promise.all(matching.map((task) => window.api.browser!.stopTask(task.taskId)))
  } catch (error) {
    console.error('Failed to stop Web Use for this Chat:', error)
  }
}

async function stopLiveTask(task: Pick<TaskSession, 'taskId' | 'kind'>): Promise<boolean> {
  if (task.kind === 'web_use') {
    return (await window.api.browser?.stopTask(task.taskId)) ?? false
  }
  return (await window.api.vision?.control('stop', task.taskId)) ?? false
}

function stopFailureMessage(kind: TaskSession['kind']): string {
  return `${kind === 'web_use' ? 'Web Use' : 'Computer Use'} could not be stopped on this device.`
}

export function MemoryChat({
  onNavigateToMemory,
  onNavigateToChat,
  onNavigateToMeeting,
  onNavigateToEntity,
  onOpenProject,
  onSeekReplay,
  onOpenSkillPreset,
  openTarget,
  onTargetConsumed,
  onActiveConversationChange
}: MemoryChatProps) {
  const { isPro } = useRendererEntitlement()
  const { tasks: taskSessions } = useTaskSessions()
  // Messages are kept PER CONVERSATION so a background tab keeps its own thread and
  // an in-flight stream can't leak into whatever tab you switch to. `messages` (below,
  // after activeConversationId) is the active tab's slice; sends target their own conv.
  const [messagesByConv, setMessagesByConv] = useState<Record<string, ChatMessage[]>>({})
  const setConvMessages = useCallback(
    (
      cid: string | null,
      updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])
    ): void => {
      const k = cid ?? NEW_CHAT
      setMessagesByConv((prev) => ({
        ...prev,
        [k]:
          typeof updater === 'function'
            ? (updater as (p: ChatMessage[]) => ChatMessage[])(prev[k] ?? [])
            : updater
      }))
    },
    []
  )
  // A peer can update one durable message twice in quick succession (the prompt-enhancement
  // placeholder, then its final disclosure). SQLite reads started for both broadcasts may finish
  // out of order; only the newest read is allowed to replace the rendered conversation.
  const conversationMessageLoadVersionRef = useRef<Map<string, number>>(new Map())
  const loadLatestConversationMessages = useCallback(
    async (conversationId: string): Promise<ChatMessage[] | null> => {
      const nextVersion = (conversationMessageLoadVersionRef.current.get(conversationId) ?? 0) + 1
      conversationMessageLoadVersionRef.current.set(conversationId, nextVersion)
      const rawMessages = await window.api.getRagMessages(conversationId)
      if (conversationMessageLoadVersionRef.current.get(conversationId) !== nextVersion) return null
      return mapRagMessages(rawMessages)
    },
    []
  )
  const refreshConversationMessages = useCallback(
    async (conversationId: string): Promise<void> => {
      const nextMessages = await loadLatestConversationMessages(conversationId)
      if (!nextMessages) return
      setConvMessages(conversationId, nextMessages)
    },
    [loadLatestConversationMessages, setConvMessages]
  )
  const [input, setInput] = useState('')
  // A preset prompt handed in via openTarget.seedPrompt, held until the fresh-chat state has
  // settled, then auto-sent by the effect below sendMessage.
  const [pendingSeed, setPendingSeed] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Whether the active chat model can read images. Gate image attachment on this and
  // re-check periodically (the user can switch models from the Models screen).
  const [chatVision, setChatVision] = useState(true)
  const [attachWarn, setAttachWarn] = useState<string | null>(null)
  /**
   * Files a peer has announced for this chat whose bytes have not arrived.
   *
   * Held here and never in the message: the wait is true of THIS device only, and a message is synced,
   * so writing it onto the turn would tell peers that already hold the file to wait for it. The main
   * process sends the whole set on every change, so this replaces rather than merges.
   */
  const [incomingFiles, setIncomingFiles] = useState<IncomingSharedFile[]>([])
  useEffect(() => {
    if (!isPro) {
      setIncomingFiles([])
      return
    }
    const off = callHook<() => void>(
      SYNC_SUBSCRIBE_INCOMING_FILES_HOOK,
      (files: IncomingSharedFile[]) => setIncomingFiles(files)
    )
    return () => off?.()
  }, [isPro])
  // Matched on the message's UUID, which is what `id` carries here (`String(m.uuid ?? m.id)`) and is
  // the only identity a peer can name — the autoincrement row id is local to one device.
  const incomingFilesFor = useCallback(
    (messageUuid: string | undefined): IncomingSharedFile[] =>
      messageUuid ? incomingFiles.filter((file) => file.messageId === messageUuid) : [],
    [incomingFiles]
  )
  useEffect(() => {
    const check = (): void => {
      void (window.api as { chatVisionAvailable?: () => Promise<boolean> })
        .chatVisionAvailable?.()
        .then((v) => setChatVision(!!v))
        .catch(() => {})
    }
    check()
    const t = setInterval(check, 4000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (chatVision) setAttachWarn(null)
  }, [chatVision]) // cleared once a vision model is active
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])
  const [askSel, setAskSel] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [convSearch, setConvSearch] = useState('')
  // Conversation ids whose MESSAGE CONTENT matches the sidebar search (title is
  // matched client-side; content needs a debounced backend query).
  const [contentMatchIds, setContentMatchIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    const q = convSearch.trim()
    if (!q) {
      setContentMatchIds(new Set())
      return
    }
    let live = true
    const t = setTimeout(async () => {
      try {
        const ids = (await window.api.searchRagConversationIds?.(q)) as string[] | undefined
        if (live) setContentMatchIds(new Set(ids ?? []))
      } catch {
        /* keep title-only matches */
      }
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [convSearch])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  useEffect(() => {
    onActiveConversationChange?.(activeConversationId)
  }, [activeConversationId, onActiveConversationChange])
  // Active tab's messages (derived) + a shim so the existing active-conversation call
  // sites keep working. The send path targets its own conv via setConvMessages instead.
  const messages = messagesByConv[activeConversationId ?? NEW_CHAT] ?? EMPTY_MSGS
  const liveJourneyTask = guidanceTaskForJourney(taskSessions, activeConversationId)
  const promptEnhancementActive = messages.some(isPromptEnhancementMessage)
  const promptEnhancementComplete = messages.some(
    (message) =>
      message.role === 'assistant' &&
      isPromptEnhancementReasoningLabel(message.reasoningLabel) &&
      !!message.reasoning?.trim()
  )
  const setMessages = useCallback(
    (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])): void => {
      setConvMessages(activeConversationId, updater)
    },
    [activeConversationId, setConvMessages]
  )
  // Voice playback must never carry across chats — stop it whenever the active
  // conversation changes (and on unmount).
  useEffect(() => {
    stopAllVoicePlayback()
    return () => stopAllVoicePlayback()
  }, [activeConversationId])
  const [openTabs, setOpenTabs] = useState<string[]>([]) // conversation ids open as tabs
  const [showHistory, setShowHistory] = useState(true)
  const historyPanelRef = useRef<ImperativePanelHandle>(null)
  const galleryTriggerRef = useRef<HTMLButtonElement>(null)
  const [mode, setMode] = useState<ChatMode>('ask')
  const [showImageOptions, setShowImageOptions] = useState(false)
  const [imageAvailable, setImageAvailable] = useState(false)
  const [imgSize, setImgSize] = useState(512)
  const [imgSteps, setImgSteps] = useState(10)
  const [imgCfgScale, setImgCfgScale] = useState(2)
  const [imgSeed, setImgSeed] = useState('')
  const [imgNegative, setImgNegative] = useState('')
  // Rewrite the prompt with the local model before generating (default on). Reads
  // the SAME key the main-process image gate reads (enhanceImagePrompts).
  const [enhanceImg, setEnhanceImg] = useState(true)
  const [imgInit, setImgInit] = useState<string | null>(null)
  const [imgStrength, setImgStrength] = useState(0.6)
  const [imgModels, setImgModels] = useState<string[]>([])
  const [imgModel, setImgModel] = useState<string>('')
  // Per-model steps/size overrides. This is the ONE persisted owner of those two
  // params — the composer and (future) a Settings > Image section both read/write
  // it. Persisted via saveSetting('imageParams', …). A value here means the user
  // pinned it; absence means "track the model default". Resolved through the pure
  // resolveImageParams so a model change never clobbers a user override.
  const [imgParamStore, setImgParamStore] = useState<ImageParamStore>({})
  const [activeStyle, setActiveStyle] = useState<string | null>(null)
  const [styleThumbs, setStyleThumbs] = useState<Record<string, string>>({})
  const [imgProgress, setImgProgress] = useState<ImageProgress | null>(null)
  const [imageJobStage, setImageJobStage] = useState<ImageGenerationJobContract['stage']>(null)
  const [streamingEnhancedPrompt, setStreamingEnhancedPrompt] = useState('')
  // Which conversation currently owns the in-flight image generation (null = none).
  // Per-conversation so the image progress/warm-up UI shows ONLY in the conversation
  // that started it — a global bool bled the spinner + a Stop that cancels it into
  // whatever tab you switched to while an image was forming (D9).
  const [imageGenConv, setImageGenConv] = useState<string | null>(null)
  // The image progress/warm-up UI shows only when the ACTIVE conversation is the one
  // generating an image — never a background conversation's gen (D9).
  const generatingImage = imageGenConv !== null && imageGenConv === activeConversationId
  const [projects, setProjects] = useState<ProjectLite[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  // Captured-memory context is a Pro ("remembers") feature; core chats are plain
  // (no memory) or scoped to a project. The UI never says "memory".
  const [noMemory, setNoMemory] = useState(!isPro)
  const [, setProjectMenuOpen] = useState(false)
  const [projCreating, setProjCreating] = useState(false)
  const [projNewName, setProjNewName] = useState('')
  const projInputRef = useRef<HTMLInputElement>(null)
  // Focus the new-project input AFTER the dropdown returns focus to its trigger,
  // otherwise Radix's focus-return blurs the input immediately and onBlur tears it
  // down before the user can type. A short delay lands focus after that hand-off.
  useEffect(() => {
    if (!projCreating) return
    const t = setTimeout(() => projInputRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [projCreating])
  const [toolsOn, setToolsOn] = useState(false)
  const [connectorsOn, setConnectorsOn] = useState(false)
  const [thinkingEnabled, setThinkingEnabled] = useState(false)
  const [voiceMode, setVoiceMode] = useState(DEFAULT_VOICE_PREFERENCES.voiceMode)
  const [voiceTurnMode, setVoiceTurnMode] = useState<VoiceTurnMode>(
    DEFAULT_VOICE_PREFERENCES.turnMode
  )
  const [voiceSilenceAfterSpeechMs, setVoiceSilenceAfterSpeechMs] = useState(
    DEFAULT_VOICE_PREFERENCES.silenceAfterSpeechMs
  )
  const [voiceSpeakerDrainMs, setVoiceSpeakerDrainMs] = useState(
    DEFAULT_VOICE_PREFERENCES.speakerDrainMs
  )
  const [ttsEnabled, setTtsEnabled] = useState(DEFAULT_VOICE_PREFERENCES.ttsEnabled)
  const [ttsSpeed, setTtsSpeed] = useState(DEFAULT_VOICE_PREFERENCES.speed)
  const [voicePlaybackOwner, setVoicePlaybackOwner] = useState<string | null>(null)
  useEffect(() => {
    if (!voiceMode) {
      stopAllVoicePlayback()
      setVoicePlaybackOwner(null)
    }
  }, [voiceMode])

  // Composer preferences persist across sessions (memory scope, thinking, tools,
  // voice mode). Individual tool toggles and model choices persist on their own
  // (DB `disabledTools`, active-model.json). Load once, then save on every change.
  const prefsLoaded = useRef(false)
  useEffect(() => {
    ;(async () => {
      try {
        const s = await window.api.getSettings()
        if (typeof s.composerNoMemory === 'boolean') setNoMemory(s.composerNoMemory)
        if (typeof s.composerToolsOn === 'boolean') setToolsOn(s.composerToolsOn)
        if (typeof s.composerConnectorsOn === 'boolean') setConnectorsOn(s.composerConnectorsOn)
        if (typeof s.composerThinking === 'boolean') setThinkingEnabled(s.composerThinking)
        const voicePreferences = readVoicePreferences(s)
        setVoiceMode(voicePreferences.voiceMode)
        setVoiceTurnMode(voicePreferences.turnMode)
        setVoiceSilenceAfterSpeechMs(voicePreferences.silenceAfterSpeechMs)
        setVoiceSpeakerDrainMs(voicePreferences.speakerDrainMs)
        setTtsEnabled(voicePreferences.ttsEnabled)
        setTtsSpeed(voicePreferences.speed)
        // Image-composer params: per-model steps/size overrides + the global
        // seed/negative/strength/style. These are persisted so they survive a
        // remount (they used to reset every mount).
        if (s.imageParams && typeof s.imageParams === 'object')
          setImgParamStore(s.imageParams as ImageParamStore)
        if (typeof s.imgSeed === 'string') setImgSeed(s.imgSeed)
        if (typeof s.imgNegative === 'string') setImgNegative(s.imgNegative)
        if (typeof s.enhanceImagePrompts === 'boolean') setEnhanceImg(s.enhanceImagePrompts)
        if (typeof s.imgStrength === 'number') setImgStrength(s.imgStrength)
        if (typeof s.imgStyle === 'string' || s.imgStyle === null)
          setActiveStyle((s.imgStyle as string | null) ?? null)
      } catch (e) {
        console.error('Failed to load composer prefs', e)
      } finally {
        prefsLoaded.current = true
      }
    })()
  }, [])
  useEffect(() => {
    if (prefsLoaded.current) void window.api.saveSetting('composerNoMemory', noMemory)
  }, [noMemory])
  useEffect(() => {
    if (prefsLoaded.current) void window.api.saveSetting('composerToolsOn', toolsOn)
  }, [toolsOn])
  useEffect(() => {
    if (prefsLoaded.current) void window.api.saveSetting('composerConnectorsOn', connectorsOn)
  }, [connectorsOn])
  useEffect(() => {
    if (prefsLoaded.current) void window.api.saveSetting('composerThinking', thinkingEnabled)
  }, [thinkingEnabled])
  useEffect(() => {
    if (prefsLoaded.current) void window.api.saveSetting('composerVoiceMode', voiceMode)
  }, [voiceMode])
  useEffect(() => {
    const applyPreferences = (event: Event): void => {
      const next = (event as CustomEvent<VoicePreferences>).detail
      setVoiceMode(next.voiceMode)
      setVoiceTurnMode(next.turnMode)
      setVoiceSilenceAfterSpeechMs(next.silenceAfterSpeechMs)
      setVoiceSpeakerDrainMs(next.speakerDrainMs)
      setTtsEnabled(next.ttsEnabled)
      setTtsSpeed(next.speed)
    }
    window.addEventListener(VOICE_PREFERENCES_CHANGED_EVENT, applyPreferences)
    return () => window.removeEventListener(VOICE_PREFERENCES_CHANGED_EVENT, applyPreferences)
  }, [])
  // Persist the global image-composer params (per-model steps/size live in the
  // store, saved on change). Guarded by prefsLoaded so the initial load doesn't
  // echo back an empty default.
  useEffect(() => {
    if (prefsLoaded.current) void window.api.saveSetting('imgSeed', imgSeed)
  }, [imgSeed])
  useEffect(() => {
    if (prefsLoaded.current) void window.api.saveSetting('imgNegative', imgNegative)
  }, [imgNegative])
  useEffect(() => {
    if (prefsLoaded.current) void window.api.saveSetting('enhanceImagePrompts', enhanceImg)
  }, [enhanceImg])
  useEffect(() => {
    if (prefsLoaded.current) void window.api.saveSetting('imgStrength', imgStrength)
  }, [imgStrength])
  useEffect(() => {
    if (prefsLoaded.current) void window.api.saveSetting('imgStyle', activeStyle)
  }, [activeStyle])
  const [autoPlayId, setAutoPlayId] = useState<string | null>(null) // assistant reply to auto-speak once
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [speakLoadingId, setSpeakLoadingId] = useState<string | null>(null)
  const [speakError, setSpeakError] = useState<{ id: string; message: string } | null>(null)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<'model' | 'voice'>('model')
  // Active text model + running context window, shown in the composer. Refreshes when
  // the model picker closes (the selection may have changed).
  const modelSummary = useActiveModelSummary(modelPickerOpen)
  const [canvasWidth, setCanvasWidth] = useState<number | null>(null) // px; null = default 30vw
  const [dragOver, setDragOver] = useState(false)
  // Safety net so the "Drop files to attach" overlay never gets stuck: a drag that
  // ends/cancels outside the composer (drop elsewhere, leave the window, Esc)
  // doesn't fire the composer's own dragleave, so clear it from the window level.
  useEffect(() => {
    const clear = (): void => setDragOver(false)
    const onWinLeave = (e: DragEvent): void => {
      if (!e.relatedTarget) clear()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clear()
    }
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    window.addEventListener('dragleave', onWinLeave)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('dragleave', onWinLeave)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  const [viewer, setViewer] = useState<{
    title: string
    text: string
    path?: string
    kind?: string
    renderer?: 'image' | 'document' | 'audio' | 'video' | 'text'
  } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [lightbox, setLightbox] = useState<{ url: string; path?: string } | null>(null)
  // Pro registers this slot after the core renderer starts. Resolve it on each render so an
  // execution-chat approval cannot stay hidden behind a value cached before Pro activation.
  const ChatMessagesFooter = isPro ? getSlot(SLOTS.chatMessagesFooter) : undefined
  // Esc closes the open overlay (attachment viewer / image lightbox).
  useEffect(() => {
    if (!viewer && !lightbox) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setViewer(null)
        setLightbox(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer, lightbox])
  const [canvasArtifact, setCanvasArtifact] = useState<Artifact | null>(null)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [selectedSkillName, setSelectedSkillName] = useState<string | undefined>()
  const [showGallery, setShowGallery] = useState(false)
  // The canvas / text viewer / gallery belong to a specific message, so they must
  // not bleed across chats — close them whenever the active conversation changes
  // (switch tab, new chat, close-to-fallback, open-from-projects, delete).
  useEffect(() => {
    setCanvasArtifact(null)
    setViewer(null)
    setShowGallery(false)
  }, [activeConversationId])
  const [gallery, setGallery] = useState<{ path: string; name: string; mtime: number }[]>([])
  const [galleryTab, setGalleryTab] = useState<'images' | 'artifacts'>('images')
  const [galleryScope, setGalleryScope] = useState<'chat' | 'project' | 'all'>('all')
  const [artifacts, setArtifacts] = useState<
    (Artifact & { id: string; title: string; created: number })[]
  >([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const voiceMountedRef = useRef(true)
  const speechRequestRef = useRef(0)
  const pendingVariantsRef = useRef<string[] | null>(null) // prior answers to keep when regenerating
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Whether streamed output should keep scrolling to the bottom. Set from the container's onScroll
  // so it tracks the USER'S intent: pinned-to-bottom = follow; scrolled up = leave them be.
  const followBottomRef = useRef(true)
  const onScrollFollow = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    followBottomRef.current = shouldFollowBottom(e.currentTarget)
  }, [])
  // Per-conversation generation lock + queue: a send belongs to its OWN conversation,
  // never the active tab. generatingRef is the synchronous source of truth for the
  // queue decision; generatingConvs mirrors it for rendering.
  const generatingRef = useRef<Set<string>>(new Set())
  const [generatingConvs, setGeneratingConvs] = useState<Set<string>>(new Set())
  const markGenerating = useCallback((cid: string, on: boolean): void => {
    if (on) generatingRef.current.add(cid)
    else generatingRef.current.delete(cid)
    setGeneratingConvs(new Set(generatingRef.current))
  }, [])
  // Queued sends carry their attachments too, so a message waiting behind an in-flight
  // generation keeps its image/files when it finally runs — keyed per conversation.
  const queuedRef = useRef<Record<string, { text: string; atts: Attachment[] }[]>>({})
  const [queuedByConv, setQueuedByConv] = useState<
    Record<string, { text: string; atts: Attachment[] }[]>
  >({})
  // Map streamId → convId so the onRagStream handler can route tokens to the right
  // conversation regardless of which tab is active when the event fires.
  const streamConvRef = useRef<Map<string, string>>(new Map())
  // Accumulated reasoning per streamId, mirrored from the onRagStream reasoning
  // events. Read DETERMINISTICALLY at persist time — reading it out of a
  // setConvMessages updater (a state-updater side effect) was unreliable: React
  // only runs the updater eagerly on a bail-out, else defers it to render, so the
  // read could see undefined and the persisted 'Thinking' block would vanish on
  // reload (the exact T1f bug). A ref is written synchronously and read directly.
  const reasoningByStream = useRef<Record<string, string>>({})
  /** What the model has actually said so far, per stream — see the stream handler for why. */
  const answerByStream = useRef<Record<string, string>>({})
  // Conversations the user hit "stop" on. The in-flight send checks this at each of
  // its awaits and bails (no error bubble, no persisted junk) instead of finalizing a
  // turn the user abandoned. Cleared when the conversation's send settles.
  const cancelledRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    voiceMountedRef.current = true
    return () => {
      voiceMountedRef.current = false
      speechRequestRef.current++
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  // Bind the composer's image model to the ONE owner of that state: the active
  // modal model (what the Active-models panel / ModelPicker writes via
  // setActiveModalModel). We READ it from imageGenStatus().active and mirror it
  // locally for the dropdown; we never hold a divergent latched copy. Called on
  // mount and whenever the model picker closes, so a change made there flows back
  // into the composer. Falls back to a sensible default only when nothing is active.
  const refreshImageModel = useCallback(async () => {
    try {
      const s = await window.api.imageGenStatus?.()
      if (!s) return
      setImageAvailable(!!s.available)
      const rawModels: unknown = s.models
      const models: string[] = Array.isArray(rawModels)
        ? rawModels.filter((model: unknown): model is string => typeof model === 'string')
        : []
      setImgModels(models)
      // Skip the parked/slow Core ML dir (it would otherwise win on an "sdxl" name
      // match and default the composer to a non-distilled model).
      const usable = models.filter((m) => !/coreml/i.test(m))
      const preferred =
        usable.find((m) => /dreamshaper/i.test(m)) ||
        usable.find((m) => /lightning|turbo/i.test(m)) ||
        usable.find((m) => /z[-_]?image/i.test(m)) ||
        usable.find((m) => /sdxl|xl/i.test(m)) ||
        usable[0] ||
        models[0] ||
        ''
      setImgModel(s.active || preferred)
    } catch {
      /* engine may be down; leave prior state */
    }
  }, [])
  useEffect(() => {
    const refreshImageSettings = (): void => {
      void Promise.all([window.api.getSettings(), refreshImageModel()]).then(([settings]) => {
        if (settings.imageParams && typeof settings.imageParams === 'object')
          setImgParamStore(settings.imageParams as ImageParamStore)
        if (typeof settings.imgSeed === 'string') setImgSeed(settings.imgSeed)
        if (typeof settings.imgNegative === 'string') setImgNegative(settings.imgNegative)
        if (typeof settings.enhanceImagePrompts === 'boolean')
          setEnhanceImg(settings.enhanceImagePrompts)
      })
    }
    window.addEventListener(IMAGE_SETTINGS_CHANGED_EVENT, refreshImageSettings)
    return () => window.removeEventListener(IMAGE_SETTINGS_CHANGED_EVENT, refreshImageSettings)
  }, [refreshImageModel])
  // When the model picker closes it may have changed the active image model
  // (setActiveModalModel). Re-read so the composer reflects the single source of
  // truth rather than a stale mirror.
  const prevPickerOpen = useRef(modelPickerOpen)
  useEffect(() => {
    if (prevPickerOpen.current && !modelPickerOpen) void refreshImageModel()
    prevPickerOpen.current = modelPickerOpen
  }, [modelPickerOpen, refreshImageModel])

  // Load conversations on mount; probe image gen; load projects for scoping.
  useEffect(() => {
    void (async () => {
      const convos = await window.api.getRagConversations().catch(() => [])
      setConversations(convos)
      // Open the latest conversation by default (most recent first), unless the shell
      // asked to open a specific chat/project — then its own effect handles it.
      if (!openTarget && convos.length > 0) {
        const first = convos[0]! // convos.length > 0
        setActiveConversationId(first.id)
        setActiveProjectId((first as { project_id?: string | null }).project_id ?? null)
        setOpenTabs([first.id])
        try {
          const nextMessages = await loadLatestConversationMessages(first.id)
          if (nextMessages) setConvMessages(first.id, nextMessages)
        } catch {
          setConvMessages(first.id, [])
        }
      }
    })()
    void refreshImageModel()
    window.api
      .listProjects?.()
      .then((p: ProjectLite[]) => setProjects(p))
      .catch(() => {})
    window.api
      .styleThumbs?.()
      .then((t: Record<string, string>) => setStyleThumbs(t))
      .catch(() => {})
  }, [])

  // Resolve the size + steps controls for the current model: a per-model user
  // OVERRIDE (persisted in imgParamStore) wins; otherwise fall back to the model's
  // default from the SINGLE shared source of truth the main process also uses (so
  // the two layers can't drift — a stale copy once defaulted turbo models to 4
  // steps -> rainbow artifacts). This never clobbers a value the user typed: the
  // resolver reads the override for whichever model is now selected. Depends on the
  // store too, so persisted overrides apply once they load.
  useEffect(() => {
    if (!imgModel) return
    const { steps, size, cfgScale } = resolveImageParams(imgModel, imgParamStore)
    setImgSize(size)
    setImgSteps(steps)
    setImgCfgScale(cfgScale)
  }, [imgModel, imgParamStore])

  // Composer image-model dropdown: write through to the SAME owner ModelPicker
  // uses (setActiveModalModel), then mirror locally for immediate UI. This is what
  // keeps the composer and the Active-models panel from silently disagreeing about
  // which model runs — one source of truth.
  const chooseImageModel = useCallback((value: string) => {
    setImgModel(value)
    // Write through to the owning source; log on failure rather than swallow — a
    // silent reject would let the composer and Active-models panel diverge again
    // (the exact drift this binding prevents), with no signal.
    void window.api
      .setActiveModalModel?.('image', value)
      .catch((e) => console.error('[image] failed to persist active model', e))
  }, [])
  // Steps/size edits persist as a per-model override so they survive a remount and
  // a model switch (setOverride is pure; a value == the model default clears it).
  const setStepsOverride = useCallback(
    (value: number) => {
      setImgSteps(value)
      if (!imgModel) return
      setImgParamStore((prev) => setOverride(prev, imgModel, 'steps', value))
    },
    [imgModel]
  )
  const setSizeOverride = useCallback(
    (value: number) => {
      setImgSize(value)
      if (!imgModel) return
      setImgParamStore((prev) => setOverride(prev, imgModel, 'size', value))
    },
    [imgModel]
  )
  const setCfgScaleOverride = useCallback(
    (value: number) => {
      setImgCfgScale(value)
      if (!imgModel) return
      setImgParamStore((prev) => setOverride(prev, imgModel, 'cfgScale', value))
    },
    [imgModel]
  )
  // Persist the per-model image params in ONE effect (not inside the state updater —
  // an updater must be pure; StrictMode double-invokes it, firing the IPC save twice).
  // Gated on prefsLoaded so the initial hydrate doesn't write back.
  useEffect(() => {
    if (prefsLoaded.current) void window.api.saveSetting('imageParams', imgParamStore)
  }, [imgParamStore])

  const activeProjectName = projects.find((p) => p.id === activeProjectId)?.name ?? null

  const loadProjects = useCallback(async () => {
    try {
      setProjects((await window.api.listProjects?.()) || [])
    } catch (e) {
      console.error(e)
    }
  }, [])

  // Assign the current chat to a project (or clear it). Persists if a conversation exists.
  const assignProject = useCallback(
    async (projectId: string | null) => {
      setActiveProjectId(projectId)
      setProjectMenuOpen(false)
      setProjCreating(false)
      setProjNewName('')
      if (activeConversationId) {
        try {
          await window.api.setRagConversationProject(activeConversationId, projectId)
        } catch (e) {
          console.error(e)
        }
        await loadConversations()
      }
    },
    [activeConversationId]
  )

  // Create a project inline and assign the current chat to it.
  const createAndAssignProject = useCallback(async () => {
    const name = projNewName.trim()
    if (!name) {
      setProjCreating(false)
      return
    }
    try {
      const id = await window.api.createProject?.({ name })
      await loadProjects()
      if (id) await assignProject(id)
    } catch (e) {
      console.error('Failed to create project', e)
    }
  }, [projNewName, loadProjects, assignProject])

  useEffect(() => {
    // Follow the stream to the bottom ONLY while the user hasn't scrolled up. followBottomRef is
    // driven by the container's onScroll (below), so it reflects the user's intent — not a
    // mid-animation position. Instant (not smooth): a smooth animation kept scrollTop near the
    // bottom between tokens, so the next token re-measured as "near bottom" and re-scrolled — a
    // feedback loop that made it impossible to scroll up during generation.
    if (followBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [messages, loading])

  // Opening / switching a chat lands you at the latest message (after it loads).
  const justSwitched = useRef(false)
  useEffect(() => {
    justSwitched.current = true
    // A fresh conversation opens pinned to the bottom: reset the follow flag so a scroll-up in the
    // PREVIOUS chat doesn't leave the new one refusing to auto-scroll its stream.
    followBottomRef.current = true
  }, [activeConversationId])
  useEffect(() => {
    if (!justSwitched.current || !messages.length) return
    justSwitched.current = false
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }))
  }, [messages, activeConversationId])

  // Image jobs survive this component. Subscribe before reading the snapshot so a
  // navigation/remount cannot miss the transition between status and observation.
  // Cleanup only detaches observers; explicit Stop is the sole cancellation path.
  useEffect(() => {
    let live = true
    const observe = (job: ImageGenerationJobContract): void => {
      if (!live || !job.conversationId) return
      if (job.phase === 'running') {
        setImageGenConv(job.conversationId)
        setImageJobStage(job.stage)
        setStreamingEnhancedPrompt(job.enhancedPrompt)
        setImgProgress(job.progress)
        // Restore the SAME render gate the live-gen path sets (markGenerating). Without this a
        // remount mid-generation left imageGenConv set but generatingConvs empty, so the progress
        // panel (gated on generatingConvs) stayed invisible — the "it generated but the UI didn't
        // show it" bug. Reattaching must reflect the whole in-flight UI, not just the owner.
        markGenerating(job.conversationId, true)
        return
      }
      setImageGenConv((owner) => (owner === job.conversationId ? null : owner))
      setImageJobStage(null)
      setStreamingEnhancedPrompt('')
      setImgProgress(null)
      markGenerating(job.conversationId, false)
    }
    const offJob = window.api.onImageGenJobState?.(observe)
    const offConversation = window.api.onImageGenConversationUpdated?.((conversationId) => {
      void refreshConversationMessages(conversationId).catch((error) =>
        console.error('Failed to refresh generated image message', error)
      )
    })
    void window.api
      .imageGenJobStatus?.()
      .then(observe)
      .catch((error) => console.error('Failed to reattach image generation', error))
    return () => {
      live = false
      offJob?.()
      offConversation?.()
    }
  }, [refreshConversationMessages, markGenerating])

  const conversationListRequestRef = useRef<Promise<void> | null>(null)
  const conversationListRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadConversations = useCallback(async (): Promise<void> => {
    if (conversationListRequestRef.current) return conversationListRequestRef.current
    const request = (async () => {
      try {
        const convos = await window.api.getRagConversations()
        setConversations(convos)
      } catch (e) {
        console.error('Failed to load conversations:', e)
      } finally {
        conversationListRequestRef.current = null
      }
    })()
    conversationListRequestRef.current = request
    return request
  }, [])

  const scheduleConversationListRefresh = useCallback((): void => {
    if (conversationListRefreshTimerRef.current) {
      clearTimeout(conversationListRefreshTimerRef.current)
    }
    conversationListRefreshTimerRef.current = setTimeout(() => {
      conversationListRefreshTimerRef.current = null
      void loadConversations()
    }, 250)
  }, [loadConversations])

  useEffect(
    () => () => {
      if (conversationListRefreshTimerRef.current) {
        clearTimeout(conversationListRefreshTimerRef.current)
      }
    },
    []
  )

  const switchConversation = useCallback(
    async (convId: string) => {
      setOpenTabs((t) => (t.includes(convId) ? t : [...t, convId]))
      if (convId === activeConversationId) return
      setActiveConversationId(convId)
      setActiveProjectId(conversations.find((c) => c.id === convId)?.project_id ?? null)
      try {
        const nextMessages = await loadLatestConversationMessages(convId)
        if (!nextMessages) return
        // Refresh from DB, but never clobber an in-flight stream for this conversation.
        setMessagesByConv((prev) =>
          prev[convId]?.some((m) => m.streaming) ? prev : { ...prev, [convId]: nextMessages }
        )
      } catch (e) {
        console.error('Failed to load messages:', e)
        setMessagesByConv((prev) => (prev[convId] ? prev : { ...prev, [convId]: [] }))
      }
    },
    [activeConversationId, conversations, loadLatestConversationMessages]
  )

  // Close a chat tab; fall back to another open tab (or a fresh chat) if it was active.
  const closeTab = useCallback(
    (convId: string) => {
      setOpenTabs((prev) => {
        const next = prev.filter((t) => t !== convId)
        if (activeConversationId === convId) {
          const fallback = next[next.length - 1]
          if (fallback) void switchConversation(fallback)
          else {
            setActiveConversationId(null)
            setConvMessages(null, [])
            setActiveProjectId(null)
          }
        }
        return next
      })
    },
    [activeConversationId, switchConversation]
  )

  // A conversation changed underneath us - most often a message synced from another device. Reload
  // that thread when it is the one on screen, and refresh the list either way so ordering follows.
  //
  // Skipped while THIS device is generating in that conversation: the in-flight reply lives in local
  // state and re-reading the table mid-stream would drop it.
  useEffect(() => {
    const off = window.api.onRagConversationsChanged?.(({ conversationId }) => {
      void (async () => {
        try {
          if (
            conversationId &&
            conversationId === activeConversationId &&
            !generatingRef.current.has(conversationId)
          ) {
            await refreshConversationMessages(conversationId)
          }
          scheduleConversationListRefresh()
        } catch (error) {
          console.error('Failed to refresh a synced conversation:', error)
        }
      })()
    })
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, refreshConversationMessages, scheduleConversationListRefresh])

  // Task guidance is written to the originating conversation by the Tasks
  // workspace. Refresh that conversation immediately so its special guidance
  // turn appears beside the task without waiting for a sync round trip.
  useEffect(() => {
    const onTaskGuidanceMessage = (event: Event): void => {
      const conversationId = (event as CustomEvent<{ conversationId?: string }>).detail
        ?.conversationId
      if (!conversationId) return
      void (async () => {
        if (conversationId === activeConversationId) {
          await refreshConversationMessages(conversationId)
        }
        scheduleConversationListRefresh()
      })()
    }
    window.addEventListener('og:task-guidance-message', onTaskGuidanceMessage)
    return () => window.removeEventListener('og:task-guidance-message', onTaskGuidanceMessage)
  }, [activeConversationId, refreshConversationMessages, scheduleConversationListRefresh])

  // Open a target passed from the Projects tab (an existing chat, or a new chat
  // scoped to a project). Resolves project from the DB to avoid stale state.
  useEffect(() => {
    if (!openTarget) return
    ;(async () => {
      try {
        if (openTarget.conversationId) {
          const convId = openTarget.conversationId
          setActiveConversationId(convId)
          setOpenTabs((t) => (t.includes(convId) ? t : [...t, convId]))
          const conv = await window.api.getRagConversation(convId)
          setActiveProjectId((conv as { project_id?: string | null }).project_id ?? null)
          const nextMessages = await loadLatestConversationMessages(convId)
          if (nextMessages) setConvMessages(convId, nextMessages)
          if (openTarget.draftPrompt) setInput(openTarget.draftPrompt)
        } else if (openTarget.projectId) {
          setActiveConversationId(null)
          setConvMessages(null, [])
          setActiveProjectId(openTarget.projectId)
        } else if (openTarget.seedPrompt) {
          // Open a fresh chat, then let the effect below sendMessage fire the preset once the
          // reset state has settled - so the prompt lands in the new empty conversation.
          setActiveConversationId(null)
          setConvMessages(null, [])
          setActiveProjectId(null)
          setPendingSeed(openTarget.seedPrompt)
        } else if (openTarget.draftPrompt) {
          setActiveConversationId(null)
          setConvMessages(null, [])
          setActiveProjectId(null)
          setInput(openTarget.draftPrompt)
        }
        if (openTarget.openGallery) setShowGallery(true)
        if (openTarget.draftPrompt) requestAnimationFrame(() => inputRef.current?.focus())
        await loadConversations()
      } catch (e) {
        console.error('Failed to open chat target:', e)
      } finally {
        onTargetConsumed?.()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTarget])

  const startNewConversation = useCallback(() => {
    setActiveConversationId(null)
    setConvMessages(null, []) // clear the fresh-chat bucket
    setActiveProjectId(null)
  }, [setConvMessages])

  const deleteConversation = useCallback(
    async (convId: string) => {
      try {
        await window.api.deleteRagConversation(convId)
        // Drop the deleted conversation's cached messages; reset to a fresh chat if active.
        setMessagesByConv((prev) => {
          const n = { ...prev }
          delete n[convId]
          n[NEW_CHAT] = []
          return n
        })
        setOpenTabs((t) => t.filter((id) => id !== convId))
        if (activeConversationId === convId) setActiveConversationId(null)
        await loadConversations()
      } catch (err) {
        console.error('Failed to delete conversation:', err)
      }
    },
    [activeConversationId]
  )

  const conversationRenamed = useCallback((stored: RagConversationContract): void => {
    setConversations((current) =>
      current.map((conversation) => (conversation.id === stored.id ? stored : conversation))
    )
  }, [])

  const sendMessage = async (
    override?: string,
    opts?: {
      regen?: boolean
      voiceClip?: { url: string; duration: number }
      atts?: Attachment[]
      conversationId?: string
      imageRequest?: ImageGenerationRequestContract
      projectIdOverride?: string | null
    }
  ) => {
    const isInput = override === undefined
    // Regenerate/Resend: the user turn already exists in the thread — re-run it
    // in place instead of echoing another user bubble.
    const regen = opts?.regen ?? false
    // Lock the project for THIS send at send-time, like convId — every attribution
    // below (RAG scope, saved artifacts, generated images) uses it. Reading the live
    // `activeProjectId` at each await instead let a mid-stream project switch land
    // this turn's output in the WRONG project (D21).
    const projectId =
      opts?.projectIdOverride !== undefined ? opts.projectIdOverride : activeProjectId
    // Attachments (pasted blocks + processed files) ride along on a normal send
    // from the composer, or on a drained queue item (opts.atts) — not on
    // resend/regenerate/example.
    const atts =
      opts?.atts ??
      (isInput ? attachments.filter((a) => a.status === 'ready' && (a.text || a.path)) : [])
    const typed = (override ?? input).trim()
    // The user sees `trimmed`; the model also gets the attachment text folded in.
    const trimmed =
      typed || (atts.length ? `(${atts.length} attachment${atts.length > 1 ? 's' : ''})` : '')
    const attBlock = atts
      .filter((a) => a.text)
      .map((a) => `--- attached ${a.kind}: ${a.name} ---\n${a.text}`)
      .join('\n\n')
    // Actual image files go to the multimodal model (not just their captions).
    const imagePaths = atts.filter((a) => a.kind === 'image' && a.path).map((a) => a.path as string)
    let modelQuery = (attBlock ? `${attBlock}\n\n${typed}` : typed).trim()
    if (!typed && atts.length === 0) return
    // Don't block the user — if a generation is in flight, queue this message and
    // let them keep typing/sending. The queue drains in order when each finishes.
    const targetConv = opts?.conversationId ?? activeConversationId
    // A live operator task owns this journey until it finishes. New Chat input is
    // guidance for that task, not a second memory/model turn running beside it.
    if (!regen && targetConv && !opts?.imageRequest) {
      const listedTasks = await window.api.tasks?.list?.(50)
      const liveTask = guidanceTaskForJourney(listedTasks ?? taskSessions, targetConv)
      if (liveTask) {
        const guidanceText = [
          typed,
          ...atts
            .filter((attachment) => attachment.text)
            .map((attachment) => `Attached ${attachment.name}:\n${attachment.text}`)
        ]
          .filter(Boolean)
          .join('\n\n')
        try {
          const result = await submitTaskGuidance({
            taskId: liveTask.taskId,
            journeyId: targetConv,
            text: guidanceText
          })
          if (!result.accepted) {
            setAttachWarn(result.reason || 'The running task did not accept this guidance.')
            return
          }
          if (isInput) {
            setInput('')
            setAttachments([])
          }
          setAttachWarn(null)
          return
        } catch (error) {
          console.error('Failed to guide the running task:', error)
          setAttachWarn('Guidance could not be sent to the running task. Try again.')
          return
        }
      }
    }
    if (shouldQueue(targetConv, generatingRef.current)) {
      const item = { text: typed, atts }
      queuedRef.current = enqueue(queuedRef.current, targetConv as string, item)
      setQueuedByConv({ ...queuedRef.current })
      if (isInput) {
        setInput('')
        setAttachments([])
      }
      return
    }
    if (isInput) setAttachments([])

    // Skill invocation: "/skill-name [rest]" prepends that skill's instructions.
    if (isInput) {
      const sm = /^\/([A-Za-z0-9_-]+)\s*([\s\S]*)$/.exec(typed)
      if (sm && skills.some((s) => s.name.toLowerCase() === sm[1]!.toLowerCase())) {
        try {
          const sk = await window.api.getSkill(sm[1]!)
          if (sk) {
            const rest = sm[2]!.trim()
            modelQuery =
              `${attBlock ? attBlock + '\n\n' : ''}# Skill: ${sk.name}\n${sk.instructions}\n\n${rest}`.trim()
          }
        } catch (e) {
          console.error('skill load failed', e)
        }
      }
    }

    // A drained queue item carries its own conversationId; a normal send uses the
    // active tab. Either way, this send is bound to `convId` end-to-end.
    let convId = opts?.conversationId ?? activeConversationId

    // Create new conversation if none active
    if (!convId) {
      convId = crypto.randomUUID()
      const title = trimmed.length > 50 ? trimmed.slice(0, 47) + '...' : trimmed
      try {
        await window.api.createRagConversation(convId, title, projectId)
        setActiveConversationId(convId)
        setOpenTabs((t) => (t.includes(convId!) ? t : [...t, convId!]))
      } catch (e) {
        console.error('Failed to create conversation:', e)
        return
      }
    }

    // From here this send belongs to `convId` — lock + target THAT conversation, so
    // switching tabs mid-generation never misroutes it. Clear any stale stop flag so a
    // conversation the user previously stopped can generate again.
    cancelledRef.current.delete(convId)
    markGenerating(convId, true)
    // The image this turn is BASED on is an attachment on this turn, and saying so is the whole fix:
    // it then travels, renders, and survives a reload by the same path every other attachment uses.
    // Kept in app storage first, because the user's own copy can move or be deleted the moment the
    // turn ends and its path means nothing on another device. The generation is pointed at the kept
    // copy too, so there is one file and not two.
    let keptInit: { id: string; path: string } | null = null
    if (imgInit) {
      try {
        keptInit = await window.api.keepInitImage(imgInit)
      } catch (e) {
        // Not worth failing the turn over: the image still generates, it just has no before-picture.
        console.error('Could not keep the init image', e)
      }
    }
    const initAttachment = keptInit
      ? {
          id: keptInit.id,
          name: keptInit.path.split('/').pop() || 'init image',
          kind: 'image' as const,
          path: keptInit.path
        }
      : undefined

    if (!regen) {
      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: trimmed,
        attachments: [
          ...atts.map((a) => ({ name: a.name, kind: a.kind, text: a.text, path: a.path })),
          // Drawn now, not only after a reload. Persisting it without this left the turn looking as
          // though nothing had been attached until the conversation was loaded again.
          ...(initAttachment
            ? [{ name: initAttachment.name, kind: initAttachment.kind, path: initAttachment.path }]
            : [])
        ],
        audioUrl: opts?.voiceClip?.url,
        audioDuration: opts?.voiceClip?.duration
      }
      setConvMessages(convId, (prev) => [...prev, userMessage])
    }
    setInput('')
    setLoading(true)

    // Persist user message (skip on regen — it's already in the thread). Stash
    // the attachments in the message context so the clickable chips survive reload.
    try {
      if (!regen) {
        const attMeta = atts.map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          text: a.text,
          path: a.path,
          mimeType: a.mimeType,
          fileSize: a.fileSize,
          createdAt: a.createdAt
        }))
        // Appended, never folded into `atts`: those are what the MODEL is given, and the init image is
        // an input to the image runtime rather than text for the language model to read.
        const persisted = initAttachment ? [...attMeta, initAttachment] : attMeta
        await window.api.addRagMessage(
          convId,
          'user',
          trimmed,
          persisted.length ? { attachments: persisted } : undefined
        )
      }
    } catch (e) {
      console.error('Failed to persist user message:', e)
    }

    // Catalogue attached inputs (files / pasted text) as artifacts of this chat &
    // project, so the gallery holds the whole working set — inputs and outputs.
    if (!regen) {
      for (const a of atts) {
        if (a.kind === 'image' && a.path) {
          // Best-effort cataloguing: handle the async rejection with .catch (a try/catch
          // can't catch a floating promise's rejection — S4822).
          void window.api
            .saveArtifact({
              kind: 'image',
              code: a.path,
              title: a.name,
              conversationId: convId,
              projectId: projectId
            })
            .catch(() => {
              /* ignore */
            })
        } else if (a.text) {
          void window.api
            .saveArtifact({
              kind: 'text',
              code: a.text,
              title: a.name,
              conversationId: convId,
              projectId: projectId
            })
            .catch(() => {
              /* ignore */
            })
        }
      }
    }

    // Image-generation mode: render a prompt → image instead of a memory answer.
    // Also auto-route when the user clearly asks for an image in chat ("draw a
    // dog") so they get a picture instead of the text model refusing. The auto-
    // route is SUPPRESSED when the agentic tools/connectors path owns the turn:
    // there, image generation is a tool the model calls, so the renderer must not
    // pre-decide (that double decision hijacked "draw ..." away from the tool loop).
    // Agentic tools run everywhere the user turns them on — including project chats.
    // (Projects used to force the RAG-only path, which silently ignored Tools/Connectors
    // and left the model to hallucinate "searches" instead of calling web_search etc.)
    const agenticActive = isAgenticTurn({ toolsOn, connectorsOn })
    const autoImage = shouldAutoRouteImage({ mode, imageAvailable, agenticActive, text: trimmed })
    if (opts?.imageRequest || mode === 'image' || autoImage) {
      setImgProgress(null)
      setImageGenConv(convId)
      const seedNum = imgSeed.trim() === '' ? -1 : parseInt(imgSeed, 10)
      const styleObj = STYLE_PRESETS.find((s) => s.name === activeStyle)
      // In explicit image mode keep the exact prompt (+ any chosen style); on
      // auto-route strip the "draw/generate an image of" phrasing to the subject.
      const basePrompt = mode === 'image' ? trimmed : cleanImagePrompt(trimmed)
      const fullPrompt = styleObj ? `${basePrompt}, ${styleObj.prompt}` : basePrompt
      const imageRequest: ImageGenerationRequestContract = opts?.imageRequest ?? {
        prompt: fullPrompt,
        negativePrompt: imgNegative.trim() || undefined,
        width: imgSize,
        height: imgSize,
        steps: imgSteps,
        cfgScale: imgCfgScale,
        seed: Number.isNaN(seedNum) ? -1 : seedNum,
        model: imgModel || undefined,
        // The kept copy, so the record of what this was made from cannot outlive the file it names.
        initImage: keptInit?.path ?? imgInit ?? undefined,
        strength: imgInit ? imgStrength : undefined
      }
      try {
        const img = await window.api.generateImage({
          ...imageRequest,
          conversationId: convId, // the turn's own conversation (activeConversationId can lag for a fresh/queued chat)
          projectId: projectId
        })
        const imageMetadata: ImageGenerationMetadata = {
          width: imageRequest.width ?? imgSize,
          height: imageRequest.height ?? imgSize,
          steps: imageRequest.steps ?? imgSteps,
          cfgScale: imageRequest.cfgScale ?? imgCfgScale,
          seed:
            typeof img.seed === 'number'
              ? img.seed
              : (imageRequest.seed ?? (Number.isNaN(seedNum) ? -1 : seedNum)),
          model: typeof img.model === 'string' ? img.model : imageRequest.model
        }
        const completedImage = completedImageMessage(
          `Generated for: ${trimmed}`,
          imageRequest.prompt,
          img.prompt
        )
        const assistantMessage: ChatMessage = {
          id: `a-${Date.now()}`,
          role: 'assistant',
          ...completedImage,
          image: img.dataUrl,
          imagePath: img.path,
          imageMetadata
        }
        setConvMessages(convId, (prev) => [...prev, assistantMessage])
        try {
          const stored = await window.api.addRagMessage(
            convId,
            'assistant',
            completedImage.storedContent,
            withGeneratedImageReference({ imageMetadata }, { id: img.syncId, path: img.path })
          )
          await announceImageMessagePersisted(convId, stored.uuid)
        } catch {
          /* ignore */
        }
      } catch (e) {
        const memoryGuard = parseImageMemoryGuardError(e)
        const errorContent =
          memoryGuard?.message || (e as Error).message || 'Image generation failed.'
        // User-cancelled: just drop the loading state, no error bubble.
        if (!/cancel/i.test(errorContent)) {
          console.error('Image generation failed', e)
          setConvMessages(convId, (prev) => [
            ...prev,
            {
              id: `a-${Date.now()}`,
              role: 'assistant',
              content: errorContent,
              imageMemoryRetry: memoryGuard
                ? { request: imageRequest, prompt: trimmed, conversationId: convId, projectId }
                : undefined
            }
          ])
          try {
            await window.api.addRagMessage(convId, 'assistant', errorContent)
          } catch {
            /* ignore */
          }
        }
      } finally {
        markGenerating(convId, false)
        setLoading(false)
        setImgProgress(null)
        setImageGenConv((c) => (c === convId ? null : c))
        await loadConversations()
        drainQueue(convId)
      }
      return
    }

    let activeStreamId: string | undefined
    try {
      // History is built from the TARGET conversation's own messages (never the
      // active tab's `messages`) — a drained-queue or background send is bound to
      // `convId`, so its history must come from that conversation (D8).
      const history = buildSendHistory(messagesByConv[convId] ?? EMPTY_MSGS, !!regen, trimmed)

      // Agentic tools path (opt-in, non-project). The model calls built-in tools,
      // plus (when Connectors is on) MCP connector tools. STREAMS like the RAG path:
      // a streamId placeholder fills in live - thinking, then each tool-call activity
      // step, then the answer - and the stop button aborts it via rag:cancel.
      if (agenticActive) {
        if (cancelledRef.current.has(convId)) return
        const toolStreamId = `a-${Date.now()}`
        activeStreamId = toolStreamId
        streamConvRef.current.set(toolStreamId, convId!)
        setConvMessages(convId, (prev) => [
          ...prev,
          { id: toolStreamId, role: 'assistant', content: '', reasoning: '', streaming: true }
        ])
        const tr = await window.api.toolChat(modelQuery, history, {
          connectors: connectorsOn,
          conversationId: convId,
          // Memory scope drives which memory tools the model gets: a project offers its
          // knowledge base; "All memory" offers search_memory; "No memory" offers neither.
          projectId: projectId ?? undefined,
          allMemory: !projectId && !noMemory,
          images: imagePaths,
          imageAvailable,
          streamId: toolStreamId,
          thinking: thinkingEnabled
        })
        const toolCalls = (tr?.toolCalls || []).map(
          (c: { name: string; result: string; status?: 'completed' | 'failed' | 'pending' }) => ({
            name: c.name,
            result: c.result,
            status: c.status ?? ('completed' as const)
          })
        )
        const context = tr?.unified?.length ? { unified: tr.unified } : undefined
        // Persist the citation sources + tool calls so they survive a reload.
        const toolCtx =
          tr?.unified?.length || toolCalls.length
            ? { unified: tr?.unified ?? [], toolCalls }
            : undefined
        if (cancelledRef.current.has(convId)) {
          // The tool calls made before the stop are kept, exactly as a completed tool turn keeps
          // them: rendered from `toolCalls`, stored in `toolCtx` beside the citation sources.
          await finalizeStoppedTurn(convId, toolStreamId, {
            answer: tr?.answer,
            context,
            persistContext: toolCtx,
            toolCalls
          })
          return
        }
        const answer = tr?.answer || 'No response returned.'
        // Reasoning read from the ref (populated as it streamed) — deterministic,
        // unlike reading it out of the setConvMessages updater. Rides the persisted
        // context blob so the 'Thinking' block survives reload (T1f).
        const toolReasoning = reasoningByStream.current[toolStreamId]
        delete reasoningByStream.current[toolStreamId] // done with this stream — free it
        delete answerByStream.current[toolStreamId]
        // Finalize the streamed placeholder in place (never append a second bubble).
        setConvMessages(convId, (prev) =>
          prev.map((m) =>
            m.id === toolStreamId
              ? { ...m, content: answer, context, toolCalls, activity: undefined, streaming: false }
              : m
          )
        )
        const toolCtxWithReasoning = buildAssistantContext(toolCtx, { reasoning: toolReasoning })
        // Deferred image generation: the tool loop only RECORDS prompts (it never generates inline,
        // which would evict the LLM). Each completed request gets one generated file and one durable
        // assistant image message. A message context has one imageRef by design; putting two results
        // on one row would make the last context write replace the first association.
        let imageRequests = tr?.imageRequests ?? []
        if (imageRequests.length === 0 && tr?.imageRequest?.prompt) {
          imageRequests = [tr.imageRequest]
        }
        if (
          imageRequests.length > 0 &&
          window.api.generateImage &&
          !cancelledRef.current.has(convId)
        ) {
          // The tool loop has finished its text answer and handed ownership to the
          // deferred image job. Mark that ownership exactly like explicit image mode
          // so the rendered Stop control cancels imagegen (not the already-finished
          // RAG stream) and remains scoped to this conversation.
          setImgProgress(null)
          setImageGenConv(convId)
          try {
            const stored = await window.api.addRagMessage(
              convId,
              'assistant',
              answer,
              toolCtxWithReasoning
            )
            setConvMessages(convId, (previous) =>
              previous.map((message) =>
                message.id === toolStreamId ? { ...message, id: stored.uuid } : message
              )
            )
            if (voiceMode) setAutoPlayId(stored.uuid)
          } catch {
            /* The answer remains on screen; image rows can still be persisted independently. */
            if (voiceMode) setAutoPlayId(toolStreamId)
          }
          try {
            for (const imageRequest of imageRequests) {
              if (cancelledRef.current.has(convId)) break
              setImgProgress(null)
              try {
                const img = await window.api.generateImage({
                  prompt: imageRequest.prompt,
                  conversationId: convId,
                  projectId: projectId
                })
                if (imageRequest.proposal) {
                  await window.api.storeProposalIllustration(
                    imageRequest.proposal.conversationId,
                    imageRequest.proposal.slide,
                    img.path
                  )
                }
                const imageContent = `Generated for: ${imageRequest.prompt}`
                const completedImage = completedImageMessage(
                  imageContent,
                  imageRequest.prompt,
                  img.prompt
                )
                let imageMessageId: string = crypto.randomUUID()
                try {
                  const stored = await window.api.addRagMessage(
                    convId,
                    'assistant',
                    completedImage.storedContent,
                    withGeneratedImageReference(undefined, {
                      id: img.syncId,
                      path: img.path
                    })
                  )
                  imageMessageId = stored.uuid
                  await announceImageMessagePersisted(convId, stored.uuid)
                } catch {
                  /* Keep the generated file visible even if this database write fails. */
                }
                setConvMessages(convId, (prev) => [
                  ...prev,
                  {
                    id: imageMessageId,
                    role: 'assistant',
                    ...completedImage,
                    image: img.dataUrl,
                    imagePath: img.path
                  }
                ])
              } catch (error) {
                // One failed image does not erase or block another completed tool request. Stop is
                // the exception: it cancels the active runtime and ends the remaining local work.
                if (cancelledRef.current.has(convId)) break
                console.error('Deferred tool image generation failed', error)
              }
            }
          } finally {
            setImgProgress(null)
            setImageGenConv((owner) => (owner === convId ? null : owner))
          }
          return
        }
        try {
          const stored = await window.api.addRagMessage(
            convId,
            'assistant',
            answer,
            toolCtxWithReasoning
          )
          setConvMessages(convId, (previous) =>
            previous.map((message) =>
              message.id === toolStreamId ? { ...message, id: stored.uuid } : message
            )
          )
          if (voiceMode) setAutoPlayId(stored.uuid)
        } catch {
          /* ignore */
          if (voiceMode) setAutoPlayId(toolStreamId)
        }
        return
      }

      // User stopped during the pre-stream window (persisting the turn, waiting for the
      // model) — don't open a stream at all.
      if (cancelledRef.current.has(convId)) return

      // Placeholder message that fills in live as tokens/reasoning stream in
      // (matched by streamId in the onRagStream subscription).
      const streamId = `a-${Date.now()}`
      activeStreamId = streamId // expose to finally for cleanup
      streamConvRef.current.set(streamId, convId!)
      setConvMessages(convId, (prev) => [
        ...prev,
        { id: streamId, role: 'assistant', content: '', reasoning: '', streaming: true }
      ])
      const result = await window.api.ragChat(
        modelQuery,
        'All',
        history,
        projectId,
        convId,
        noMemory && !projectId,
        streamId,
        thinkingEnabled,
        imagePaths
      )
      const resultContext = result.context as RagContext | undefined

      // Stopped mid-stream — one owner decides what survives (finalizeStoppedTurn).
      if (cancelledRef.current.has(convId)) {
        await finalizeStoppedTurn(convId, streamId, {
          answer: result.answer,
          context: resultContext,
          cutoff: result.cutoff
        })
        return
      }
      const assistantContent = result.answer || 'No response returned.'

      // The model decided this is an image request — replace the streamed turn
      // with on-device generation.
      const imgMatch = assistantContent.match(/```image\s*\n([\s\S]*?)```/i)
      if (imgMatch && window.api.generateImage) {
        const imgPrompt = imgMatch[1]!.trim()
        setConvMessages(convId, (prev) =>
          prev.map((m) =>
            m.id === streamId
              ? { ...m, content: 'Generating image…', reasoning: undefined, streaming: false }
              : m
          )
        )
        try {
          const img = await window.api.generateImage({
            prompt: imgPrompt,
            conversationId: convId,
            projectId: projectId
          })
          const completedImage = completedImageMessage(
            `Generated: ${imgPrompt.slice(0, 80)}`,
            imgPrompt,
            img.prompt
          )
          setConvMessages(convId, (prev) =>
            prev.map((m) =>
              m.id === streamId
                ? {
                    ...m,
                    ...completedImage,
                    image: img.dataUrl,
                    imagePath: img.path
                  }
                : m
            )
          )
          try {
            const stored = await window.api.addRagMessage(
              convId,
              'assistant',
              completedImage.storedContent,
              withGeneratedImageReference(undefined, { id: img.syncId, path: img.path })
            )
            await announceImageMessagePersisted(convId, stored.uuid)
          } catch {
            /* ignore */
          }
        } catch (err) {
          const msg = (err as Error).message || 'Image generation failed.'
          if (!/cancel/i.test(msg))
            setConvMessages(convId, (prev) =>
              prev.map((m) => (m.id === streamId ? { ...m, content: msg, streaming: false } : m))
            )
        }
      } else {
        // Finalize the streamed message — set authoritative text + context, clear streaming.
        // If this was a regenerate, keep the prior answer(s) as navigable variants.
        const priorVariants = pendingVariantsRef.current
        pendingVariantsRef.current = null
        const allVariants = priorVariants ? [...priorVariants, assistantContent] : undefined
        // Reasoning from the ref (populated as it streamed) — deterministic read, not
        // a setState-updater side effect. Rides the persisted context blob (T1f).
        const ragReasoning = reasoningByStream.current[streamId]
        delete reasoningByStream.current[streamId] // done with this stream — free it
        delete answerByStream.current[streamId]
        setConvMessages(convId, (prev) =>
          prev.map((m) =>
            m.id === streamId
              ? {
                  ...m,
                  content: assistantContent,
                  context: resultContext,
                  cutoff: result.cutoff,
                  streaming: false,
                  variants: allVariants,
                  variantIndex: allVariants ? allVariants.length - 1 : undefined
                }
              : m
          )
        )
        const art = parseArtifact(assistantContent)
        if (art) {
          // Inline-first: don't force the canvas open — the user opens the live
          // preview via the artifact card when they want it. Still save it, scoped
          // to this chat + project so the gallery can filter.
          void window.api
            .saveArtifact({
              kind: art.kind,
              code: art.code,
              conversationId: convId,
              projectId: projectId
            })
            .catch(() => {
              /* ignore */
            })
        }
        try {
          const stored = await window.api.addRagMessage(
            convId,
            'assistant',
            assistantContent,
            buildAssistantContext(resultContext, {
              reasoning: ragReasoning,
              cutoff: result.cutoff
            })
          )
          setConvMessages(convId, (previous) =>
            previous.map((message) =>
              message.id === streamId ? { ...message, id: stored.uuid } : message
            )
          )
          if (voiceMode) setAutoPlayId(stored.uuid)
        } catch (e) {
          console.error('Failed to persist assistant message:', e)
          if (voiceMode) setAutoPlayId(streamId)
        }
      }
    } catch (e) {
      // User stopped and the call REJECTED rather than returning, so there is no result to read.
      // This is the path that used to save nothing at all: the turn stayed on screen and was gone
      // the next time the conversation loaded. The refs still hold what streamed, so the same
      // owner finalises it.
      if (cancelledRef.current.has(convId)) {
        if (activeStreamId) await finalizeStoppedTurn(convId, activeStreamId)
        return
      }
      console.error('RAG chat failed', e)
      const errorMessage = e instanceof Error ? e.message : ''
      const remoteErrorStart = errorMessage.indexOf('Remote text model')
      const errorContent =
        remoteErrorStart >= 0
          ? errorMessage
              .slice(remoteErrorStart, remoteErrorStart + 800)
              .replace(/\s+/g, ' ')
              .trim()
          : 'Sorry, something went wrong while generating a response.'
      // Update the streaming placeholder to show the error — never append a second bubble.
      const sid = activeStreamId
      setConvMessages(convId, (prev) => {
        const hasPlaceholder = sid && prev.some((m) => m.id === sid)
        if (hasPlaceholder)
          return prev.map((m) =>
            m.id === sid
              ? { ...m, content: errorContent, activity: undefined, streaming: false }
              : m
          )
        return [...prev, { id: `a-${Date.now()}`, role: 'assistant', content: errorContent }]
      })
      try {
        await window.api.addRagMessage(convId, 'assistant', errorContent)
      } catch {
        /* ignore */
      }
    } finally {
      cancelledRef.current.delete(convId)
      markGenerating(convId, false)
      setLoading(false)
      await loadConversations()
      drainQueue(convId)
      if (activeStreamId) streamConvRef.current.delete(activeStreamId)
    }
  }

  // Fire a preset handed in via openTarget.seedPrompt. Runs after sendMessage is defined and
  // after the fresh-chat reset from the openTarget effect has settled, so the prompt lands in
  // the new empty conversation rather than whatever was open before.
  useEffect(() => {
    if (!pendingSeed) return
    const prompt = pendingSeed
    setPendingSeed(null)
    void sendMessage(prompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSeed])

  // Pull the next queued message for THIS conversation (sent while it was generating)
  // and send it — bound to its own conversation, never the active tab.
  const drainQueue = (convId: string): void => {
    const { item, next } = dequeue(queuedRef.current, convId)
    queuedRef.current = next
    setQueuedByConv({ ...next })
    if (item === undefined) return
    setTimeout(() => {
      void sendMessage(item.text || ' ', { atts: item.atts, conversationId: convId })
    }, 30)
  }

  const handleVoicePlaybackChange = useCallback((messageId: string, active: boolean): void => {
    setVoicePlaybackOwner((current) => nextVoicePlaybackOwner(current, messageId, active))
  }, [])

  const voiceTurns = useChatVoiceTurns({
    voiceMode,
    mode: voiceMode ? voiceTurnMode : 'tap',
    silenceAfterSpeechMs: voiceSilenceAfterSpeechMs,
    speakerDrainMs: voiceSpeakerDrainMs,
    isGenerating: Boolean(activeConversationId && generatingConvs.has(activeConversationId)),
    isPlaybackActive: voicePlaybackOwner !== null,
    transcribeAudio: (audio, extension) => window.api.transcribeAudio(audio, extension),
    getTranscriptionLabel: () => window.api.getTranscriptionInfo(),
    onTranscript: (text, clip) => {
      if (voiceMode && clip) {
        void sendMessage(text, { voiceClip: clip })
        return
      }
      setInput((previous) => `${previous}${previous ? ' ' : ''}${text}`)
    }
  })
  const recording =
    voiceTurns.phase === 'starting' ||
    voiceTurns.phase === 'listening' ||
    voiceTurns.phase === 'recording'
  const transcribing = voiceTurns.phase === 'transcribing'
  const textRecordButtonLabel = textRecordingButtonLabel(voiceTurns.phase)
  const textRecordTooltip = textRecordingTooltip(voiceTurns.phase, voiceTurns.transcriptionLabel)
  const toggleRecording = transcribing ? voiceTurns.cancel : voiceTurns.toggle

  // Stop the in-flight generation for a conversation: abort the model stream (main
  // keeps whatever streamed so far) or the image job, drop any queued follow-ups, and
  // return the UI to idle now. The in-flight sendMessage sees cancelledRef and bails at
  // its next await; this handles both the pre-stream ("Searching your memory…") window
  // and a live token stream.
  /**
   * Finalise a turn the user stopped. The ONE place that decides what a stopped turn keeps.
   *
   * There are three ways a stop lands: the plain reply settles with a partial result, the tool
   * loop settles with one, or the call REJECTS and there is no result at all. Each used to answer
   * this for itself and the three disagreed. The plain path saved the partial answer but dropped
   * the reasoning; the tool path did the same; and the reject path saved NOTHING, so a turn the
   * user could still see on screen was gone the next time the conversation loaded. All three also
   * gated on the answer alone, so stopping while the model was still thinking deleted the turn and
   * every word of reasoning with it.
   *
   * The rule, once: a stopped turn survives on EITHER partial answer or partial reasoning, and it
   * is written through the same context builder a completed turn uses, so both reload the same.
   * The answer and reasoning are read from the per-stream refs rather than from a result, because
   * the reject path has no result and the refs always hold what actually arrived.
   */
  const finalizeStoppedTurn = useCallback(
    async (
      convId: string,
      streamId: string,
      settled?: {
        answer?: string
        /** The context the RENDERED message carries. */
        context?: RagContext
        /** What goes in the stored blob, when that differs from the rendered context: the tool
         *  loop renders `{ unified }` but persists the tool calls alongside it. Defaults to
         *  `context`, so a caller with one context passes one context. */
        persistContext?: Record<string, unknown>
        cutoff?: ResponseCutoffContract
        toolCalls?: ChatMessage['toolCalls']
      }
    ): Promise<void> => {
      const reasoning = reasoningByStream.current[streamId]?.trim() || undefined
      const streamed = answerByStream.current[streamId] || ''
      delete reasoningByStream.current[streamId]
      delete answerByStream.current[streamId]

      const answer = (settled?.answer ?? streamed).trim()
      if (!answer && !reasoning) {
        setConvMessages(convId, (prev) => prev.filter((m) => m.id !== streamId))
        return
      }

      setConvMessages(convId, (prev) =>
        prev.map((m) =>
          m.id === streamId
            ? {
                ...m,
                content: answer,
                reasoning,
                context: settled?.context ?? m.context,
                cutoff: settled?.cutoff ?? m.cutoff,
                toolCalls: settled?.toolCalls ?? m.toolCalls,
                activity: undefined,
                streaming: false
              }
            : m
        )
      )
      try {
        await window.api.addRagMessage(
          convId,
          'assistant',
          answer,
          buildAssistantContext(settled?.persistContext ?? settled?.context, {
            reasoning,
            cutoff: settled?.cutoff
          })
        )
      } catch (e) {
        console.error('Failed to persist stopped assistant message:', e)
      }
    },
    [setConvMessages]
  )

  const stopGeneration = useCallback(
    async (
      cid: string | null,
      task: Pick<TaskSession, 'taskId' | 'journeyId' | 'kind'> | null
    ): Promise<void> => {
      const convId = cid ?? activeConversationId
      if (!convId) return
      if (task?.journeyId === convId) {
        try {
          const stopped = await stopLiveTask(task)
          if (!stopped) {
            setAttachWarn(stopFailureMessage(task.kind))
            return
          }
        } catch (error) {
          console.error(`Failed to stop ${task.kind} task ${task.taskId}:`, error)
          setAttachWarn(stopFailureMessage(task.kind))
          return
        }
      }
      setAttachWarn(null)
      cancelledRef.current.add(convId)
      const streamingId = (messagesByConv[convId] ?? []).find((m) => m.streaming)?.id
      if (streamingId) window.api.cancelRag(streamingId)
      if (queuedRef.current[convId]?.length) {
        queuedRef.current = clearQueue(queuedRef.current, convId)
        setQueuedByConv({ ...queuedRef.current })
      }
      markGenerating(convId, false)
      // Cancel + clear the image job ONLY if THIS conversation owns it, so stopping
      // one conversation never kills another's in-flight image (D9). imgProgress is a
      // shared stream buffer — clear it too when the owner stops.
      if (imageGenConv === convId) {
        window.api.cancelImageGen()
        setImageGenConv(null)
        setImgProgress(null)
      }
      // `loading` is the foreground send-flag; clear it when stopping the conversation
      // on screen (the only conversation whose composer is visible).
      if (convId === activeConversationId) setLoading(false)
    },
    [activeConversationId, messagesByConv, markGenerating, imageGenConv]
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash skill autocomplete: while typing "/name" (before any space), Tab —
    // or Enter on a not-yet-complete name — fills in the top matching skill.
    const sq = input.startsWith('/') && !/\s/.test(input) ? input.slice(1).toLowerCase() : null
    if (sq !== null) {
      const matches = skills.filter((s) => s.name.toLowerCase().includes(sq))
      const exact = skills.some((s) => s.name.toLowerCase() === sq)
      if (matches.length > 0 && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !exact))) {
        e.preventDefault()
        setInput(`/${matches[0]!.name} `) // matches.length > 0
        inputRef.current?.focus()
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // Don't send while an attachment is still processing — it would be dropped.
      if (attachments.some((a) => a.status === 'loading')) return
      sendMessage()
    }
  }

  // Voice output: synthesize a message on-device (Kokoro) and play it. Toggling
  // the same message stops playback.
  const speakMessage = useCallback(
    async (id: string, text: string) => {
      const request = ++speechRequestRef.current
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      // Toggle off if this message is already loading or playing.
      if (speakingId === id || speakLoadingId === id) {
        setSpeakingId(null)
        setSpeakLoadingId(null)
        setSpeakError(null)
        return
      }
      setSpeakError(null)
      setSpeakLoadingId(id) // generating on-device — show a loading state
      try {
        const { dataUrl } = await window.api.speak(messageToSpeakable(text))
        if (!voiceMountedRef.current || speechRequestRef.current !== request) return
        if (!dataUrl) throw new Error('empty dataUrl')
        const audio = new Audio(dataUrl)
        audioRef.current = audio
        audio.onended = () => {
          setSpeakingId((cur) => (cur === id ? null : cur))
          if (audioRef.current === audio) audioRef.current = null
        }
        audio.onerror = () => {
          console.error('[tts] audio element error', audio.error)
          setSpeakingId((cur) => (cur === id ? null : cur))
          setSpeakLoadingId((cur) => (cur === id ? null : cur))
          setSpeakError({
            id,
            message:
              'Speech could not be played. Check your audio output, then try speaking the reply again.'
          })
        }
        await audio.play()
        setSpeakLoadingId((cur) => (cur === id ? null : cur))
        setSpeakingId(id) // now actually speaking
      } catch (e) {
        console.error('[tts] failed', e)
        if (!voiceMountedRef.current || speechRequestRef.current !== request) return
        setSpeakLoadingId((cur) => (cur === id ? null : cur))
        setSpeakingId((cur) => (cur === id ? null : cur))
        setSpeakError({
          id,
          message:
            'Speech could not be generated. Check that Text-to-speech is installed in Settings, then try again.'
        })
      }
    },
    [speakingId, speakLoadingId]
  )

  const refreshGallery = useCallback(async () => {
    const scope =
      galleryScope === 'chat'
        ? { conversationId: activeConversationId || '__none__' }
        : galleryScope === 'project'
          ? { projectId: activeProjectId }
          : undefined
    try {
      setGallery((await window.api.listGeneratedImages?.(scope)) || [])
    } catch (e) {
      console.error(e)
    }
    try {
      setArtifacts(await window.api.listArtifacts(scope))
    } catch (e) {
      console.error(e)
    }
  }, [galleryScope, activeConversationId, activeProjectId])

  // Reload the gallery when it opens, its scope changes, or the core-neutral incoming-file
  // projection changes. A received file leaves that projection after its bytes are installed.
  useEffect(() => {
    if (!showGallery) return
    void refreshGallery()
  }, [showGallery, refreshGallery, incomingFiles])

  const deleteArtifact = useCallback(async (id: string) => {
    try {
      await window.api.deleteArtifact(id)
      setArtifacts((prev) => prev.filter((a) => a.id !== id))
    } catch (e) {
      console.error(e)
    }
  }, [])

  // Right-side panels are mutually exclusive — opening one closes the others so
  // they never overlap (one common docked panel slot).
  const closePanels = useCallback(() => {
    setCanvasArtifact(null)
    setSkillsOpen(false)
    setViewer(null)
    setShowGallery(false)
    setModelPickerOpen(false)
    setSettingsOpen(false)
  }, [])
  const openCanvas = useCallback(
    (a: Artifact) => {
      closePanels()
      setCanvasArtifact(a)
    },
    [closePanels]
  )

  const openGallery = useCallback(() => {
    if (showGallery) {
      setShowGallery(false)
      return
    }
    // Default the scope to the current context: a project → that project's items,
    // otherwise this chat's items. (User can switch to All.)
    setGalleryScope(activeProjectId ? 'project' : 'chat')
    // Close the OTHER panels (closePanels also clears showGallery), then open —
    // setShowGallery(true) runs last so it wins. The scope effect refreshes.
    closePanels()
    setShowGallery(true)
  }, [showGallery, activeProjectId, closePanels])

  const downloadImage = useCallback(async (path?: string, name?: string) => {
    if (!path) return
    try {
      await window.api.exportGeneratedImage?.(path, name || 'off-grid-image.png')
    } catch (e) {
      console.error(e)
    }
  }, [])

  const deleteImage = useCallback(async (path?: string) => {
    if (!path) return
    try {
      await window.api.deleteGeneratedImage?.(path)
      setMessages((prev) =>
        prev.map((m) =>
          m.imagePath === path
            ? { ...m, image: undefined, imagePath: undefined, content: m.content + '  (deleted)' }
            : m
        )
      )
      setGallery((prev) => prev.filter((g) => g.path !== path))
      setLightbox(null)
    } catch (e) {
      console.error(e)
    }
  }, [])

  // Auto-grow the composer with its content, up to a cap (then it scrolls).
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 208)}px`
  }, [input])

  useEffect(() => {
    window.api
      .listSkills()
      .then((listedSkills) => setSkills(Array.isArray(listedSkills) ? listedSkills : []))
      .catch(() => setSkills([]))
  }, [])

  // Live streaming: route token/reasoning events to the in-flight assistant
  // message (matched by streamId === message id) so it fills in as it generates.
  // Use streamConvRef to find the right conversation — setMessages is stale in a
  // [] effect because it captures activeConversationId at mount time.
  useEffect(() => {
    let disposed = false
    const off = window.api.onRagStream((data) => {
      const cid = streamConvRef.current.get(data.streamId)
      if (!cid) return
      if (data.type === 'done') {
        streamConvRef.current.delete(data.streamId)
        markGenerating(cid, false)
        return
      }
      // Mirror reasoning into a ref as it streams, so persistence can read it
      // deterministically (not via a state-updater side effect). Rendering still
      // uses message.reasoning below; this is the durable source for the saved blob.
      if (data.type === 'reasoning') {
        reasoningByStream.current[data.streamId] =
          (reasoningByStream.current[data.streamId] || '') + (data.text || '')
      }
      // The answer is mirrored for the same reason: when the user stops, the call can REJECT
      // rather than return, and then there is no result to read the partial answer out of. This
      // ref is the one place that always has what arrived.
      if (data.type === 'content') {
        answerByStream.current[data.streamId] =
          (answerByStream.current[data.streamId] || '') + (data.text || '')
      }
      setConvMessages(cid, (prev) =>
        prev.map((m) =>
          m.id === data.streamId && m.streaming ? (applyStreamEvent(m, data) as ChatMessage) : m
        )
      )
    })
    void (window.api.getActiveRagStreams?.() ?? Promise.resolve([]))
      .then((streams) => {
        if (disposed) return
        for (const stream of streams) {
          streamConvRef.current.set(stream.streamId, stream.conversationId)
          reasoningByStream.current[stream.streamId] = stream.reasoning
          answerByStream.current[stream.streamId] = stream.content
          markGenerating(stream.conversationId, true)
          setConvMessages(stream.conversationId, (previous) => {
            const restored: ChatMessage = {
              id: stream.streamId,
              role: 'assistant',
              content: stream.content,
              reasoning: stream.reasoning,
              streaming: true,
              toolCalls: stream.tools?.map((tool) => ({
                name: tool.name,
                result: tool.result ?? '',
                status: tool.status
              }))
            }
            const index = previous.findIndex((message) => message.id === stream.streamId)
            if (index < 0) return [...previous, restored]
            return previous.map((message, messageIndex) =>
              messageIndex === index ? { ...message, ...restored } : message
            )
          })
        }
      })
      .catch((error) => console.error('Failed to reattach active chat streams:', error))
    return () => {
      disposed = true
      off()
    }
  }, [activeConversationId, markGenerating, setConvMessages])

  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copyText = useCallback(async (t: string, key?: string) => {
    // Electron's renderer navigator.clipboard is flaky (silent reject), so copy via
    // the main-process clipboard; fall back to navigator if the bridge is missing.
    const api = window.api as { writeClipboardText?: (s: string) => Promise<boolean> }
    const copied = await writeClipboardWithFallback(t, api.writeClipboardText, (text) =>
      navigator.clipboard.writeText(text)
    )
    if (!copied) return
    // Brief "Copied" confirmation on the button that was pressed.
    const k = key ?? 'copy'
    setCopiedKey(k)
    setTimeout(() => setCopiedKey((prev) => (prev === k ? null : prev)), 1500)
  }, [])

  // Re-run the user prompt that produced (or precedes) a given message.
  const regenerate = useCallback(
    (messageId: string) => {
      const idx = messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return
      // Regenerating an assistant answer keeps prior answers as navigable variants.
      const target = messages[idx]! // idx >= 0 checked above
      if (target.role === 'assistant' && target.content.trim()) {
        pendingVariantsRef.current =
          target.variants && target.variants.length ? target.variants : [target.content]
      }
      // Walk back to the user turn that produced this answer.
      for (let i = idx; i >= 0; i--) {
        const mi = messages[i]! // 0 <= i <= idx
        if (mi.role === 'user') {
          const content = mi.content
          // Drop everything after that user turn (the old answer) and re-run in
          // place — no new user bubble. Also prune the persisted rows so reopening
          // the chat doesn't show old answers stacked.
          void (async () => {
            await stopLiveWebUseForConversation(activeConversationId)
            setMessages((prev) => prev.slice(0, i + 1))
            if (activeConversationId)
              await window.api.truncateRagMessages(activeConversationId, i + 1)
            // The turn's own attachments, not the composer's - the composer was cleared when this
            // turn was first sent, so regenerating without them re-asks the question WITHOUT its image.
            await sendMessage(content, { regen: true, atts: attachmentsOf(mi) })
          })()
          return
        }
      }
    },
    [activeConversationId, messages]
  )

  // Edit a sent message: replace its text, drop everything after it, re-run.
  const saveEdit = (id: string): void => {
    const text = editText.trim()
    setEditingId(null)
    if (!text) return
    const idx = messages.findIndex((m) => m.id === id)
    if (idx < 0) return
    setMessages((prev) =>
      prev.slice(0, idx + 1).map((m, i) => (i === idx ? { ...m, content: text } : m))
    )
    // Persist the edit: drop the old user row + everything after, re-add the
    // edited message, then regenerate the answer onto it.
    //
    // The re-added row carries the ORIGINAL turn's attachments. Editing the words of a message
    // does not detach its image, and rewriting the row without them deleted the only durable
    // record of it - so the chip vanished from the thread and every later regenerate lost it too.
    const cid = activeConversationId
    const edited = messages[idx]
    const keptAtts = edited ? attachmentsOf(edited) : []
    const persisted = keptAtts.length
      ? {
          attachments: keptAtts.map(
            (attachment): StoredAttachment => ({
              name: attachment.name,
              kind: attachment.kind,
              text: attachment.text,
              path: attachment.path
            })
          )
        }
      : undefined
    void (async () => {
      await stopLiveWebUseForConversation(cid)
      try {
        if (cid) {
          await window.api.truncateRagMessages(cid, idx)
          await window.api.addRagMessage(cid, 'user', text, persisted)
        }
      } catch (error) {
        console.error('Failed to persist the edited user message:', error)
        if (cid) {
          try {
            await refreshConversationMessages(cid)
          } catch (refreshError) {
            console.error('Failed to restore the conversation after the edit failed:', refreshError)
          }
        }
        return
      }
      try {
        await sendMessage(text, { regen: true, atts: keptAtts })
      } catch (error) {
        console.error('Failed to regenerate the edited message:', error)
      }
    })()
  }

  // Process attached files into text (read/parse/caption/transcribe) on the main side.
  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files)
      // The active model can't read images → don't attach them; tell the user why.
      if (!chatVision && arr.some((f) => f.type.startsWith('image/'))) {
        setAttachWarn(
          "This model can't read images. Switch to a vision model (Gemma E4B or Qwen3-VL 2B) in Models to attach images."
        )
      }
      const usable = chatVision ? arr : arr.filter((f) => !f.type.startsWith('image/'))
      for (const file of usable) {
        const id = crypto.randomUUID()
        // Show images as images straight away (local preview) so an upload reads as
        // an image while it captions in the background, not a generic TEXT box.
        const isImg = file.type.startsWith('image/')
        const preview = isImg ? URL.createObjectURL(file) : undefined
        setAttachments((prev) => [
          ...prev,
          {
            id,
            name: file.name,
            kind: isImg ? 'image' : 'text',
            text: '',
            mimeType: file.type || undefined,
            fileSize: file.size,
            createdAt: new Date().toISOString(),
            preview,
            status: 'loading'
          }
        ])
        try {
          const buf = await file.arrayBuffer()
          const res = await window.api.processFile(buf, file.name)
          // An image is ready once its file is saved - it carries no text at all, because the
          // image itself goes to the vision model and captioning it here was removed (it ran the
          // model synchronously and left the chip stuck on "Reading…"). Everything else is ready
          // once it has extracted text.
          const ok = res.kind === 'image' ? !!res.path : !!res.text
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? {
                    ...a,
                    kind: res.kind as Attachment['kind'],
                    text: res.text || '',
                    path: res.path,
                    preview,
                    status: ok ? 'ready' : 'error'
                  }
                : a
            )
          )
        } catch (e) {
          console.error('process file failed', e)
          const error = e instanceof Error && e.message ? e.message : 'Could not read this file.'
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, status: 'error', error } : a))
          )
        }
      }
    },
    [chatVision]
  )

  const removeAttachment = useCallback(
    (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id)),
    []
  )

  // Pasting an image (e.g. a screenshot) attaches it; a large text blob becomes a
  // "PASTED" chip instead of flooding the input.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const dt = e.clipboardData
      // Any real file (image, PDF, doc…) arrives in `files`, or — for a copied image
      // blob (screenshot) — as a `file` item. Attach all of them rather than falling
      // through to the filename text.
      let pasteFiles = Array.from(dt.files)
      if (!pasteFiles.length) {
        pasteFiles = Array.from(dt.items)
          .filter((it) => it.kind === 'file')
          .map((it) => it.getAsFile())
          .filter((f): f is File => !!f)
      }
      if (pasteFiles.length) {
        e.preventDefault()
        void addFiles(pasteFiles)
        return
      }
      const text = dt.getData('text')
      if (text && text.length > 1200) {
        e.preventDefault()
        const id = crypto.randomUUID()
        setAttachments((prev) => [
          ...prev,
          {
            id,
            name: 'Pasted text',
            kind: 'pasted',
            text,
            fileSize: new TextEncoder().encode(text).byteLength,
            createdAt: new Date().toISOString(),
            status: 'ready'
          }
        ])
      }
    },
    [addFiles]
  )

  let examples = ASK_EXAMPLES
  if (mode === 'image') examples = IMAGE_EXAMPLES
  else if (isPro) examples = ASK_EXAMPLES_PRO

  // Slash-command autocomplete: typing "/" (before any space) lists matching skills.
  const slashQuery =
    mode === 'ask' && input.startsWith('/') && !/\s/.test(input)
      ? input.slice(1).toLowerCase()
      : null
  const skillMatches =
    slashQuery !== null ? skills.filter((s) => s.name.toLowerCase().includes(slashQuery)) : []

  const messageNavigation: ContextNavigation = {
    onNavigateToMemory,
    onNavigateToChat,
    onNavigateToMeeting,
    onNavigateToEntity,
    onOpenProject,
    onSeekReplay,
    installedSkillNames: skills.map((skill) => skill.name),
    onOpenSkillPreset,
    onOpenInstalledSkill: (name) => {
      closePanels()
      setSelectedSkillName(name)
      setSkillsOpen(true)
    }
  }
  const messageActions: MessageRowActions = {
    copy: (text, key) => void copyText(text, key),
    regenerate,
    openImage: setLightbox,
    openAttachment: (attachment) => {
      const view = describeAttachment({
        fileName: attachment.name,
        mimeType: (attachment as { mimeType?: string }).mimeType,
        path: attachment.path,
        text: attachment.text
      })
      if (!view.viewable) return
      closePanels()
      if (view.renderer === 'image' && attachment.path) {
        setLightbox({ url: captureUrlForPath(attachment.path), path: attachment.path })
        return
      }
      setViewer({
        title: attachment.kind === 'pasted' ? 'Pasted text' : attachment.name,
        // A binary has no text body. Handing the viewer an empty string is what drew a blank page.
        text: view.source === 'text' ? attachment.text || '' : '',
        path: attachment.path,
        kind: view.kind,
        renderer: view.renderer
      })
    },
    startEdit: (message) => {
      void stopLiveWebUseForConversation(activeConversationId)
      setEditingId(message.id)
      setEditText(message.content)
    },
    changeEditText: setEditText,
    cancelEdit: () => setEditingId(null),
    saveEdit,
    retryImageMemory: (retry) => {
      void sendMessage(retry.prompt, {
        regen: true,
        conversationId: retry.conversationId,
        projectIdOverride: retry.projectId,
        imageRequest: { ...retry.request, allowUnsafeMemoryOverride: true }
      })
    },
    openArtifact: openCanvas,
    selectAskOption: ({ message, ask, option, selected }) => {
      if (!ask.multiSelect) {
        void sendMessage(option)
        return
      }
      setAskSel((previous) => {
        const current = previous[message.id] ?? []
        const next = selected
          ? current.filter((currentOption) => currentOption !== option)
          : [...current, option]
        return { ...previous, [message.id]: next }
      })
    },
    submitAsk: (selected) => void sendMessage(selected.join(', ')),
    speak: speakMessage,
    voicePlaybackChange: handleVoicePlaybackChange,
    selectVariant: (messageId, direction) => {
      setMessages((previous) =>
        previous.map((message) => {
          if (message.id !== messageId || !message.variants?.length) return message
          const current = message.variantIndex ?? 0
          const last = message.variants.length - 1
          return { ...message, variantIndex: Math.max(0, Math.min(last, current + direction)) }
        })
      )
    }
  }
  const latestVoiceAssistantId = voiceMode
    ? ([...messages].reverse().find((message) => message.role === 'assistant')?.id ?? null)
    : null

  return (
    <div
      className="flex h-full flex-col font-mono bg-neutral-950 transition-[padding] duration-200"
      style={{
        // Only the code/artifact canvas reflows content beside it (a deliberate
        // side-by-side edit surface). The drawers (settings, models, skills, gallery,
        // lightbox) are fixed overlays with their own opaque backdrop — they draw ON
        // TOP, so reserving width here just squeezed the chat to one word per line.
        paddingRight: canvasArtifact
          ? canvasWidth
            ? `${canvasWidth}px` // canvas open + resized → reflow content to its width
            : 'max(360px, 30vw)'
          : undefined
      }}
    >
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-neutral-900 px-6 py-4">
        <button
          onClick={() => {
            const panel = historyPanelRef.current
            if (showHistory) panel?.collapse()
            else panel?.expand()
          }}
          className="rounded-md border border-neutral-800 p-1.5 text-neutral-500 transition-colors hover:border-green-500 hover:text-green-500"
          title={showHistory ? 'Collapse conversation list' : 'Show conversations'}
          aria-label={showHistory ? 'Collapse conversation list' : 'Show conversations'}
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="16" rx="2" strokeWidth={2} />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 4v16" />
          </svg>
        </button>
        <div className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900">
          <svg
            className="h-4 w-4 text-green-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
            />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium tracking-wide text-neutral-200">Off Grid AI</h2>
          {activeProjectId && activeProjectName ? (
            <button
              onClick={() => onOpenProject?.(activeProjectId)}
              title={`Open project “${activeProjectName}”`}
              className="flex max-w-full items-center gap-1 truncate text-xs text-neutral-500 transition-colors hover:text-green-500"
            >
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate">In {activeProjectName}</span>
            </button>
          ) : (
            <p className="truncate text-xs text-neutral-500">
              Private, on-device — chat, generate, and build
            </p>
          )}
        </div>

        {/* Active models — pick the model per modality (text/image/voice/STT) */}
        <button
          onClick={() => {
            closePanels()
            setModelPickerOpen(true)
          }}
          className={`rounded-md border p-1.5 transition-colors ${modelPickerOpen ? 'border-green-500 text-green-500' : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'}`}
          title="Active models"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <rect x="4" y="4" width="16" height="16" rx="2" strokeWidth={2} />
            <path
              strokeLinecap="round"
              strokeWidth={2}
              d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"
            />
          </svg>
        </button>

        {/* Keep the conversation in place while its model settings drawer is open. */}
        <button
          onClick={() => {
            closePanels()
            setSettingsInitialTab('model')
            setSettingsOpen(true)
          }}
          className={`rounded-md border p-1.5 transition-colors ${settingsOpen ? 'border-green-500 text-green-500' : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'}`}
          title="Settings"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
        </button>
        <button
          ref={galleryTriggerRef}
          onClick={openGallery}
          className={`rounded-md border p-1.5 transition-colors ${showGallery ? 'border-green-500 text-green-500' : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'}`}
          title="Generated images"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 5a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 15l4-4 4 4 3-3 5 5"
            />
            <circle cx="9" cy="9" r="1.5" fill="currentColor" />
          </svg>
        </button>
        <TaskPanelTrigger conversationId={activeConversationId} />
      </header>

      {/* Body */}
      <PanelGroup
        direction="horizontal"
        autoSaveId="offgrid-memory-chat-layout"
        className="min-h-0 flex-1"
      >
        <Panel
          ref={historyPanelRef}
          id="conversation-history"
          order={1}
          defaultSize={20}
          minSize={14}
          maxSize={40}
          collapsible
          collapsedSize={0}
          onCollapse={() => setShowHistory(false)}
          onExpand={() => setShowHistory(true)}
          className="min-w-0 overflow-hidden transition-[flex-grow] duration-200 ease-out motion-reduce:transition-none"
        >
          <aside className="h-full overflow-hidden border-r border-neutral-900">
            <div className="flex h-full min-w-0 flex-col">
              <div className="px-2 pb-2 pt-3">
                <button
                  onClick={startNewConversation}
                  className="flex w-full items-center justify-center gap-2 rounded-md border border-neutral-800 px-3 py-2 text-xs text-neutral-300 transition-colors hover:border-green-500 hover:text-green-500"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 4v16m8-8H4"
                    />
                  </svg>
                  New chat
                </button>
              </div>
              {conversations.length > 0 && (
                <div className="px-2 pb-2">
                  <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 focus-within:border-neutral-600">
                    <svg
                      className="h-3.5 w-3.5 shrink-0 text-neutral-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      />
                    </svg>
                    <input
                      value={convSearch}
                      onChange={(e) => setConvSearch(e.target.value)}
                      placeholder="Search conversations…"
                      className="w-full bg-transparent text-xs text-neutral-200 placeholder-neutral-600 outline-none"
                    />
                    {convSearch && (
                      <button
                        onClick={() => setConvSearch('')}
                        className="shrink-0 text-neutral-600 hover:text-neutral-300"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div className="flex-1 overflow-y-auto px-2 pb-2">
                {(() => {
                  const q = convSearch.trim().toLowerCase()
                  const filtered = q
                    ? conversations.filter(
                        (c) =>
                          (c.title || '').toLowerCase().includes(q) || contentMatchIds.has(c.id)
                      )
                    : conversations
                  if (conversations.length === 0)
                    return (
                      <p className="px-2 py-4 text-center text-xs text-neutral-600">
                        No conversations yet
                      </p>
                    )
                  if (filtered.length === 0)
                    return (
                      <p className="px-2 py-4 text-center text-xs text-neutral-600">No matches</p>
                    )
                  const today = startOfLocalDay(new Date())
                  const startToday = today.getTime()
                  const startYesterday = shiftLocalDay(today, -1).getTime()
                  const startThisWeek = shiftLocalDay(today, -6).getTime()
                  const groups: { label: string; items: Conversation[] }[] = [
                    { label: 'Today', items: [] },
                    { label: 'Yesterday', items: [] },
                    { label: 'This week', items: [] },
                    { label: 'Older', items: [] }
                  ]
                  // Read through parseSqliteUtc, the SAME parser the row's label uses. These
                  // timestamps are UTC with no zone marker, and `new Date('2026-08-10 14:00:00')`
                  // reads a space-separated string as LOCAL - so the position said one thing and the
                  // words said another, off by the whole timezone offset. In IST that put "just now"
                  // below "5h ago" and dropped this morning's chats into Yesterday.
                  const ordered = [...filtered].sort(
                    (a, b) =>
                      parseSqliteUtc(b.updated_at).getTime() -
                      parseSqliteUtc(a.updated_at).getTime()
                  )
                  for (const c of ordered) {
                    const t = parseSqliteUtc(c.updated_at).getTime()
                    if (t >= startToday) groups[0]!.items.push(c)
                    else if (t >= startYesterday) groups[1]!.items.push(c)
                    else if (t >= startThisWeek) groups[2]!.items.push(c)
                    else groups[3]!.items.push(c)
                  }
                  return groups
                    .filter((g) => g.items.length)
                    .map((g) => (
                      <div key={g.label} className="mb-2">
                        <div className="px-1 py-1 text-[10px] uppercase tracking-wider text-neutral-600">
                          {g.label}
                        </div>
                        {g.items.map((conv) => (
                          <div
                            key={conv.id}
                            onClick={() => switchConversation(conv.id)}
                            className={`group flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
                              activeConversationId === conv.id
                                ? 'border-neutral-800 bg-neutral-900'
                                : 'border-transparent hover:bg-neutral-900/50'
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <ConversationTitleActions
                                conversation={conv}
                                onRenamed={conversationRenamed}
                                onDelete={() => deleteConversation(conv.id)}
                              />
                              {/* The last thing said, from the shared rule the phone's list uses. A
                                title alone told you nothing about a conversation you had elsewhere. */}
                              {chatListPreviewLine(conv.last_role, conv.last_content) ? (
                                <p className="mt-0.5 truncate text-[11px] text-neutral-500">
                                  {chatListPreviewLine(conv.last_role, conv.last_content)}
                                </p>
                              ) : null}
                              <div className="mt-0.5 flex items-center gap-2">
                                <span className="text-[10px] text-neutral-600">
                                  {timeAgo(conv.updated_at)}
                                </span>
                                {conv.project_id && (
                                  <span className="text-[10px] text-green-500/70">project</span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ))
                })()}
              </div>
            </div>
          </aside>
        </Panel>

        <PanelResizeHandle
          aria-label="Resize conversation list"
          title="Resize conversation list"
          className="group relative w-2 shrink-0 cursor-col-resize focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-500"
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-neutral-800 group-hover:bg-green-500/50 group-focus-visible:bg-green-500 group-data-[resize-handle-state=drag]:bg-green-500" />
        </PanelResizeHandle>

        {/* Main column */}
        <Panel
          id="chat"
          order={2}
          defaultSize={80}
          minSize={40}
          className="min-w-0 transition-[flex-grow] duration-200 ease-out motion-reduce:transition-none"
        >
          <div className="flex h-full min-w-0 flex-col">
            {/* Chat tabs — quick-switch between open conversations */}
            {(openTabs.length > 0 || activeConversationId) && (
              <div className="flex items-center gap-1 overflow-x-auto border-b border-neutral-900 px-2 py-1">
                {openTabs.map((id) => {
                  const t = conversations.find((c) => c.id === id)
                  const active = activeConversationId === id
                  return (
                    <div
                      key={id}
                      className={`group flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900'}`}
                    >
                      <button
                        onClick={() => switchConversation(id)}
                        className="max-w-[12rem] truncate"
                      >
                        {t?.title || 'Untitled'}
                      </button>
                      <button
                        onClick={() => closeTab(id)}
                        className="text-neutral-600 transition-colors hover:text-red-400"
                        title="Close tab"
                      >
                        ✕
                      </button>
                    </div>
                  )
                })}
                {!activeConversationId && (
                  <div className="flex shrink-0 items-center rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-neutral-100">
                    New chat
                  </div>
                )}
                <button
                  onClick={startNewConversation}
                  className="shrink-0 rounded-md px-2 py-1 text-neutral-500 transition-colors hover:text-green-500"
                  title="New tab"
                >
                  +
                </button>
              </div>
            )}
            {/* Messages */}
            <div ref={scrollRef} onScroll={onScrollFollow} className="flex-1 overflow-y-auto">
              {messages.length === 0 ? (
                <div className="flex min-h-full w-full flex-col items-center justify-center px-6 py-6 text-center">
                  <div className="mx-auto flex max-w-2xl flex-col items-center">
                    <div
                      data-testid="chat-empty-hero"
                      className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-card shadow-sm"
                    >
                      <svg
                        className="h-8 w-8 text-primary"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                        />
                      </svg>
                    </div>
                    <h2 className="text-3xl font-semibold tracking-tight text-foreground">
                      {mode === 'image' ? 'Create an image' : 'Start a conversation'}
                    </h2>
                    <p className="mt-3 max-w-md text-sm text-muted-foreground">
                      {mode === 'image'
                        ? 'Pick a style, then describe your subject — generated on-device.'
                        : activeProjectName
                          ? `Grounded in the “${activeProjectName}” knowledge base.`
                          : isPro
                            ? 'Ask across your memories, chats, and entities from every source.'
                            : 'Ask anything, generate images, or build — all on-device.'}
                    </p>
                  </div>
                  {mode !== 'image' ? (
                    <ExploreSection
                      onRun={(preset) => {
                        void sendMessage(preset.prompt)
                      }}
                      requestUrl={REQUEST_FORM_URL}
                      className="mt-6 w-full text-left"
                    />
                  ) : null}
                  {mode === 'image' ? (
                    <StylePresetPicker
                      activeStyle={activeStyle}
                      styleThumbs={styleThumbs}
                      onChange={setActiveStyle}
                    />
                  ) : (
                    <div className="mt-6 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                      {examples.map((ex) => (
                        <button
                          key={ex}
                          onClick={() => sendMessage(ex)}
                          className="rounded-md border border-border bg-background px-3 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-foreground"
                        >
                          {ex}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="w-full px-6 py-5">
                  {messages.map((message, messageIndex) => {
                    if (message.role === 'tool') {
                      if (messages[messageIndex - 1]?.role === 'tool') return null
                      const run: ChatMessage[] = []
                      for (let index = messageIndex; messages[index]?.role === 'tool'; index += 1) {
                        run.push(messages[index]!)
                      }
                      return <ToolMessageTimelineRow key={message.id} messages={run} />
                    }
                    return (
                      <MessageRow
                        key={message.id}
                        message={message}
                        nextMessageRole={messages[messageIndex + 1]?.role}
                        voiceMode={voiceMode}
                        state={{
                          autoPlayId,
                          copiedKey,
                          editingId,
                          editText,
                          loading,
                          speakingId,
                          speakLoadingId,
                          speakError,
                          ttsEnabled,
                          ttsSpeed,
                          latestVoiceAssistantId,
                          askSelections: askSel,
                          incomingFiles: incomingFilesFor(message.id)
                        }}
                        actions={messageActions}
                        navigation={messageNavigation}
                      />
                    )
                  })}
                  {/* A reply generating on another one of your devices, streaming here live. Pro
                    registers the renderer; the free build has no slot and this is nothing. */}
                  {ChatMessagesFooter && activeConversationId ? (
                    <ChatMessagesFooter
                      conversationId={activeConversationId}
                      promptEnhancementActive={promptEnhancementActive}
                      promptEnhancementComplete={promptEnhancementComplete}
                    />
                  ) : null}
                  {liveJourneyTask ? <TaskLiveActivity task={liveJourneyTask} /> : null}
                  {!!activeConversationId &&
                  !liveJourneyTask &&
                  generatingConvs.has(activeConversationId) &&
                  !messages.some((m) => m.streaming) ? (
                    <div className="mb-5 flex flex-col items-start">
                      <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-600">
                        Off Grid AI
                      </div>
                      {mode === 'image' || generatingImage ? (
                        <div className="flex w-full flex-col items-start gap-2">
                          {imageJobStage === 'enhancing' || streamingEnhancedPrompt ? (
                            <ChatThinkingBlock
                              content={streamingEnhancedPrompt || 'Starting…'}
                              live={imageJobStage === 'enhancing'}
                              label={
                                imageJobStage === 'enhancing'
                                  ? 'Enhancing prompt…'
                                  : 'Enhanced prompt'
                              }
                            />
                          ) : null}
                          <div className="w-full rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
                            {imgProgress?.preview ? (
                              <img
                                src={imgProgress.preview}
                                alt="forming"
                                className="mb-2 aspect-square w-full rounded-md border border-neutral-800 object-cover"
                              />
                            ) : (
                              <div className="mb-2 flex aspect-square w-full items-center justify-center rounded-md border border-neutral-800 text-[11px] text-neutral-600">
                                Preparing image…
                              </div>
                            )}
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500">
                              <span>{imageProgressLabel(imageJobStage, imgProgress)}</span>
                              {imgProgress ? (
                                <span className="text-neutral-600">
                                  · ~
                                  {Math.max(
                                    0,
                                    Math.round(
                                      (imgProgress.total - imgProgress.step) *
                                        imgProgress.secPerStep
                                    )
                                  )}
                                  s left
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
                              <div
                                className="h-full bg-green-500 transition-all duration-300"
                                style={{
                                  width: imgProgress
                                    ? `${(imgProgress.step / imgProgress.total) * 100}%`
                                    : '5%'
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      ) : (
                        <ChatLoadingCard
                          label={waitingLabel({ noMemory, hasProject: !!activeProjectId })}
                        />
                      )}
                    </div>
                  ) : null}
                  <div ref={bottomRef} className="h-2" />
                </div>
              )}
            </div>

            {/* Composer */}
            <div className="border-t border-neutral-900 px-6 py-3">
              <div className="w-full">
                {/* Image options (image mode, expandable) */}
                {mode === 'image' && showImageOptions && (
                  <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-neutral-800 px-3 py-2 text-[11px] text-neutral-500">
                    {imgModels.length > 1 && (
                      <label className="flex items-center gap-1.5">
                        Model
                        <select
                          value={imgModel}
                          onChange={(e) => chooseImageModel(e.target.value)}
                          className="max-w-[12rem] rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 outline-none focus:border-green-500"
                        >
                          {imgModels.map((m) => (
                            <option key={m} value={m}>
                              {m.replace(/\.gguf$/i, '').replace(/-Q\d.*$/i, '')}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="flex items-center gap-1.5">
                      Size
                      <select
                        value={imgSize}
                        onChange={(e) => setSizeOverride(Number(e.target.value))}
                        className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 outline-none focus:border-green-500"
                      >
                        <option value={256}>256</option>
                        <option value={512}>512</option>
                        <option value={640}>640</option>
                        <option value={768}>768</option>
                        <option value={1024}>1024</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1.5">
                      Steps
                      <input
                        type="number"
                        min={4}
                        max={50}
                        value={imgSteps}
                        onChange={(e) =>
                          setStepsOverride(Math.max(4, Math.min(50, Number(e.target.value) || 16)))
                        }
                        className="w-14 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 outline-none focus:border-green-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                    </label>
                    <label className="flex items-center gap-1.5">
                      Guidance
                      <input
                        type="number"
                        min={0}
                        max={20}
                        step={0.5}
                        value={imgCfgScale}
                        onChange={(e) =>
                          setCfgScaleOverride(
                            Math.max(0, Math.min(20, Number(e.target.value) || 0))
                          )
                        }
                        className="w-14 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 outline-none focus:border-green-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                    </label>
                    <label className="flex items-center gap-1.5">
                      Seed
                      <input
                        value={imgSeed}
                        onChange={(e) => setImgSeed(e.target.value.replace(/[^0-9]/g, ''))}
                        placeholder="random"
                        className="w-20 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 placeholder-neutral-700 outline-none focus:border-green-500"
                      />
                    </label>
                    <input
                      value={imgNegative}
                      onChange={(e) => setImgNegative(e.target.value)}
                      placeholder="Negative prompt"
                      className="min-w-[10rem] flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-300 placeholder-neutral-700 outline-none focus:border-green-500"
                    />
                    <label
                      className="flex items-center gap-1.5"
                      title="Rewrite your prompt with the local model for richer, more detailed images"
                    >
                      <input
                        type="checkbox"
                        checked={enhanceImg}
                        onChange={(e) => setEnhanceImg(e.target.checked)}
                        className="accent-green-500"
                      />
                      Enhance
                    </label>
                    {imgInit ? (
                      <span className="flex items-center gap-2 rounded-md border border-green-500/40 px-2 py-1 text-green-500">
                        {imgInit.split('/').pop()}
                        <label
                          className="flex items-center gap-1 text-neutral-500"
                          title="img2img strength: how much to change the init image (0.1 = subtle, 1 = ignore it)"
                        >
                          Strength
                          <input
                            type="number"
                            min={0.1}
                            max={1}
                            step={0.05}
                            value={imgStrength}
                            onChange={(e) =>
                              setImgStrength(
                                Math.max(0.1, Math.min(1, Number(e.target.value) || 0.6))
                              )
                            }
                            className="w-14 rounded border border-neutral-800 bg-neutral-950 px-1.5 py-0.5 text-neutral-300 outline-none focus:border-green-500"
                          />
                        </label>
                        <button
                          onClick={() => setImgInit(null)}
                          className="text-neutral-500 hover:text-red-400"
                        >
                          ✕
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={async () => {
                          const p = await window.api.pickImageForGen?.()
                          if (p) setImgInit(p)
                        }}
                        className="rounded-md border border-neutral-800 px-2 py-1 text-neutral-400 transition-colors hover:border-green-500 hover:text-green-500"
                      >
                        + Init image
                      </button>
                    )}
                  </div>
                )}

                <AnimatePresence initial={false}>
                  {mode === 'image' && messages.length > 0 ? (
                    <motion.div
                      key="inline-image-style-picker"
                      role="region"
                      aria-label="Image style presets"
                      className="overflow-hidden"
                      initial={{ height: 0, opacity: 0, y: 8 }}
                      animate={{ height: 'auto', opacity: 1, y: 0 }}
                      exit={{ height: 0, opacity: 0, y: 6 }}
                      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                    >
                      <StylePresetPicker
                        compact
                        activeStyle={activeStyle}
                        styleThumbs={styleThumbs}
                        onChange={setActiveStyle}
                      />
                    </motion.div>
                  ) : null}
                </AnimatePresence>

                {projCreating && (
                  <div className="mb-2">
                    <input
                      ref={projInputRef}
                      value={projNewName}
                      onChange={(e) => setProjNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') createAndAssignProject()
                        if (e.key === 'Escape') {
                          setProjCreating(false)
                          setProjNewName('')
                        }
                      }}
                      onBlur={createAndAssignProject}
                      placeholder="New project name…  (Enter to create, Esc to cancel)"
                      className="w-full rounded-md border border-green-500 bg-neutral-900 px-3 py-2 text-xs text-white placeholder-neutral-600 outline-none"
                    />
                  </div>
                )}

                {queuedCount(queuedByConv, activeConversationId) > 0 && (
                  <div className="mb-2 flex flex-col gap-1">
                    {(activeConversationId ? (queuedByConv[activeConversationId] ?? []) : []).map(
                      (q, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-1.5 text-[11px] text-neutral-400"
                        >
                          <svg
                            className="h-3 w-3 shrink-0 text-neutral-600"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                          </svg>
                          <span className="flex-1 select-text cursor-text whitespace-pre-wrap break-words">
                            {q.text ||
                              `(${q.atts.length} attachment${q.atts.length > 1 ? 's' : ''})`}
                          </span>
                          {q.atts.length > 0 ? (
                            <span
                              className="flex shrink-0 items-center gap-1 text-neutral-500"
                              title={q.atts.map((a) => a.name).join(', ')}
                            >
                              <svg
                                className="h-3 w-3"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                                />
                              </svg>
                              {q.atts.length}
                            </span>
                          ) : null}
                          <button
                            onClick={() => copyText(q.text)}
                            className="shrink-0 cursor-pointer text-neutral-600 transition-colors hover:text-green-500"
                            title="Copy"
                          >
                            <svg
                              className="h-3 w-3"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M8 16h8M8 12h8m-7 8h6a2 2 0 002-2V6a2 2 0 00-2-2h-3.586a1 1 0 00-.707.293l-2.414 2.414A1 1 0 009 7.414V18a2 2 0 002 2z"
                              />
                            </svg>
                          </button>
                          <span className="shrink-0 text-neutral-600">queued</span>
                        </div>
                      )
                    )}
                  </div>
                )}

                {/* Unified composer — the SAME toolbar (attach / image / project /
                  skills / tools / memory scope / thinking) serves chat and voice
                  mode; only the input surface (textarea vs. mic) differs. */}
                <div
                  data-testid="chat-composer"
                  data-focus-surface="chat-composer"
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (!dragOver) setDragOver(true)
                  }}
                  onDragLeave={(e) => {
                    if (e.currentTarget === e.target) setDragOver(false)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOver(false)
                    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files)
                  }}
                  className={`relative rounded-xl border bg-card text-card-foreground shadow-sm transition-colors ${dragOver ? 'border-primary' : 'border-input focus-within:border-ring'}`}
                >
                  {dragOver ? (
                    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-xl bg-card/80 text-xs text-primary">
                      Drop files to attach
                    </div>
                  ) : null}
                  {skillMatches.length > 0 && (
                    <div className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg">
                      <div className="flex items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wide text-neutral-600">
                        <span>Skills</span>
                        <span className="normal-case text-neutral-700">Tab to complete</span>
                      </div>
                      {skillMatches.slice(0, 6).map((s, i) => (
                        <button
                          key={s.name}
                          onClick={() => {
                            setInput(`/${s.name} `)
                            inputRef.current?.focus()
                          }}
                          className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-neutral-900 ${i === 0 ? 'bg-neutral-900/60' : ''}`}
                        >
                          <span className="text-green-500">/{s.name}</span>
                          {s.description ? (
                            <span className="line-clamp-1 text-[11px] text-neutral-500">
                              {s.description}
                            </span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.length) void addFiles(e.target.files)
                      e.target.value = ''
                    }}
                  />
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.length) void addFiles(e.target.files)
                      e.target.value = ''
                    }}
                  />
                  {attachWarn && (
                    <div className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
                      <WarningCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" weight="fill" />
                      <span className="flex-1">{attachWarn}</span>
                      <button
                        onClick={() => setAttachWarn(null)}
                        className="shrink-0 text-amber-400/70 hover:text-amber-200"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                  {attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 px-3 pt-3">
                      {attachments.map((a) => (
                        <div
                          key={a.id}
                          className="group relative flex w-40 flex-col gap-1 rounded-lg border border-neutral-800 bg-neutral-900 p-2"
                        >
                          <button
                            onClick={() => removeAttachment(a.id)}
                            className="absolute -right-1.5 -top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full border border-neutral-700 bg-neutral-950 text-[10px] text-neutral-400 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                          >
                            ✕
                          </button>
                          {a.kind === 'image' ? (
                            <button
                              type="button"
                              onClick={() => {
                                const url = a.preview || (a.path ? captureUrlForPath(a.path) : '')
                                if (url) {
                                  closePanels()
                                  setLightbox({ url, path: a.path })
                                }
                              }}
                              title="Click to view"
                              className="relative h-[2.6rem] overflow-hidden rounded-md"
                            >
                              <img
                                src={a.preview || (a.path ? captureUrlForPath(a.path) : '')}
                                alt={a.name}
                                className="h-full w-full object-cover"
                              />
                              {a.status === 'loading' ? (
                                <span className="absolute inset-0 flex items-center justify-center bg-neutral-950/50 text-[9px] text-neutral-300">
                                  Reading…
                                </span>
                              ) : a.status === 'error' ? (
                                <span className="absolute inset-0 flex items-center justify-center bg-neutral-950/85 px-2 text-center text-[9px] text-red-300">
                                  {a.error || 'Could not read this image.'}
                                </span>
                              ) : null}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={!a.text}
                              onClick={() => {
                                if (a.text || a.path) {
                                  closePanels()
                                  setViewer({
                                    title: a.kind === 'pasted' ? 'Pasted text' : a.name,
                                    text: a.text || '',
                                    path: a.path,
                                    kind: a.kind
                                  })
                                }
                              }}
                              title={a.text ? 'Click to expand' : undefined}
                              className="line-clamp-3 h-[2.6rem] overflow-hidden text-left text-[10px] leading-snug text-neutral-500 enabled:hover:text-neutral-300"
                            >
                              {a.status === 'loading'
                                ? 'Processing…'
                                : a.status === 'error'
                                  ? a.error || 'Could not read this file.'
                                  : a.text.slice(0, 140) || a.name}
                            </button>
                          )}
                          <div className="flex items-center justify-between">
                            <span className="truncate text-[10px] text-neutral-400" title={a.name}>
                              {a.kind === 'pasted' ? '' : a.name}
                            </span>
                            <span className="rounded-sm border border-neutral-700 px-1 py-0.5 text-[9px] uppercase tracking-wide text-neutral-400">
                              {a.kind === 'pasted' ? 'Pasted' : a.kind}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Approval UX v2: pending gate cards + outcomes, in-flow above the composer */}
                  <ActionGateDock />
                  {/* Vision rail: the supervisor overlay slides in during a computer-use task */}
                  <VisionSupervisorOverlay />
                  {voiceTurns.microphoneDenied && (
                    <div
                      role="alert"
                      className="mx-2 mb-2 flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
                    >
                      <span>
                        Microphone access is off. Allow Off Grid AI Desktop in System Settings, then
                        try again.
                      </span>
                      <button
                        type="button"
                        onClick={() => void window.api.openMicrophoneSettings()}
                        className="shrink-0 text-amber-300 underline underline-offset-2 transition-colors hover:text-amber-100"
                      >
                        Open System Settings
                      </button>
                    </div>
                  )}
                  {voiceTurns.error && !voiceTurns.microphoneDenied && !voiceMode && (
                    <div
                      role="alert"
                      className="mx-2 mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
                    >
                      {voiceTurns.error}
                    </div>
                  )}
                  {voiceMode ? (
                    <ChatVoiceComposer
                      phase={voiceTurns.phase}
                      turnMode={voiceTurnMode}
                      suspended={voiceTurns.suspended}
                      transcriptionLabel={voiceTurns.transcriptionLabel}
                      error={voiceTurns.error}
                      onToggleRecording={toggleRecording}
                    />
                  ) : (
                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      onPaste={handlePaste}
                      rows={1}
                      placeholder={
                        mode === 'image'
                          ? 'Describe an image to generate…'
                          : activeProjectName
                            ? `Ask about “${activeProjectName}”…`
                            : 'Ask anything…'
                      }
                      className="max-h-52 w-full resize-none overflow-y-auto bg-transparent px-3.5 pt-3 text-sm text-foreground placeholder:text-muted-foreground outline-none"
                    />
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-y-2 gap-x-2 px-2.5 pb-2.5 pt-1">
                    {/* Chips wrap to a new line on narrow widths instead of overflowing the composer
                      (the Image chip used to clip off the right edge). */}
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      {/* "+" menu — attach / image / project / tools */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            aria-label="Composer options"
                            className="size-8 rounded-full"
                          >
                            <Plus className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          side="top"
                          sideOffset={8}
                          className="w-56"
                        >
                          <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                            <Paperclip /> Attach files
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => imageInputRef.current?.click()}>
                            <ImageIcon /> Add image
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!imageAvailable}
                            onSelect={() => setMode('image')}
                          >
                            <Sparkles /> Generate image
                          </DropdownMenuItem>
                          {projects.length > 0 ? (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>
                                <FolderOpen /> Add to project
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
                                {projects.map((p) => (
                                  <DropdownMenuItem
                                    key={p.id}
                                    onSelect={() => {
                                      setNoMemory(false)
                                      assignProject(p.id)
                                    }}
                                  >
                                    <FolderOpen /> <span className="flex-1 truncate">{p.name}</span>
                                    {activeProjectId === p.id && (
                                      <Check className="h-3.5 w-3.5 text-primary" />
                                    )}
                                  </DropdownMenuItem>
                                ))}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => setProjCreating(true)}>
                                  <FolderPlus /> New project
                                </DropdownMenuItem>
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          ) : (
                            <DropdownMenuItem onSelect={() => setProjCreating(true)}>
                              <FolderPlus /> Add to project
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => {
                              closePanels()
                              setSkillsOpen(true)
                            }}
                          >
                            <Lightning /> Skills
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={(e) => {
                              e.preventDefault()
                              setToolsOn((t) => !t)
                            }}
                          >
                            <Wrench /> <span className="flex-1">Tools</span>
                            <span
                              className={`text-xs ${toolsOn ? 'text-primary' : 'text-muted-foreground'}`}
                            >
                              {toolsOn ? 'On' : 'Off'}
                            </span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={(e) => {
                              e.preventDefault()
                              setConnectorsOn((t) => !t)
                            }}
                          >
                            <Plug /> <span className="flex-1">Connectors</span>
                            <span
                              className={`text-xs ${connectorsOn ? 'text-primary' : 'text-muted-foreground'}`}
                            >
                              {connectorsOn ? 'On' : 'Off'}
                            </span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      {/* Scope — Off Grid (default) or a project */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            title="Choose what this chat can draw on: your memory, nothing, or a project"
                            className={`h-8 gap-1.5 rounded-full ${activeProjectId || (isPro && !noMemory) ? 'border-green-500 text-primary' : 'text-neutral-400'}`}
                          >
                            {activeProjectId ? (
                              <FolderOpen className="h-3.5 w-3.5" />
                            ) : (
                              <Brain className="h-3.5 w-3.5" />
                            )}
                            <span className="max-w-[9rem] truncate">
                              {activeProjectName ?? (noMemory ? 'No memory' : 'All memory')}
                            </span>
                            <CaretDown className="h-3 w-3 opacity-60" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          side="top"
                          sideOffset={8}
                          className="w-56"
                        >
                          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            Memory for this chat
                          </DropdownMenuLabel>
                          {isPro && (
                            <DropdownMenuItem
                              onSelect={() => {
                                setNoMemory(false)
                                assignProject(null)
                              }}
                            >
                              <Brain />
                              <span
                                className={`flex-1 ${!activeProjectId && !noMemory ? 'text-primary' : ''}`}
                              >
                                All memory
                              </span>
                              {!activeProjectId && !noMemory && (
                                <Check className="h-3.5 w-3.5 text-primary" />
                              )}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onSelect={() => {
                              setNoMemory(true)
                              assignProject(null)
                            }}
                          >
                            <Prohibit />
                            <span
                              className={`flex-1 ${!activeProjectId && noMemory ? 'text-primary' : ''}`}
                            >
                              No memory{' '}
                              <span className="text-[10px] text-muted-foreground">
                                · plain chat
                              </span>
                            </span>
                            {!activeProjectId && noMemory && (
                              <Check className="h-3.5 w-3.5 text-primary" />
                            )}
                          </DropdownMenuItem>
                          {projects.length > 0 && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                Project memory
                              </DropdownMenuLabel>
                              {projects.map((p) => (
                                <DropdownMenuItem
                                  key={p.id}
                                  onSelect={() => {
                                    setNoMemory(false)
                                    assignProject(p.id)
                                  }}
                                >
                                  <FolderOpen />
                                  <span
                                    className={`flex-1 truncate ${activeProjectId === p.id ? 'text-primary' : ''}`}
                                  >
                                    {p.name}
                                  </span>
                                  {activeProjectId === p.id && (
                                    <Check className="h-3.5 w-3.5 text-primary" />
                                  )}
                                </DropdownMenuItem>
                              ))}
                            </>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setProjCreating(true)}>
                            <FolderPlus /> New project
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      {/* Active model + context window — click to change (opens the same
                        ModelPicker as the header). Mirrors what the Active-models panel shows. */}
                      {modelSummary.name && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setModelPickerOpen(true)}
                              className="h-8 max-w-[14rem] gap-1.5 rounded-full text-neutral-400"
                            >
                              <Cpu className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{modelSummary.name}</span>
                              {modelSummary.ctx && (
                                <span className="shrink-0 text-neutral-600">
                                  · {modelSummary.ctx}
                                </span>
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {`Active model: ${modelSummary.name}${
                              modelSummary.ctx ? ` · ${modelSummary.ctx} context window` : ''
                            }. Click to change.`}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setThinkingEnabled((t) => !t)}
                            className={`h-8 gap-1.5 rounded-full ${thinkingEnabled ? 'border-green-500 text-primary' : 'text-neutral-400'}`}
                          >
                            <Brain className="h-3.5 w-3.5" /> Thinking
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {thinkingEnabled
                            ? 'Reasoning on — the model thinks step by step (slower)'
                            : 'Reasoning off — direct answers (faster)'}
                        </TooltipContent>
                      </Tooltip>
                      <VoiceModeControl
                        active={voiceMode}
                        onToggle={() => setVoiceMode((current) => !current)}
                        onOpenSettings={() => {
                          closePanels()
                          setSettingsInitialTab('voice')
                          setSettingsOpen(true)
                        }}
                      />
                      {/* Image toggle — always available; turning it on makes the next
                      prompt generate an image instead of a chat reply. */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const on = mode !== 'image'
                              setMode(on ? 'image' : 'ask')
                              if (!on) setShowImageOptions(false)
                            }}
                            className={`h-8 gap-1.5 rounded-full ${mode === 'image' ? 'border-green-500 text-primary' : 'text-neutral-400'}`}
                          >
                            <Sparkles className="h-3.5 w-3.5" /> Image
                            {mode === 'image' && <X className="h-3.5 w-3.5 opacity-70" />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {mode === 'image'
                            ? 'Image mode on — your prompt generates an image (click to return to chat)'
                            : 'Generate an image from your prompt'}
                        </TooltipContent>
                      </Tooltip>
                      {mode === 'image' && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setShowImageOptions((o) => !o)}
                          className={`h-8 gap-1.5 rounded-full ${showImageOptions ? 'text-primary' : ''}`}
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" /> Image options
                        </Button>
                      )}
                      {queuedCount(queuedByConv, activeConversationId) > 0 && (
                        <span className="flex h-8 items-center rounded-full border border-neutral-800 px-2.5 text-[11px] text-neutral-400">
                          {queuedCount(queuedByConv, activeConversationId)} queued
                        </span>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {!voiceMode && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              aria-label={textRecordButtonLabel}
                              onClick={toggleRecording}
                              className={`size-8 ${recording ? 'border-red-500/50 text-red-400' : ''}`}
                            >
                              {transcribing ? (
                                <span className="relative flex items-center justify-center">
                                  <svg
                                    className="h-4 w-4 animate-spin"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                  >
                                    <circle
                                      className="opacity-25"
                                      cx="12"
                                      cy="12"
                                      r="10"
                                      stroke="currentColor"
                                      strokeWidth="4"
                                    />
                                    <path
                                      className="opacity-75"
                                      fill="currentColor"
                                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                                    />
                                  </svg>
                                  <X className="absolute h-2.5 w-2.5" weight="bold" />
                                </span>
                              ) : recording ? (
                                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                                  <rect x="6" y="6" width="12" height="12" rx="2" />
                                </svg>
                              ) : (
                                <svg
                                  className="h-4 w-4"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M19 11a7 7 0 01-14 0m7 7v3m0-3a4 4 0 01-4-4V5a4 4 0 018 0v6a4 4 0 01-4 4z"
                                  />
                                </svg>
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{textRecordTooltip}</TooltipContent>
                        </Tooltip>
                      )}
                      {/* Stop shows for the WHOLE generating window — the pre-stream
                        "Searching your memory…" phase as well as a live token stream —
                        so an in-flight turn is always cancellable. Image gen has its own
                        labeled Stop just below, so skip this icon in that mode. */}
                      {!!activeConversationId &&
                        generatingConvs.has(activeConversationId) &&
                        !(loading && generatingImage) && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                aria-label="Stop generating"
                                onClick={() =>
                                  void stopGeneration(activeConversationId, liveJourneyTask)
                                }
                                className="size-8 rounded-full border-red-500/50 text-red-400 hover:bg-red-500/10"
                              >
                                <svg
                                  className="h-3.5 w-3.5"
                                  fill="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <rect x="6" y="6" width="12" height="12" rx="2" />
                                </svg>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Stop generating</TooltipContent>
                          </Tooltip>
                        )}
                      {loading && generatingImage ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            void stopGeneration(activeConversationId, liveJourneyTask)
                          }}
                          className="h-8 gap-1.5 border-red-500/50 text-red-400 hover:bg-red-500/10"
                        >
                          <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                            <rect x="6" y="6" width="12" height="12" rx="2" />
                          </svg>
                          Stop
                        </Button>
                      ) : voiceMode ? null : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              size="icon"
                              onClick={() => sendMessage()}
                              disabled={
                                (!input.trim() && attachments.length === 0) ||
                                attachments.some((a) => a.status === 'loading')
                              }
                              title={
                                attachments.some((a) => a.status === 'loading')
                                  ? 'Waiting for attachment to finish processing…'
                                  : 'Send'
                              }
                              className="size-8 rounded-full"
                            >
                              {/* Always sendable — generating doesn't block; messages queue. */}
                              <svg
                                className="h-4 w-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M5 10l7-7m0 0l7 7m-7-7v18"
                                />
                              </svg>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Send</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Panel>
      </PanelGroup>

      <AnimatePresence>
        {/* Canvas — sandboxed render of a model-generated artifact */}
        {canvasArtifact && (
          <ArtifactCanvas
            key="artifact-canvas"
            artifact={canvasArtifact}
            onClose={() => setCanvasArtifact(null)}
            width={canvasWidth}
            onResize={setCanvasWidth}
          />
        )}

        {/* Skills — view / create / edit reusable instruction packs */}
        {skillsOpen && (
          <SkillsPanel
            key={`skills-${selectedSkillName ?? 'list'}`}
            initialSkillName={selectedSkillName}
            onClose={() => {
              setSkillsOpen(false)
              setSelectedSkillName(undefined)
            }}
            onChanged={() =>
              window.api
                .listSkills()
                .then((listedSkills) => setSkills(Array.isArray(listedSkills) ? listedSkills : []))
                .catch(() => setSkills([]))
            }
          />
        )}

        {modelPickerOpen && (
          <ModelPicker key="model-picker" onClose={() => setModelPickerOpen(false)} />
        )}

        {settingsOpen && (
          <SettingsPanel
            key={`model-settings-${settingsInitialTab}`}
            initialTab={settingsInitialTab}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Attachment viewer — same full-screen overlay layout as the image lightbox
          (floating Download/Close top-right, content centered), for text/PDF/docs.
          Backdrop fades + blurs in; the panel springs up (aceternity modal pattern). */}
      <AnimatePresence>
        {viewer && (
          <motion.div
            key="viewer"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-10 font-mono"
            role="dialog"
            aria-modal="true"
            aria-label={viewer.title}
            tabIndex={-1}
            initial={{ opacity: 0, backdropFilter: 'blur(0px)' }}
            animate={{ opacity: 1, backdropFilter: 'blur(8px)' }}
            exit={{ opacity: 0, backdropFilter: 'blur(0px)' }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            onClick={(event) => {
              if (event.target === event.currentTarget) setViewer(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setViewer(null)
            }}
          >
            <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
              <span className="mr-2 max-w-[40vw] truncate self-center text-xs text-neutral-400">
                {viewer.title}
              </span>
              {viewer.path && (
                <button
                  onClick={() => downloadImage(viewer.path, viewer.title)}
                  className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:border-green-500 hover:text-green-500"
                >
                  Download
                </button>
              )}
              <button
                onClick={() => setViewer(null)}
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:text-white"
              >
                Close
              </button>
            </div>
            {viewer.renderer === 'audio' && viewer.path ? (
              <AudioPane path={viewer.path} title={viewer.title} />
            ) : viewer.renderer === 'document' && viewer.path ? (
              // A document renders from its BYTES. main already serves them as a data URL for
              // exactly this - Chromium draws the PDF itself - and the old code path never called
              // it, so every PDF fell through to the text pane below and showed an empty page.
              <DocumentPane path={viewer.path} title={viewer.title} />
            ) : (
              <motion.pre
                initial={{ opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: 4 }}
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                className="max-h-full w-full max-w-3xl overflow-auto whitespace-pre-wrap break-words rounded-md border border-neutral-800 bg-neutral-950 p-5 text-sm leading-relaxed text-neutral-200"
              >
                {viewer.text}
              </motion.pre>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Lightbox — click a generated image to enlarge, download, or delete. Same
          animated backdrop + spring-in as the viewer (shared modal feel). */}
      <AnimatePresence>
        {lightbox && (
          <motion.div
            key="lightbox"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-10"
            role="dialog"
            aria-modal="true"
            aria-label="Generated image preview"
            tabIndex={-1}
            initial={{ opacity: 0, backdropFilter: 'blur(0px)' }}
            animate={{ opacity: 1, backdropFilter: 'blur(8px)' }}
            exit={{ opacity: 0, backdropFilter: 'blur(0px)' }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            onClick={(event) => {
              if (event.target === event.currentTarget) setLightbox(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setLightbox(null)
            }}
          >
            <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
              {lightbox.path && (
                <>
                  <button
                    onClick={() => downloadImage(lightbox.path, lightbox.path?.split('/').pop())}
                    className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:border-green-500 hover:text-green-500"
                  >
                    Download
                  </button>
                  <button
                    onClick={() => deleteImage(lightbox.path)}
                    className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:border-red-500 hover:text-red-400"
                  >
                    Delete
                  </button>
                </>
              )}
              <button
                onClick={() => setLightbox(null)}
                className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:text-white"
              >
                Close
              </button>
            </div>
            <motion.img
              src={lightbox.url}
              alt="Generated preview"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              className="max-h-full max-w-full rounded-md object-contain"
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Gallery — everything generated on-device: images + artifacts */}
      <AnimatePresence>
        {showGallery && (
          <SidePanel
            key="gallery"
            ariaLabel="Gallery"
            onClose={() => setShowGallery(false)}
            className="w-[min(720px,92vw)] overflow-hidden text-white"
            restoreFocusRef={galleryTriggerRef}
          >
            <header className="flex items-center justify-between border-b border-neutral-900 px-4 py-3 text-left">
              <h2 className="text-sm font-normal text-neutral-200">Gallery</h2>
              <button
                type="button"
                onClick={() => setShowGallery(false)}
                aria-label="Close gallery"
                className="rounded p-1 text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="flex items-center gap-1 border-b border-neutral-900 px-3 py-2">
              {(['images', 'artifacts'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setGalleryTab(tab)}
                  className={`rounded px-3 py-1 text-xs capitalize transition-colors ${galleryTab === tab ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-neutral-300'}`}
                >
                  {tab} {tab === 'images' ? `(${gallery.length})` : `(${artifacts.length})`}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 border-b border-neutral-900 px-3 py-1.5">
              {(['chat', 'project', 'all'] as const).map((sc) => (
                <button
                  key={sc}
                  onClick={() => setGalleryScope(sc)}
                  disabled={sc === 'project' && !activeProjectId}
                  className={`rounded px-2 py-0.5 text-[10px] capitalize transition-colors disabled:opacity-30 ${galleryScope === sc ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-neutral-300'}`}
                >
                  {sc === 'chat' ? 'This chat' : sc}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {galleryTab === 'images' ? (
                gallery.length === 0 ? (
                  <p className="py-10 text-center text-xs text-neutral-600">
                    No images generated yet.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {gallery.map((g) => (
                      <button
                        key={g.path}
                        onClick={() =>
                          setLightbox({ url: captureUrlForPath(g.path), path: g.path })
                        }
                        className="overflow-hidden rounded-md border border-neutral-800 transition-colors hover:border-green-500"
                      >
                        <img
                          src={captureUrlForPath(g.path)}
                          alt={g.name}
                          className="aspect-square w-full object-cover"
                        />
                      </button>
                    ))}
                  </div>
                )
              ) : (
                <>
                  {artifacts.length === 0 ? (
                    <p className="py-10 text-center text-xs text-neutral-600">
                      No artifacts in this {galleryScope === 'all' ? 'app' : galleryScope}.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {artifacts.map((a) => (
                        <div
                          key={a.id}
                          className="group flex items-center gap-2 rounded-md border border-neutral-800 p-2 transition-colors hover:border-green-500"
                        >
                          <button
                            onClick={() =>
                              a.kind === 'image'
                                ? (closePanels(),
                                  setLightbox({ url: captureUrlForPath(a.code), path: a.code }))
                                : a.kind === 'text'
                                  ? (closePanels(), setViewer({ title: a.title, text: a.code }))
                                  : openCanvas({ kind: a.kind, code: a.code, title: a.title })
                            }
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          >
                            {a.kind === 'image' ? (
                              <img
                                src={captureUrlForPath(a.code)}
                                alt=""
                                className="h-8 w-8 shrink-0 rounded-sm border border-neutral-800 object-cover"
                              />
                            ) : (
                              <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-green-500">
                                {a.kind === 'text' ? 'input' : a.kind}
                              </span>
                            )}
                            <span className="truncate text-xs text-neutral-200">{a.title}</span>
                          </button>
                          <button
                            onClick={() => deleteArtifact(a.id)}
                            className="text-neutral-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                            title="Delete"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </SidePanel>
        )}
      </AnimatePresence>
    </div>
  )
}
