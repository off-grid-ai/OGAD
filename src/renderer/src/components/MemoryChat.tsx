import { useCallback, useEffect, useRef, useState } from 'react'
import { shouldQueue, enqueue, dequeue, queuedCount, clearQueue } from '@renderer/lib/chat-queue'
import { buildSendHistory } from '@renderer/lib/chat-history'
import { waitingLabel } from '@renderer/lib/chat-labels'
import { parseSqliteUtc, timeAgo } from '@renderer/lib/time'
import { writeClipboardWithFallback } from '@renderer/lib/clipboard-write'
import { motion, AnimatePresence } from 'motion/react'
import { toSpeakableText } from '@renderer/lib/speakable'
import { isAgenticTurn } from '@renderer/lib/agentic-active'
import { applyStreamEvent } from '@renderer/lib/stream-reducer'
import { useActiveModelSummary } from '@renderer/hooks/useActiveModelSummary'
import { shouldFollowBottom } from '@renderer/lib/scroll-follow'
import {
  chatListPreviewLine,
  projectSyncedMessageTurn,
  type ProjectedSyncedTool,
  type RecordProvenance,
  type SyncedMessageRole,
  type SyncedTurnStatus
} from '@offgrid/sync'
import ReactMarkdown, { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { getSlot, SLOTS } from '@/bootstrap/slotRegistry'
import { ArtifactCanvas, parseArtifact, type Artifact } from './ArtifactCanvas'
import { VoiceBubble, stopAllVoicePlayback } from './VoiceBubble'
import { SkillsPanel } from './SkillsPanel'
import { ModelPicker } from './ModelPicker'
import { SettingsPanel } from './SettingsPanel'
import { ConversationTitleActions } from './ConversationTitleActions'
import { resolveImageParams, setOverride, type ImageParamStore } from '@renderer/lib/image-params'
import { IMAGE_SETTINGS_CHANGED_EVENT } from '@renderer/lib/image-settings-events'
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
import {
  parseImageMemoryGuardError,
  type ImageGenerationJobContract,
  type ImageGenerationRequestContract
} from '../../../shared/image-generation-contract'
import { Button } from '@renderer/components/ui/button'
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
import {
  Plus,
  Paperclip,
  Image as ImageIcon,
  Sparkle as Sparkles,
  FolderPlus,
  Wrench,
  MagnifyingGlass as Search,
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

type RagContext = {
  masterMemory?: string | null
  memories?: any[]
  messages?: any[]
  summaries?: any[]
  entities?: any[]
  entityFacts?: any[]
  unified?: {
    kind: string
    title: string
    snippet: string
    surface: string
    ts: number
    refId?: number
    imagePath?: string | null
  }[]
  image?: string
  imageMetadata?: ImageGenerationMetadata
  sources?: { name: string; position: number; score: number }[]
  attachments?: { name: string; kind: string; text?: string; path?: string }[]
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

type ChatMode = 'ask' | 'image'

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
  if (a.kind === 'running_tool') return `Running ${a.name || 'tool'}…`
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

type Conversation = RagConversationContract

type ProjectLite = { id: string; name: string }

interface MemoryChatProps {
  onNavigateToMemory?: (memoryId: number) => void
  onNavigateToChat?: (sessionId: string) => void
  onNavigateToEntity?: (entityId: number) => void
  /** Open the Projects screen focused on this chat's linked project. */
  onOpenProject?: (projectId: string) => void
  /** Open the Replay screen seeked to a capture's moment (epoch ms). */
  onSeekReplay?: (ts: number) => void
  /** Open a specific conversation, or start a new one scoped to a project. */
  openTarget?: { conversationId?: string; projectId?: string; openGallery?: boolean } | null
  onTargetConsumed?: () => void
}

function mapRagMessages(raw: any[]): ChatMessage[] {
  return raw.flatMap((m: any) => {
    let ctx: RagContext | undefined
    if (m.context && typeof m.context === 'string') {
      try {
        ctx = JSON.parse(m.context) as RagContext
      } catch {
        ctx = undefined
      }
    } else if (m.context && typeof m.context === 'object') {
      ctx = m.context as RagContext
    }
    const provenance =
      typeof m.origin_device_id === 'string' && typeof m.origin_device_name === 'string'
        ? {
            originDeviceId: m.origin_device_id,
            originDeviceName: m.origin_device_name
          }
        : undefined
    const turn = projectSyncedMessageTurn({
      id: String(m.uuid ?? m.id),
      role: m.role,
      content: m.content,
      context: m.context,
      createdAt: m.created_at,
      provenance
    })
    if (!turn) return []
    // Mobile tool turns can persist a delimiter-only intermediate assistant row before the
    // tool result and final answer. It carries no thought content and must not become a visible
    // "<think> </think>" bubble on Desktop.
    // A turn with nothing in it is not a bubble. Mobile's tool loop persists a delimiter-only
    // assistant row before the tool result and the final answer; it used to arrive as the literal
    // "<think></think>" and was matched as that string. The shared projection now splits inline
    // reasoning out, so the same row arrives empty instead - test emptiness, which covers both and
    // any other way a turn can carry nothing.
    if (turn.role === 'assistant' && !turn.content.trim() && turn.reasoning === undefined) {
      return []
    }
    const imageReference = readGeneratedImageReference(ctx)
    return [
      {
        id: turn.id,
        role: turn.role,
        // The cleaned view: `content` stays verbatim for hosts that store it back.
        content: turn.role === 'assistant' ? (turn.answer ?? turn.content) : turn.content,
        context: ctx,
        // Reasoning rides in the context blob so the "Thinking" block survives reload.
        reasoning: turn.reasoning ?? readReasoning(ctx),
        cutoff: readResponseCutoff(ctx),
        toolCalls: turn.role === 'assistant' && turn.tools.length > 0 ? turn.tools : undefined,
        toolName: turn.role === 'tool' ? turn.tools[0]?.name : undefined,
        toolCallId: turn.role === 'tool' ? turn.tools[0]?.id : undefined,
        turnStatus: turn.status,
        notice: turn.notice,
        reasoningLabel: turn.reasoningLabel,
        generationTimeMs: turn.role === 'tool' ? turn.tools[0]?.durationMs : turn.durationMs,
        provenance: turn.provenance,
        // Read through the one reader, so a row that names its image on the mesh and a row that
        // only remembers a path both render, and neither is decoded here.
        image: imageReference ? `ogcapture://${imageReference.path}` : undefined,
        imagePath: imageReference?.path,
        imageMetadata: ctx?.imageMetadata,
        // Attachments persisted on the user turn (clickable chips survive reload).
        attachments: Array.isArray(ctx?.attachments) ? ctx.attachments : undefined
      }
    ]
  })
}

function ImageMetadata({
  metadata
}: {
  metadata?: ImageGenerationMetadata
}): React.JSX.Element | null {
  if (!metadata) return null
  return (
    <p aria-label="Image generation metadata" className="mt-1.5 text-[10px] text-neutral-600">
      {metadata.width} × {metadata.height} · {metadata.steps} steps · CFG {metadata.cfgScale} · seed{' '}
      {metadata.seed}
      {metadata.model ? ` · ${metadata.model}` : ''}
    </p>
  )
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

// Gemini-style visual style presets — pick one, then describe the subject; the
// style text is appended to the prompt. `swatch` = a characteristic gradient so
// the gallery is pictorial (no bundled images needed).
// `prompt` = style modifier appended to the user's subject when generating.
// `preview` = the subject used for the on-device style-thumbnail (varied per
// style so the grid showcases the style, not a gallery of faces).
const STYLE_PRESETS: { name: string; prompt: string; preview: string; swatch: string }[] = [
  {
    name: 'Photoreal',
    prompt: 'photorealistic, sharp focus, high detail, 50mm photo',
    preview: 'a red fox standing in a misty forest',
    swatch: 'from-stone-400 to-stone-600'
  },
  {
    name: 'Cinematic',
    prompt: 'cinematic film still, dramatic lighting, shallow depth of field, color graded',
    preview: 'a lone car on a coastal highway at sunset',
    swatch: 'from-orange-800 via-neutral-800 to-teal-800'
  },
  {
    name: 'Anime',
    prompt: 'anime illustration, clean lineart, vibrant colors',
    preview: 'a bustling futuristic city street with cherry blossoms',
    swatch: 'from-pink-400 via-purple-400 to-sky-400'
  },
  {
    name: 'Sketch',
    prompt: 'detailed pencil sketch on paper, monochrome line art',
    preview: 'an old european cathedral',
    swatch: 'from-neutral-300 to-neutral-500'
  },
  {
    name: 'Watercolor',
    prompt: 'watercolor painting, soft washes, paper texture',
    preview: 'a serene mountain lake with pine trees',
    swatch: 'from-rose-300 via-sky-200 to-emerald-300'
  },
  {
    name: 'Oil painting',
    prompt: 'oil painting, visible brushstrokes, classical, rich color',
    preview: 'a still life of fruit and a wine bottle on a table',
    swatch: 'from-amber-700 via-red-800 to-yellow-700'
  },
  {
    name: 'Monochrome',
    prompt: 'black and white, high contrast, monochrome',
    preview: 'a rainy city street with umbrellas',
    swatch: 'from-neutral-900 to-neutral-500'
  },
  {
    name: 'Neon',
    prompt: 'neon-lit cyberpunk, glowing lights, night, moody',
    preview: 'a rain-soaked alley in a cyberpunk city',
    swatch: 'from-fuchsia-600 via-purple-700 to-cyan-500'
  },
  {
    name: '3D render',
    prompt: '3D render, octane, soft studio lighting, subsurface detail',
    preview: 'a cute friendly robot character',
    swatch: 'from-slate-300 via-slate-500 to-slate-700'
  },
  {
    name: 'Steampunk',
    prompt: 'steampunk, brass and gears, victorian, intricate',
    preview: 'a flying steampunk airship above the clouds',
    swatch: 'from-amber-800 via-yellow-900 to-stone-700'
  },
  {
    name: 'Surreal',
    prompt: 'surreal, dreamlike, imaginative composition',
    preview: 'floating islands with waterfalls in a dreamlike sky',
    swatch: 'from-indigo-500 via-fuchsia-500 to-amber-400'
  },
  {
    name: 'Vintage film',
    prompt: 'vintage film photograph, faded colors, grain, 1970s',
    preview: 'a vintage convertible car on a desert road',
    swatch: 'from-amber-300 via-orange-300 to-rose-300'
  },
  {
    name: 'Minimal',
    prompt: 'minimal flat design, clean, simple shapes, lots of negative space',
    preview: 'a single sailboat on calm water',
    swatch: 'from-neutral-100 to-neutral-300'
  },
  {
    name: 'Risograph',
    prompt: 'risograph print, halftone texture, limited palette',
    preview: 'a bicycle leaning against a wall',
    swatch: 'from-pink-500 via-yellow-400 to-blue-500'
  },
  {
    name: 'Fantasy art',
    prompt: 'epic fantasy concept art, dramatic, highly detailed',
    preview: 'a majestic dragon perched on a mountain peak',
    swatch: 'from-purple-800 via-indigo-700 to-amber-600'
  },
  {
    name: 'Studio portrait',
    prompt: 'studio portrait, soft key light, bokeh background',
    preview: 'a golden retriever dog',
    swatch: 'from-neutral-600 via-neutral-800 to-neutral-900'
  }
]

const NEW_CHAT = '__new__' // bucket key for a fresh, not-yet-saved conversation
const EMPTY_MSGS: ChatMessage[] = []

export function MemoryChat({
  onNavigateToMemory,
  onNavigateToChat,
  onNavigateToEntity,
  onOpenProject,
  onSeekReplay,
  openTarget,
  onTargetConsumed
}: MemoryChatProps) {
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
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Whether the active chat model can read images. Gate image attachment on this and
  // re-check periodically (the user can switch models from the Models screen).
  const [chatVision, setChatVision] = useState(true)
  const [attachWarn, setAttachWarn] = useState<string | null>(null)
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
  // Active tab's messages (derived) + a shim so the existing active-conversation call
  // sites keep working. The send path targets its own conv via setConvMessages instead.
  const messages = messagesByConv[activeConversationId ?? NEW_CHAT] ?? EMPTY_MSGS
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
  const [genThumbsBusy, setGenThumbsBusy] = useState(false)
  const [imgProgress, setImgProgress] = useState<{
    step: number
    total: number
    secPerStep: number
    preview?: string
    phase?: 'sampling' | 'decoding'
  } | null>(null)
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isPro = !!(window as any).api?.isPro
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
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [microphoneDenied, setMicrophoneDenied] = useState(false)
  // Surfaced when a recording can't become a message (no audio, empty transcript, or a
  // transcription-engine failure) — never fail silently (the "nothing happened" bug).
  const [transcribeError, setTranscribeError] = useState<string | null>(null)
  const [toolsOn, setToolsOn] = useState(false)
  const [connectorsOn, setConnectorsOn] = useState(false)
  const [thinkingEnabled, setThinkingEnabled] = useState(false)
  const [voiceMode, setVoiceMode] = useState(false) // voice mode: messages exchanged as voice notes
  useEffect(() => {
    if (!voiceMode) stopAllVoicePlayback()
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
        if (typeof s.composerVoiceMode === 'boolean') setVoiceMode(s.composerVoiceMode)
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
  } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [lightbox, setLightbox] = useState<{ url: string; path?: string } | null>(null)
  // Rows pro appends after the message list, e.g. a peer's live reply. Empty in the free build.
  const ChatMessagesFooter = getSlot(SLOTS.chatMessagesFooter)
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
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
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
      const recorder = recorderRef.current
      recorderRef.current = null
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null
        try {
          recorder.stop()
        } catch {
          /* already stopped */
        }
      }
      micStreamRef.current?.getTracks().forEach((track) => track.stop())
      micStreamRef.current = null
      chunksRef.current = []
    }
  }, [])

  const markdownComponents: Components = {
    p: ({ children }) => <p style={{ margin: 0 }}>{children}</p>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer" className="text-green-500 underline">
        {children}
      </a>
    ),
    code: ({ children, ...props }) => {
      const inline = !('className' in props)
      return (
        <code
          className={`font-mono text-[0.9em] bg-neutral-800/60 rounded ${inline ? 'px-1 py-0.5' : 'block px-2.5 py-2 overflow-x-auto'}`}
        >
          {children}
        </code>
      )
    },
    pre: ({ children }) => <pre style={{ margin: 0 }}>{children}</pre>
  }

  // Citation-aware markdown components: `[S2]` in an answer is rewritten to a
  // cite: link and rendered as a clickable chip that opens the exact source it
  // cites (memory / entity / meeting). Falls back to a normal link otherwise.
  const makeCiteComponents = (unified?: RagContext['unified']): Components =>
    ({
      ...markdownComponents,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      a: ({ href, children }: any) => {
        const m = typeof href === 'string' ? /^cite:(\d+)$/.exec(href) : null
        if (m && unified) {
          const u = unified[parseInt(m[1]!, 10) - 1]
          return (
            <button
              type="button"
              onClick={() => {
                if (!u) return
                if (u.kind === 'screen') onSeekReplay?.(u.ts)
                else if (u.refId == null) return
                else if (u.kind === 'memory') onNavigateToMemory?.(u.refId)
                else if (u.kind === 'entity') onNavigateToEntity?.(u.refId)
                else if (u.kind === 'meeting') onNavigateToChat?.(String(u.refId))
              }}
              title={u ? `${u.kind} · ${u.surface}${u.title ? ' · ' + u.title : ''}` : 'source'}
              className="mx-0.5 inline-flex items-center rounded-sm border border-green-500/40 bg-green-500/10 px-1 align-baseline text-[0.72em] font-semibold text-green-500 transition-colors hover:bg-green-500/20"
            >
              {children}
            </button>
          )
        }
        return (
          <a href={href} target="_blank" rel="noreferrer" className="text-green-500 underline">
            {children}
          </a>
        )
      }
    }) as Components

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
      const models = s.models || []
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
          setConvMessages(first.id, mapRagMessages(await window.api.getRagMessages(first.id)))
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

  const styleKey = (name: string): string => name.replace(/[^\w-]+/g, '_')

  // Generate on-device preview thumbnails for any styles that don't have one yet.
  const generateStylePreviews = useCallback(async () => {
    if (genThumbsBusy) return
    setGenThumbsBusy(true)
    try {
      for (const s of STYLE_PRESETS) {
        const k = styleKey(s.name)
        if (styleThumbs[k]) continue
        try {
          await window.api.makeStyleThumb?.(s.name, `${s.preview}, ${s.prompt}`)
          const refreshed = await window.api.styleThumbs?.()
          if (refreshed) setStyleThumbs(refreshed)
        } catch (e) {
          console.error('style thumb failed', s.name, e)
        }
      }
    } finally {
      setGenThumbsBusy(false)
    }
  }, [genThumbsBusy, styleThumbs])

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

  // Live per-step image generation progress (step counter + forming preview).
  useEffect(() => {
    const off = window.api.onImageGenProgress?.((p) => setImgProgress(p))
    return () => off?.()
  }, [])

  const refreshConversationMessages = useCallback(async (conversationId: string): Promise<void> => {
    const rawMessages = await window.api.getRagMessages(conversationId)
    setMessagesByConv((prev) => ({
      ...prev,
      [conversationId]: mapRagMessages(rawMessages)
    }))
  }, [])

  // Image jobs survive this component. Subscribe before reading the snapshot so a
  // navigation/remount cannot miss the transition between status and observation.
  // Cleanup only detaches observers; explicit Stop is the sole cancellation path.
  useEffect(() => {
    let live = true
    const observe = (job: ImageGenerationJobContract): void => {
      if (!live || !job.conversationId) return
      if (job.phase === 'running') {
        setImageGenConv(job.conversationId)
        setImgProgress(job.progress)
        // Restore the SAME render gate the live-gen path sets (markGenerating). Without this a
        // remount mid-generation left imageGenConv set but generatingConvs empty, so the progress
        // panel (gated on generatingConvs) stayed invisible — the "it generated but the UI didn't
        // show it" bug. Reattaching must reflect the whole in-flight UI, not just the owner.
        markGenerating(job.conversationId, true)
        return
      }
      setImageGenConv((owner) => (owner === job.conversationId ? null : owner))
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

  const loadConversations = async () => {
    try {
      const convos = await window.api.getRagConversations()
      setConversations(convos)
    } catch (e) {
      console.error('Failed to load conversations:', e)
    }
  }

  const switchConversation = useCallback(
    async (convId: string) => {
      setOpenTabs((t) => (t.includes(convId) ? t : [...t, convId]))
      if (convId === activeConversationId) return
      setActiveConversationId(convId)
      setActiveProjectId(conversations.find((c) => c.id === convId)?.project_id ?? null)
      try {
        const rawMessages = await window.api.getRagMessages(convId)
        // Refresh from DB, but never clobber an in-flight stream for this conversation.
        setMessagesByConv((prev) =>
          prev[convId]?.some((m) => m.streaming)
            ? prev
            : { ...prev, [convId]: mapRagMessages(rawMessages) }
        )
      } catch (e) {
        console.error('Failed to load messages:', e)
        setMessagesByConv((prev) => (prev[convId] ? prev : { ...prev, [convId]: [] }))
      }
    },
    [activeConversationId, conversations]
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
            !generatingConvs.has(conversationId)
          ) {
            setConvMessages(
              conversationId,
              mapRagMessages(await window.api.getRagMessages(conversationId))
            )
          }
          await loadConversations()
        } catch (error) {
          console.error('Failed to refresh a synced conversation:', error)
        }
      })()
    })
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, generatingConvs])

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
          setConvMessages(convId, mapRagMessages(await window.api.getRagMessages(convId)))
        } else if (openTarget.projectId) {
          setActiveConversationId(null)
          setConvMessages(null, [])
          setActiveProjectId(openTarget.projectId)
        }
        if (openTarget.openGallery) setShowGallery(true)
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
        const assistantMessage: ChatMessage = {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: `Generated for: ${trimmed}`,
          image: img.dataUrl,
          imagePath: img.path,
          imageMetadata
        }
        setConvMessages(convId, (prev) => [...prev, assistantMessage])
        try {
          const stored = await window.api.addRagMessage(
            convId,
            'assistant',
            `Generated for: ${trimmed}`,
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
        const toolCalls = (tr?.toolCalls || []).map((c: { name: string; result: string }) => ({
          name: c.name,
          result: c.result
        }))
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
        if (voiceMode) setAutoPlayId(toolStreamId)
        // Deferred image generation: the tool loop only RECORDS the prompt (it never
        // generates inline, which would evict the LLM). Generate + attach here AFTER
        // the text turn - same path as the ```image fence block below.
        if (
          tr?.imageRequest?.prompt &&
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
            const img = await window.api.generateImage({
              prompt: tr.imageRequest.prompt,
              conversationId: convId,
              projectId: projectId
            })
            setConvMessages(convId, (prev) =>
              prev.map((m) =>
                m.id === toolStreamId ? { ...m, image: img.dataUrl, imagePath: img.path } : m
              )
            )
            try {
              const stored = await window.api.addRagMessage(
                convId,
                'assistant',
                answer,
                withGeneratedImageReference(toolCtxWithReasoning ?? {}, {
                  id: img.syncId,
                  path: img.path
                })
              )
              await announceImageMessagePersisted(convId, stored.uuid)
            } catch {
              /* ignore */
            }
          } catch (e) {
            // Persist the TEXT answer regardless of why the image failed — including
            // a cancel. The text turn already finished and is on screen; a cancelled
            // (or failed) IMAGE must not drop it, or it vanishes on reload (D12). Only
            // the image is lost.
            void e
            try {
              await window.api.addRagMessage(convId, 'assistant', answer, toolCtxWithReasoning)
            } catch {
              /* ignore */
            }
          } finally {
            setImgProgress(null)
            setImageGenConv((owner) => (owner === convId ? null : owner))
          }
          return
        }
        try {
          await window.api.addRagMessage(convId, 'assistant', answer, toolCtxWithReasoning)
        } catch {
          /* ignore */
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
          setConvMessages(convId, (prev) =>
            prev.map((m) =>
              m.id === streamId
                ? {
                    ...m,
                    content: `Generated: ${imgPrompt.slice(0, 80)}`,
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
              `Generated: ${imgPrompt.slice(0, 80)}`,
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
        if (voiceMode) setAutoPlayId(streamId)
        try {
          await window.api.addRagMessage(
            convId,
            'assistant',
            assistantContent,
            buildAssistantContext(resultContext, {
              reasoning: ragReasoning,
              cutoff: result.cutoff
            })
          )
        } catch (e) {
          console.error('Failed to persist assistant message:', e)
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
      const errorContent = 'Sorry, something went wrong while generating a response.'
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
    (cid: string | null): void => {
      const convId = cid ?? activeConversationId
      if (!convId) return
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

  // Voice input: record from the mic, transcribe on-device with whisper, then
  // drop the text into the input for review (not auto-sent).
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      setMicrophoneDenied(false)
      setTranscribeError(null)
      if (!voiceMountedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      micStreamRef.current = stream
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      const startedAt = Date.now()
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        if (micStreamRef.current === stream) micStreamRef.current = null
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        if (blob.size === 0) {
          setTranscribeError("Didn't record any audio — try again.")
          return
        }
        setTranscribing(true)
        try {
          const bytes = new Uint8Array(await blob.arrayBuffer())
          const text = await window.api.transcribeAudio(bytes, 'webm')
          const clean = (text || '').trim()
          if (!clean) {
            // Empty transcript: surface it instead of dropping the recording silently
            // (the old code returned here with no feedback — the "nothing happened" bug).
            setTranscribeError("Didn't catch that — try recording again.")
            return
          }
          if (voiceMode) {
            // Voice mode: send the spoken note straight away, keeping the recording
            // so the user's bubble plays back their own audio.
            const url = URL.createObjectURL(blob)
            void sendMessage(clean, {
              voiceClip: { url, duration: (Date.now() - startedAt) / 1000 }
            })
          } else {
            setInput((prev) => (prev ? prev + ' ' : '') + clean)
          }
        } catch (err) {
          console.error('Transcription failed', err)
          setTranscribeError(
            'Transcription failed. Check the voice model in Settings > Setup & health.'
          )
        } finally {
          setTranscribing(false)
        }
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
    } catch (err) {
      console.error('Mic access failed', err)
      const name =
        typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : undefined
      setMicrophoneDenied(name === 'NotAllowedError' || name === 'SecurityError')
      setRecording(false)
    }
  }

  const stopRecording = () => {
    recorderRef.current?.stop()
    recorderRef.current = null
    setRecording(false)
  }

  const toggleRecording = () => {
    recording ? stopRecording() : startRecording()
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

  // Reload the gallery's artifacts whenever the scope changes while it's open.
  useEffect(() => {
    if (showGallery) void refreshGallery()
  }, [galleryScope, showGallery, refreshGallery])

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
      .then((s) => setSkills(s))
      .catch(() => {})
  }, [])

  // Live streaming: route token/reasoning events to the in-flight assistant
  // message (matched by streamId === message id) so it fills in as it generates.
  // Use streamConvRef to find the right conversation — setMessages is stale in a
  // [] effect because it captures activeConversationId at mount time.
  useEffect(() => {
    const off = window.api.onRagStream((data) => {
      const cid = streamConvRef.current.get(data.streamId)
      if (!cid) return
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
    return () => off()
  }, [setConvMessages])

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
          setMessages((prev) => prev.slice(0, i + 1))
          if (activeConversationId) void window.api.truncateRagMessages(activeConversationId, i + 1)
          void sendMessage(content, { regen: true })
          return
        }
      }
    },
    [messages]
  )

  // Edit a sent message: replace its text, drop everything after it, re-run.
  const saveEdit = useCallback(
    (id: string) => {
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
      const cid = activeConversationId
      if (cid)
        void window.api
          .truncateRagMessages(cid, idx)
          .then(() => window.api.addRagMessage(cid, 'user', text))
      void sendMessage(text, { regen: true })
    },
    [editText, messages, activeConversationId]
  )

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
          // Images are "ready" if we have the file path (even with no caption), so the
          // actual image still gets sent to the vision model.
          const ok = !!res.text || (res.kind === 'image' && !!res.path)
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

  const examples = mode === 'image' ? IMAGE_EXAMPLES : isPro ? ASK_EXAMPLES_PRO : ASK_EXAMPLES

  // Slash-command autocomplete: typing "/" (before any space) lists matching skills.
  const slashQuery =
    mode === 'ask' && input.startsWith('/') && !/\s/.test(input)
      ? input.slice(1).toLowerCase()
      : null
  const skillMatches =
    slashQuery !== null ? skills.filter((s) => s.name.toLowerCase().includes(slashQuery)) : []

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
        <button
          onClick={() => setVoiceMode((v) => !v)}
          className={`rounded-md border p-1.5 transition-colors ${voiceMode ? 'border-green-500 text-green-500' : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'}`}
          title={voiceMode ? 'Voice mode on — speak and listen in voice notes' : 'Voice mode off'}
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
        </button>
        <button
          onClick={() => setShowHistory((prev) => !prev)}
          className={`rounded-md border p-1.5 transition-colors ${showHistory ? 'border-neutral-700 text-neutral-300' : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'}`}
          title={showHistory ? 'Collapse sidebar (full-screen chat)' : 'Show conversations'}
        >
          {/* Sidebar / panel-left icon — collapse the conversation rail */}
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="16" rx="2" strokeWidth={2} />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 4v16" />
          </svg>
        </button>
      </header>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* History rail — animated collapse (width slides to 0) */}
        <aside
          className={`shrink-0 overflow-hidden border-neutral-900 transition-[width] duration-300 ease-in-out ${showHistory ? 'w-64 border-r' : 'w-0'}`}
        >
          <div className="flex h-full w-64 flex-col">
            <div className="p-3">
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
                      (c) => (c.title || '').toLowerCase().includes(q) || contentMatchIds.has(c.id)
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
                const now = new Date()
                const startToday = new Date(
                  now.getFullYear(),
                  now.getMonth(),
                  now.getDate()
                ).getTime()
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
                    parseSqliteUtc(b.updated_at).getTime() - parseSqliteUtc(a.updated_at).getTime()
                )
                for (const c of ordered) {
                  const t = parseSqliteUtc(c.updated_at).getTime()
                  if (t >= startToday) groups[0]!.items.push(c)
                  else if (t >= startToday - 86400000) groups[1]!.items.push(c)
                  else if (t >= startToday - 6 * 86400000) groups[2]!.items.push(c)
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

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
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
              <div
                className={`mx-auto flex min-h-full flex-col items-center justify-center px-6 py-6 text-center ${mode === 'image' ? 'max-w-6xl' : 'max-w-2xl'}`}
              >
                <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-900 shadow-sm">
                  <svg
                    className="h-8 w-8 text-green-500"
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
                <h2 className="text-3xl font-semibold tracking-tight text-neutral-100">
                  {mode === 'image' ? 'Create an image' : 'Start a conversation'}
                </h2>
                <p className="mt-3 max-w-md text-sm text-neutral-500">
                  {mode === 'image'
                    ? 'Pick a style, then describe your subject — generated on-device.'
                    : activeProjectName
                      ? `Grounded in the “${activeProjectName}” knowledge base.`
                      : isPro
                        ? 'Ask across your memories, chats, and entities from every source.'
                        : 'Ask anything, generate images, or build — all on-device.'}
                </p>
                {mode === 'image' ? (
                  <div className="mt-4 w-full">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider text-neutral-600">
                        Style
                      </span>
                      {Object.keys(styleThumbs).length < STYLE_PRESETS.length && (
                        <button
                          onClick={generateStylePreviews}
                          disabled={genThumbsBusy}
                          className="text-[10px] text-neutral-500 transition-colors hover:text-green-500 disabled:opacity-50"
                        >
                          {genThumbsBusy ? 'Generating previews…' : 'Generate previews'}
                        </button>
                      )}
                    </div>
                    <div className="grid w-full grid-cols-2 gap-2.5 sm:grid-cols-4">
                      {STYLE_PRESETS.map((s) => {
                        const thumb = styleThumbs[styleKey(s.name)]
                        return (
                          <button
                            key={s.name}
                            onClick={() =>
                              setActiveStyle((cur) => (cur === s.name ? null : s.name))
                            }
                            className={`group relative aspect-[16/9] overflow-hidden rounded-md border transition-all ${
                              activeStyle === s.name
                                ? 'border-green-500 ring-1 ring-green-500'
                                : 'border-neutral-800 hover:border-neutral-600'
                            }`}
                          >
                            {thumb ? (
                              <img
                                src={`ogcapture://${thumb}`}
                                alt={s.name}
                                className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                              />
                            ) : (
                              <span
                                className={`absolute inset-0 bg-gradient-to-br ${s.swatch} transition-transform duration-300 group-hover:scale-105`}
                              />
                            )}
                            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5 text-left text-[11px] font-medium text-white">
                              {s.name}
                            </span>
                            {activeStyle === s.name && (
                              <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-green-500 text-neutral-950">
                                <svg
                                  className="h-3 w-3"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={3}
                                    d="M5 13l4 4L19 7"
                                  />
                                </svg>
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="mt-6 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                    {examples.map((ex) => (
                      <button
                        key={ex}
                        onClick={() => sendMessage(ex)}
                        className="rounded-md border border-neutral-800 px-3 py-2.5 text-left text-xs text-neutral-400 transition-colors hover:border-green-500 hover:text-neutral-200"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="w-full px-6 py-5">
                {messages.map((message) =>
                  /* A runtime notice is not somebody speaking, so it gets no bubble and no side:
                     a centred muted line in the timeline, the same shape the phone draws. Checked
                     before voice mode for the same reason the phone checks it first - a notice
                     reads as a notice whichever way the conversation is being shown. */
                  message.notice ? (
                    <div key={message.id} className="mb-4 flex justify-center">
                      <span className="px-3 text-center text-[11px] leading-relaxed text-neutral-500">
                        {noticeText(message.content)}
                      </span>
                    </div>
                  ) : voiceMode && message.role !== 'tool' ? (
                    <div
                      key={message.id}
                      className={`mb-4 flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}
                    >
                      {(() => {
                        if (message.role === 'user') {
                          return (
                            <VoiceBubble
                              messageId={message.id}
                              isUser
                              transcript={messageToSpeakable(message.content)}
                              audioUrl={message.audioUrl}
                              durationSeconds={message.audioDuration}
                              synthesize={(t) => window.api.speak(t)}
                              onCopy={copyText}
                            />
                          )
                        }
                        // Generated image in voice mode: show the image, no audio bubble.
                        if (message.image) {
                          return (
                            <div>
                              <img
                                src={message.image}
                                alt="Generated"
                                onClick={() =>
                                  setLightbox({
                                    url: message.image as string,
                                    path: message.imagePath
                                  })
                                }
                                className="max-w-[20rem] cursor-zoom-in rounded-md border border-neutral-800 transition-opacity hover:opacity-90"
                              />
                              <ImageMetadata metadata={message.imageMetadata} />
                            </div>
                          )
                        }
                        const transcript = messageToSpeakable(
                          message.variants && message.variantIndex != null
                            ? message.variants[message.variantIndex]!
                            : message.content
                        )
                        return (
                          <VoiceBubble
                            messageId={message.id}
                            transcript={transcript}
                            isLoading={!!message.streaming}
                            autoPlay={autoPlayId === message.id}
                            synthesize={(t) => window.api.speak(t)}
                            onCopy={copyText}
                            onRetry={() => regenerate(message.id)}
                          />
                        )
                      })()}
                    </div>
                  ) : (
                    <div
                      key={message.id}
                      className={`mb-5 flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}
                    >
                      {message.role === 'assistant' &&
                      !message.streaming &&
                      message.reasoning &&
                      message.reasoning.trim() ? (
                        <Collapsible className="mb-1.5 max-w-[85%]">
                          <CollapsibleTrigger className="group flex items-center gap-1.5 text-[11px] text-neutral-500 transition-colors hover:text-neutral-300">
                            <svg
                              className="h-3 w-3 text-neutral-600"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M9.663 17h4.673M12 3a6 6 0 00-3.6 10.8c.3.225.45.6.45.975V16.5h6.3v-1.725c0-.375.15-.75.45-.975A6 6 0 0012 3z"
                              />
                            </svg>
                            {message.reasoningLabel ?? 'Thought process'}
                            <svg
                              className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 9l-7 7-7-7"
                              />
                            </svg>
                          </CollapsibleTrigger>
                          <CollapsibleContent className="mt-1 whitespace-pre-wrap border-l-2 border-neutral-800 pl-3 text-xs leading-relaxed text-neutral-500">
                            {message.reasoning}
                          </CollapsibleContent>
                        </Collapsible>
                      ) : null}
                      {/* Live thinking + tool activity, ABOVE the answer bubble: reasoning
                        first (Thinking…), then the current tool-call step (Running <tool>…). */}
                      {message.role === 'assistant' && message.streaming ? (
                        <div className="mb-1.5 flex flex-col gap-1.5">
                          <span className="inline-flex gap-1 text-green-500">
                            <span className="animate-bounce [animation-delay:-0.3s]">●</span>
                            <span className="animate-bounce [animation-delay:-0.15s]">●</span>
                            <span className="animate-bounce">●</span>
                          </span>
                          {message.reasoning && message.reasoning.trim() ? (
                            <Collapsible defaultOpen className="max-w-[85%]">
                              <CollapsibleTrigger className="group flex items-center gap-1.5 text-[11px] text-neutral-500 transition-colors hover:text-neutral-300">
                                <span>Thinking…</span>
                                <svg
                                  className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M19 9l-7 7-7-7"
                                  />
                                </svg>
                              </CollapsibleTrigger>
                              <CollapsibleContent className="mt-1 whitespace-pre-wrap border-l-2 border-neutral-800 pl-3 text-xs leading-relaxed text-neutral-500">
                                {message.reasoning}
                              </CollapsibleContent>
                            </Collapsible>
                          ) : null}
                          {activityLabel(message.activity) ? (
                            <span className="text-[11px] text-neutral-500">
                              {activityLabel(message.activity)}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {/* Tool calls as their own entry, between thinking and the answer bubble.
                        search_memory is shown as interactive Source cards below, so skip its chip. */}
                      {(() => {
                        const chips = (message.toolCalls || []).filter(
                          (tc) => tc.name !== 'search_memory'
                        )
                        return chips.length > 0 ? (
                          <div className="mb-1.5 flex max-w-[85%] flex-wrap gap-1">
                            {chips.map((tc, i) => (
                              <button
                                key={i}
                                type="button"
                                onClick={() => {
                                  closePanels()
                                  setViewer({
                                    title: `${tc.name} — tool result`,
                                    text: tc.result,
                                    kind: 'tool'
                                  })
                                }}
                                title="Click to view the full result"
                                className="cursor-pointer rounded-sm border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-green-500/60 hover:text-neutral-300 active:scale-95"
                              >
                                {tc.name} →{' '}
                                {tc.result.length > 32 ? tc.result.slice(0, 32) + '…' : tc.result}
                              </button>
                            ))}
                          </div>
                        ) : null
                      })()}
                      <div
                        className={
                          // An assistant turn with no answer draws no bubble - not while it is
                          // streaming, and not when it finishes that way either. A reply that is
                          // ALL reasoning ends up here: the thinking has its own block above, and
                          // this box would be an empty rounded rectangle underneath it. The image
                          // and the retry card live inside this box, so a turn carrying one keeps
                          // its bubble even with no text.
                          message.role === 'assistant' &&
                          !message.content.trim() &&
                          !message.image &&
                          !message.imageMemoryRetry
                            ? 'hidden'
                            : `rounded-md px-3.5 py-2.5 text-sm leading-relaxed ${
                                // While editing, expand to a full, usable width instead
                                // of hugging the (often short) message — otherwise the
                                // textarea + buttons are crammed into a narrow bubble.
                                editingId === message.id ? 'w-full max-w-2xl' : 'max-w-[85%]'
                              } ${
                                message.role === 'user'
                                  ? 'bg-neutral-800 text-neutral-100'
                                  : 'border border-neutral-800 bg-neutral-900/40 text-neutral-200'
                              }`
                        }
                      >
                        {message.role === 'tool' ? (
                          <div className="mb-2 flex items-center gap-2 border-b border-neutral-800 pb-2 text-[11px]">
                            <Wrench className="h-3.5 w-3.5 text-green-500" />
                            <span className="font-medium text-neutral-300">
                              {message.toolName || 'Tool result'}
                            </span>
                            <span className="text-neutral-600">
                              {message.turnStatus === 'failed' ? 'Failed' : 'Completed'}
                              {message.generationTimeMs !== undefined
                                ? ` in ${Math.round(message.generationTimeMs)} ms`
                                : ''}
                            </span>
                          </div>
                        ) : null}
                        {message.attachments && message.attachments.length > 0 ? (
                          <div className="mb-2 flex flex-wrap gap-1.5">
                            {message.attachments.map((att, i) => {
                              const viewable = !!att.text || (att.kind === 'image' && !!att.path)
                              return (
                                <button
                                  key={i}
                                  type="button"
                                  disabled={!viewable}
                                  onClick={() => {
                                    if (att.kind === 'image' && att.path) {
                                      closePanels()
                                      setLightbox({
                                        url: `ogcapture://${att.path}`,
                                        path: att.path
                                      })
                                    } else if (att.text || att.path) {
                                      closePanels()
                                      setViewer({
                                        title: att.kind === 'pasted' ? 'Pasted text' : att.name,
                                        text: att.text || '',
                                        path: att.path,
                                        kind: att.kind
                                      })
                                    }
                                  }}
                                  title={viewable ? 'Click to view' : undefined}
                                  className="flex items-center gap-1 rounded-md bg-neutral-700/60 px-2 py-1 text-[10px] text-neutral-200 transition-colors enabled:cursor-pointer enabled:hover:bg-neutral-600/60"
                                >
                                  <svg
                                    className="h-3 w-3 text-neutral-400"
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
                                  <span className="max-w-[12rem] truncate">{att.name}</span>
                                  <span className="text-neutral-500">{att.kind}</span>
                                </button>
                              )
                            })}
                          </div>
                        ) : null}
                        {editingId === message.id ? (
                          <div className="flex flex-col gap-2">
                            <textarea
                              autoFocus
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault()
                                  saveEdit(message.id)
                                }
                                if (e.key === 'Escape') setEditingId(null)
                              }}
                              rows={Math.min(10, editText.split('\n').length + 1)}
                              className="w-full resize-none rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-green-500"
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={() => saveEdit(message.id)}
                                className="rounded-md bg-green-600 px-3 py-1 text-xs text-white transition-colors hover:bg-green-500"
                              >
                                Save & submit
                              </button>
                              <button
                                onClick={() => setEditingId(null)}
                                className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-400 transition-colors hover:text-neutral-200"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkBreaks]}
                            components={
                              message.role === 'assistant'
                                ? makeCiteComponents(message.context?.unified)
                                : markdownComponents
                            }
                          >
                            {message.role !== 'assistant'
                              ? message.content
                              : // Show the selected regenerated variant (if any); keep artifact code
                                // inline; hide only the clarifying-question fence.
                                (message.variants && message.variantIndex != null
                                  ? message.variants[message.variantIndex]!
                                  : message.content
                                )
                                  .replace(ASK_FENCE, '')
                                  .replace(/\[S(\d+)\]/g, '[S$1](cite:$1)')
                                  .trim()}
                          </ReactMarkdown>
                        )}
                        {message.cutoff ? (
                          <p
                            role="status"
                            className="mt-2 flex items-start gap-1.5 border-t border-amber-500/20 pt-2 text-[11px] text-amber-400"
                          >
                            <WarningCircle className="mt-0.5 h-3 w-3 shrink-0" weight="fill" />
                            Response stopped at the configured{' '}
                            {message.cutoff.maxTokens.toLocaleString()}-token limit.
                          </p>
                        ) : null}
                        {message.imageMemoryRetry ? (
                          <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
                            <p className="min-w-0 flex-1 text-[10px] text-muted-foreground">
                              Running this model may make your Mac unresponsive.
                            </p>
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              disabled={loading}
                              onClick={() => {
                                const retry = message.imageMemoryRetry
                                if (!retry) return
                                void sendMessage(retry.prompt, {
                                  regen: true,
                                  conversationId: retry.conversationId,
                                  projectIdOverride: retry.projectId,
                                  imageRequest: {
                                    ...retry.request,
                                    allowUnsafeMemoryOverride: true
                                  }
                                })
                              }}
                              className="shrink-0 active:scale-95"
                            >
                              Run anyway
                            </Button>
                          </div>
                        ) : null}
                        {(() => {
                          if (message.role !== 'assistant') return null
                          const art = parseArtifact(message.content)
                          if (!art) return null
                          return (
                            <button
                              type="button"
                              onClick={() => openCanvas(art)}
                              className="mt-2 flex w-full items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2.5 text-left transition-colors hover:border-green-500/60"
                            >
                              <span className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-800 bg-neutral-950 text-green-500">
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
                                    d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                  />
                                </svg>
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs text-neutral-200">
                                  {art.title || `${art.kind.toUpperCase()} artifact`}
                                </span>
                                <span className="block text-[11px] text-neutral-500">
                                  Click to open in the canvas →
                                </span>
                              </span>
                            </button>
                          )
                        })()}
                        {(() => {
                          if (message.role !== 'assistant') return null
                          const ask = parseAsk(message.content)
                          if (!ask) return null
                          const sel = askSel[message.id] || []
                          return (
                            <div className="mt-2 flex flex-col gap-1.5">
                              <p className="text-xs text-neutral-400">{ask.question}</p>
                              <div className="flex flex-wrap gap-1.5">
                                {ask.options.map((opt) => {
                                  const on = sel.includes(opt)
                                  return (
                                    <button
                                      key={opt}
                                      onClick={() => {
                                        if (ask.multiSelect) {
                                          setAskSel((prev) => ({
                                            ...prev,
                                            [message.id]: on
                                              ? sel.filter((o) => o !== opt)
                                              : [...sel, opt]
                                          }))
                                        } else {
                                          void sendMessage(opt)
                                        }
                                      }}
                                      className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${on ? 'border-green-500 text-green-500' : 'border-neutral-700 text-neutral-300 hover:border-green-500 hover:text-green-500'}`}
                                    >
                                      {opt}
                                    </button>
                                  )
                                })}
                              </div>
                              {ask.multiSelect && sel.length > 0 ? (
                                <button
                                  onClick={() => void sendMessage(sel.join(', '))}
                                  className="mt-1 self-start rounded-md bg-green-600 px-3 py-1 text-xs text-white transition-colors hover:bg-green-500"
                                >
                                  Submit ({sel.length})
                                </button>
                              ) : null}
                            </div>
                          )
                        })()}
                        {message.image ? (
                          <div>
                            <img
                              src={message.image}
                              alt="Generated"
                              onClick={() =>
                                setLightbox({
                                  url: message.image as string,
                                  path: message.imagePath
                                })
                              }
                              className="mt-2 max-w-full cursor-zoom-in rounded-md border border-neutral-800 transition-opacity hover:opacity-90"
                            />
                            <ImageMetadata metadata={message.imageMetadata} />
                          </div>
                        ) : null}
                      </div>

                      {message.role === 'user' ? (
                        <div className="mt-1.5 flex items-center gap-3">
                          <button
                            onClick={() => copyText(message.content, message.id)}
                            className={`flex items-center gap-1 text-[11px] transition-colors ${copiedKey === message.id ? 'text-green-500' : 'text-neutral-600 hover:text-green-500'}`}
                            title="Copy"
                          >
                            {copiedKey === message.id ? (
                              <>
                                <svg
                                  className="h-3.5 w-3.5"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M5 13l4 4L19 7"
                                  />
                                </svg>
                                Copied
                              </>
                            ) : (
                              <>
                                <svg
                                  className="h-3.5 w-3.5"
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
                                Copy
                              </>
                            )}
                          </button>
                          <button
                            onClick={() => regenerate(message.id)}
                            className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500"
                            title="Regenerate the reply to this message"
                          >
                            <svg
                              className="h-3.5 w-3.5"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                              />
                            </svg>
                            Resend
                          </button>
                          <button
                            onClick={() => {
                              setEditingId(message.id)
                              setEditText(message.content)
                            }}
                            className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500"
                            title="Edit this message"
                          >
                            <svg
                              className="h-3.5 w-3.5"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
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
                      ) : null}

                      {message.role === 'assistant' && !message.image ? (
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <button
                            onClick={() => speakMessage(message.id, message.content)}
                            className={`flex items-center gap-1 text-[11px] transition-colors ${speakingId === message.id || speakLoadingId === message.id ? 'text-green-500' : 'text-neutral-600 hover:text-green-500'}`}
                            title={
                              speakLoadingId === message.id
                                ? 'Generating…'
                                : speakingId === message.id
                                  ? 'Stop'
                                  : 'Speak'
                            }
                          >
                            {speakLoadingId === message.id ? (
                              <svg
                                className="h-3.5 w-3.5 animate-spin"
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
                            ) : speakingId === message.id ? (
                              <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                                <rect x="6" y="5" width="4" height="14" rx="1" />
                                <rect x="14" y="5" width="4" height="14" rx="1" />
                              </svg>
                            ) : (
                              <svg
                                className="h-3.5 w-3.5"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
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
                            )}
                            {speakLoadingId === message.id
                              ? 'Generating…'
                              : speakingId === message.id
                                ? 'Stop'
                                : 'Speak'}
                          </button>
                          <button
                            onClick={() => copyText(message.content, message.id)}
                            className={`flex items-center gap-1 text-[11px] transition-colors ${copiedKey === message.id ? 'text-green-500' : 'text-neutral-600 hover:text-green-500'}`}
                            title="Copy"
                          >
                            {copiedKey === message.id ? (
                              <>
                                <svg
                                  className="h-3.5 w-3.5"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M5 13l4 4L19 7"
                                  />
                                </svg>
                                Copied
                              </>
                            ) : (
                              <>
                                <svg
                                  className="h-3.5 w-3.5"
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
                                Copy
                              </>
                            )}
                          </button>
                          <button
                            onClick={() => regenerate(message.id)}
                            className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500"
                            title="Regenerate"
                          >
                            <svg
                              className="h-3.5 w-3.5"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                              />
                            </svg>
                            Regenerate
                          </button>
                          {message.variants && message.variants.length > 1 ? (
                            <span className="flex items-center gap-1 text-[11px] text-neutral-500">
                              <button
                                onClick={() =>
                                  setMessages((prev) =>
                                    prev.map((m) =>
                                      m.id === message.id
                                        ? {
                                            ...m,
                                            variantIndex: Math.max(0, (m.variantIndex ?? 0) - 1)
                                          }
                                        : m
                                    )
                                  )
                                }
                                disabled={(message.variantIndex ?? 0) <= 0}
                                className="transition-colors hover:text-green-500 disabled:opacity-30"
                              >
                                ‹
                              </button>
                              <span>
                                {(message.variantIndex ?? 0) + 1}/{message.variants.length}
                              </span>
                              <button
                                onClick={() =>
                                  setMessages((prev) =>
                                    prev.map((m) =>
                                      m.id === message.id
                                        ? {
                                            ...m,
                                            variantIndex: Math.min(
                                              (m.variants?.length ?? 1) - 1,
                                              (m.variantIndex ?? 0) + 1
                                            )
                                          }
                                        : m
                                    )
                                  )
                                }
                                disabled={
                                  (message.variantIndex ?? 0) >= message.variants.length - 1
                                }
                                className="transition-colors hover:text-green-500 disabled:opacity-30"
                              >
                                ›
                              </button>
                            </span>
                          ) : null}
                          {parseArtifact(message.content) ? (
                            <button
                              onClick={() => {
                                const a = parseArtifact(message.content)
                                if (a) openCanvas(a)
                              }}
                              className="flex items-center gap-1 text-[11px] text-green-500 transition-colors hover:text-emerald-500"
                            >
                              <svg
                                className="h-3.5 w-3.5"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
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
                          {speakError?.id === message.id ? (
                            <p
                              role="alert"
                              className="basis-full text-[11px] leading-4 text-red-400"
                            >
                              {speakError.message}
                            </p>
                          ) : null}
                        </div>
                      ) : null}

                      {message.role === 'assistant' &&
                      message.context &&
                      (message.context.sources?.length || 0) +
                        (message.context.memories?.length || 0) +
                        (message.context.summaries?.length || 0) +
                        (message.context.entities?.length || 0) +
                        (message.context.entityFacts?.length || 0) +
                        (message.context.unified?.length || 0) >
                        0 ? (
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
                            <span className="flex-1">
                              Searched your memory —{' '}
                              {(message.context.sources?.length || 0) +
                                (message.context.memories?.length || 0) +
                                (message.context.summaries?.length || 0) +
                                (message.context.entities?.length || 0) +
                                (message.context.entityFacts?.length || 0) +
                                (message.context.unified?.length || 0)}{' '}
                              results
                            </span>
                            <svg
                              className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 9l-7 7-7-7"
                              />
                            </svg>
                          </CollapsibleTrigger>
                          <CollapsibleContent className="mt-1.5 max-h-[400px] max-w-full overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900/40 p-4 text-sm">
                            {message.context.unified && message.context.unified.length > 0 ? (
                              <div className="mb-3">
                                <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
                                  Sources ({message.context.unified.length}) — cited as [S#]
                                </div>
                                <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-3">
                                  {message.context.unified.map((u, idx) => (
                                    <button
                                      key={idx}
                                      type="button"
                                      onClick={() => {
                                        if (u.kind === 'screen') {
                                          onSeekReplay?.(u.ts)
                                          return
                                        }
                                        if (u.refId == null) return
                                        if (u.kind === 'memory') onNavigateToMemory?.(u.refId)
                                        else if (u.kind === 'entity') onNavigateToEntity?.(u.refId)
                                        else if (u.kind === 'meeting')
                                          onNavigateToChat?.(String(u.refId))
                                      }}
                                      title={`${u.kind} · ${u.surface}${u.title ? ' · ' + u.title : ''}${u.kind === 'screen' ? ' · open in Replay' : ''}`}
                                      className="flex flex-col gap-1 overflow-hidden rounded-md border border-neutral-800 p-2 text-left text-[11px] text-neutral-400 transition-colors hover:border-green-500"
                                    >
                                      {/* Screen captures: show the actual frame, click → Replay seeked to that moment */}
                                      {u.kind === 'screen' && u.imagePath ? (
                                        <img
                                          src={`ogcapture://${u.imagePath}`}
                                          alt=""
                                          className="mb-0.5 h-16 w-full rounded border border-neutral-800 object-cover"
                                        />
                                      ) : null}
                                      <div className="flex items-center gap-1.5">
                                        <span className="font-semibold text-green-500">
                                          [S{idx + 1}]
                                        </span>
                                        <span className="rounded-sm border border-neutral-700 px-1 text-[9px] uppercase tracking-wide text-neutral-500">
                                          {u.kind}
                                        </span>
                                      </div>
                                      <span className="line-clamp-2 text-neutral-300">
                                        {u.title && u.title !== u.surface ? u.title : u.snippet}
                                      </span>
                                      <span className="truncate text-[10px] text-neutral-600">
                                        {u.surface}
                                        {u.kind === 'screen' ? ' · open in Replay →' : ''}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            {message.context.sources && message.context.sources.length > 0 ? (
                              <div className="mb-3">
                                <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
                                  Sources ({message.context.sources.length})
                                </div>
                                <div className="space-y-1">
                                  {message.context.sources.slice(0, 8).map((s, idx) => (
                                    <div
                                      key={idx}
                                      className="flex items-center gap-2 rounded-md border border-neutral-800 p-2 text-[11px] text-neutral-400"
                                    >
                                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                                      <span className="shrink-0 text-neutral-600">
                                        {(s.score * 100).toFixed(0)}%
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            {message.context.masterMemory ? (
                              <div className="mb-3 rounded-md border border-neutral-800 p-3">
                                <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
                                  Master memory
                                </div>
                                <div className="text-neutral-300">
                                  <ReactMarkdown
                                    remarkPlugins={[remarkGfm, remarkBreaks]}
                                    components={markdownComponents}
                                  >
                                    {message.context.masterMemory}
                                  </ReactMarkdown>
                                </div>
                              </div>
                            ) : null}

                            {message.context.memories && message.context.memories.length > 0 ? (
                              <div className="mb-3">
                                <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
                                  Memories ({message.context.memories.length})
                                </div>
                                <div className="space-y-1">
                                  {message.context.memories
                                    .slice(0, 5)
                                    .map((memory: any, idx: number) => (
                                      <button
                                        key={memory.id || idx}
                                        onClick={() => onNavigateToMemory?.(memory.id)}
                                        className="block w-full rounded-md border border-neutral-800 p-2 text-left transition-colors hover:border-neutral-700"
                                      >
                                        <p className="line-clamp-2 text-[11px] text-neutral-400">
                                          {memory.content || memory.text || 'Memory'}
                                        </p>
                                      </button>
                                    ))}
                                </div>
                              </div>
                            ) : null}

                            {message.context.summaries && message.context.summaries.length > 0 ? (
                              <div className="mb-3">
                                <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
                                  Related chats ({message.context.summaries.length})
                                </div>
                                <div className="space-y-1">
                                  {message.context.summaries
                                    .slice(0, 5)
                                    .map((summary: any, idx: number) => (
                                      <button
                                        key={summary.session_id || idx}
                                        onClick={() => onNavigateToChat?.(summary.session_id)}
                                        className="block w-full rounded-md border border-neutral-800 p-2 text-left transition-colors hover:border-neutral-700"
                                      >
                                        <p className="line-clamp-2 text-[11px] text-neutral-400">
                                          {summary.summary || summary.title || 'Chat'}
                                        </p>
                                        {summary.app_name && (
                                          <span className="mt-1 inline-block text-[10px] text-neutral-600">
                                            {summary.app_name}
                                          </span>
                                        )}
                                      </button>
                                    ))}
                                </div>
                              </div>
                            ) : null}

                            {message.context.entities && message.context.entities.length > 0 ? (
                              <div className="mb-3">
                                <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
                                  Entities ({message.context.entities.length})
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {message.context.entities
                                    .slice(0, 10)
                                    .map((entity: any, idx: number) => (
                                      <button
                                        key={entity.id || idx}
                                        onClick={() => onNavigateToEntity?.(entity.id)}
                                        className="rounded-md border border-neutral-800 px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:border-green-500 hover:text-green-500"
                                      >
                                        {entity.name || 'Entity'}
                                      </button>
                                    ))}
                                </div>
                              </div>
                            ) : null}

                            {message.context.entityFacts &&
                            message.context.entityFacts.length > 0 ? (
                              <div>
                                <div className="mb-2 text-[10px] uppercase tracking-wide text-neutral-600">
                                  Entity facts ({message.context.entityFacts.length})
                                </div>
                                <div className="space-y-1">
                                  {message.context.entityFacts
                                    .slice(0, 5)
                                    .map((fact: any, idx: number) => (
                                      <div
                                        key={idx}
                                        className="rounded-md border border-neutral-800 p-2"
                                      >
                                        <p className="line-clamp-2 text-[11px] text-neutral-400">
                                          {fact.fact || fact}
                                        </p>
                                      </div>
                                    ))}
                                </div>
                              </div>
                            ) : null}
                          </CollapsibleContent>
                        </Collapsible>
                      ) : null}
                    </div>
                  )
                )}
                {/* A reply generating on another one of your devices, streaming here live. Pro
                    registers the renderer; the free build has no slot and this is nothing. */}
                {ChatMessagesFooter && activeConversationId ? (
                  <ChatMessagesFooter conversationId={activeConversationId} />
                ) : null}
                {!!activeConversationId &&
                generatingConvs.has(activeConversationId) &&
                !messages.some((m) => m.streaming) ? (
                  <div className="mb-5 flex flex-col items-start">
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-600">
                      Off Grid AI
                    </div>
                    {mode === 'image' || generatingImage ? (
                      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
                        {imgProgress?.preview ? (
                          <img
                            src={imgProgress.preview}
                            alt="forming"
                            className="mb-2 w-56 rounded-md border border-neutral-800"
                          />
                        ) : (
                          <div className="mb-2 flex h-56 w-56 items-center justify-center rounded-md border border-neutral-800 text-[11px] text-neutral-600">
                            warming up…
                          </div>
                        )}
                        <div className="flex items-center justify-between text-[11px] text-neutral-500">
                          <span>
                            {imgProgress
                              ? `${imgProgress.phase === 'decoding' ? 'Decoding' : 'Step'} ${imgProgress.step}/${imgProgress.total}`
                              : 'Loading model…'}
                          </span>
                          {imgProgress ? (
                            <span className="text-neutral-600">
                              ~
                              {Math.max(
                                0,
                                Math.round(
                                  (imgProgress.total - imgProgress.step) * imgProgress.secPerStep
                                )
                              )}
                              s left
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-1.5 h-1 w-56 overflow-hidden rounded-full bg-neutral-800">
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
                    ) : (
                      <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3.5 py-2.5">
                        <span className="flex gap-1">
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-green-500 [animation-delay:0ms]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-green-500 [animation-delay:150ms]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-green-500 [animation-delay:300ms]" />
                        </span>
                        <span className="text-xs text-neutral-500">
                          {waitingLabel({ noMemory, hasProject: !!activeProjectId })}
                        </span>
                      </div>
                    )}
                  </div>
                ) : null}
                <div ref={bottomRef} className="h-2" />
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-neutral-900 px-6 py-3">
            <div className="w-full px-6">
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
                        setCfgScaleOverride(Math.max(0, Math.min(20, Number(e.target.value) || 0)))
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

              {/* Active style chip (image mode) */}
              {mode === 'image' && activeStyle && (
                <div className="mb-2 flex items-center gap-2 text-[11px] text-neutral-500">
                  <span>Style</span>
                  <span className="rounded-md border border-green-500/40 px-2 py-0.5 text-green-500">
                    {activeStyle}
                  </span>
                  <button
                    onClick={() => setActiveStyle(null)}
                    className="text-neutral-600 transition-colors hover:text-red-400"
                  >
                    clear
                  </button>
                </div>
              )}

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
                          {q.text || `(${q.atts.length} attachment${q.atts.length > 1 ? 's' : ''})`}
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
                className={`relative rounded-xl border bg-neutral-950 shadow-sm transition-colors ${dragOver ? 'border-green-500' : 'border-neutral-800 focus-within:border-neutral-600'}`}
              >
                {dragOver ? (
                  <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-xl bg-neutral-950/80 text-xs text-green-500">
                    Drop files to attach
                  </div>
                ) : null}
                {skillMatches.length > 0 && (
                  <div className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-md border border-neutral-800 bg-neutral-950 py-1 text-sm shadow-lg">
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
                              const url = a.preview || (a.path ? `ogcapture://${a.path}` : '')
                              if (url) {
                                closePanels()
                                setLightbox({ url, path: a.path })
                              }
                            }}
                            title="Click to view"
                            className="relative h-[2.6rem] overflow-hidden rounded-md"
                          >
                            <img
                              src={a.preview || (a.path ? `ogcapture://${a.path}` : '')}
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
                {microphoneDenied && (
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
                {transcribeError && (
                  <div
                    role="alert"
                    className="mx-2 mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
                  >
                    {transcribeError}
                  </div>
                )}
                {voiceMode ? (
                  // Voice mode: the input surface is a single mic — record a note,
                  // it transcribes and sends. The toolbar below stays identical.
                  <button
                    type="button"
                    onClick={toggleRecording}
                    disabled={transcribing}
                    className={`flex w-full flex-col items-center gap-2 py-5 ${transcribing ? 'cursor-default' : 'cursor-pointer'}`}
                  >
                    <span
                      className={`flex h-14 w-14 items-center justify-center rounded-full border-2 transition-colors ${recording ? 'border-red-500 bg-red-500/15 text-red-400' : 'border-green-500 bg-green-500/10 text-green-500 hover:bg-green-500/20'} ${transcribing ? 'opacity-50' : ''}`}
                    >
                      {transcribing ? (
                        <svg className="h-6 w-6 animate-spin" fill="none" viewBox="0 0 24 24">
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
                      ) : recording ? (
                        <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
                          <rect x="6" y="6" width="12" height="12" rx="2" />
                        </svg>
                      ) : (
                        <svg
                          className="h-6 w-6"
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
                    </span>
                    <span className="text-xs text-neutral-500">
                      {transcribing
                        ? 'Transcribing…'
                        : recording
                          ? 'Recording — tap to send'
                          : 'Tap to record a voice note'}
                    </span>
                  </button>
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
                    className="max-h-52 w-full resize-none overflow-y-auto bg-transparent px-3.5 pt-3 text-sm text-neutral-200 placeholder-neutral-600 outline-none"
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
                          className="size-8 rounded-full"
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56">
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
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Coming soon
                        </DropdownMenuLabel>
                        <DropdownMenuItem disabled>
                          <Search /> Web search
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
                      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56">
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
                            <span className="text-[10px] text-muted-foreground">· plain chat</span>
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
                            aria-label={recording ? 'Stop recording' : 'Record voice'}
                            onClick={toggleRecording}
                            disabled={transcribing}
                            className={`size-8 ${recording ? 'border-red-500/50 text-red-400' : ''}`}
                          >
                            {transcribing ? (
                              <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
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
                        <TooltipContent>
                          {recording ? 'Stop recording' : 'Record voice'}
                        </TooltipContent>
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
                              onClick={() => stopGeneration(activeConversationId)}
                              className="size-8 rounded-full border-red-500/50 text-red-400 hover:bg-red-500/10"
                            >
                              <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
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
                          stopGeneration(activeConversationId)
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
      </div>

      {/* Canvas — sandboxed render of a model-generated artifact */}
      {canvasArtifact && (
        <ArtifactCanvas
          artifact={canvasArtifact}
          onClose={() => setCanvasArtifact(null)}
          width={canvasWidth}
          onResize={setCanvasWidth}
        />
      )}

      {/* Skills — view / create / edit reusable instruction packs */}
      {skillsOpen && (
        <SkillsPanel
          onClose={() => setSkillsOpen(false)}
          onChanged={() =>
            window.api
              .listSkills()
              .then((s) => setSkills(s))
              .catch(() => {})
          }
        />
      )}

      {modelPickerOpen && <ModelPicker onClose={() => setModelPickerOpen(false)} />}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

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
            <motion.pre
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 4 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              className="max-h-full w-full max-w-3xl overflow-auto whitespace-pre-wrap break-words rounded-md border border-neutral-800 bg-neutral-950 p-5 text-sm leading-relaxed text-neutral-200"
            >
              {viewer.text}
            </motion.pre>
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
      {showGallery && (
        <>
          <div className="fixed right-0 top-0 bottom-0 z-50 flex w-[30vw] min-w-[420px] flex-col border-l border-neutral-800 bg-neutral-950 font-mono shadow-2xl">
            <div className="flex items-center justify-between border-b border-neutral-900 px-4 py-3">
              <span className="text-sm text-neutral-200">Gallery</span>
              <button
                onClick={() => setShowGallery(false)}
                className="text-neutral-500 transition-colors hover:text-neutral-200"
              >
                ✕
              </button>
            </div>
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
                        onClick={() => setLightbox({ url: `ogcapture://${g.path}`, path: g.path })}
                        className="overflow-hidden rounded-md border border-neutral-800 transition-colors hover:border-green-500"
                      >
                        <img
                          src={`ogcapture://${g.path}`}
                          alt=""
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
                                  setLightbox({ url: `ogcapture://${a.code}`, path: a.code }))
                                : a.kind === 'text'
                                  ? (closePanels(), setViewer({ title: a.title, text: a.code }))
                                  : openCanvas({ kind: a.kind, code: a.code, title: a.title })
                            }
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          >
                            {a.kind === 'image' ? (
                              <img
                                src={`ogcapture://${a.code}`}
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
          </div>
        </>
      )}
    </div>
  )
}
