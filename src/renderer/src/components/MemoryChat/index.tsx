import { restoredStreamMessage, withRestoredStream } from '@renderer/lib/chat-stream-restore'
import { stopChatRun } from '@renderer/lib/chat-stop'
import { observeOwnedRun, type RunEvent } from '@renderer/lib/chat-run-owner'
import { persistObservedTurn } from '@renderer/lib/chat-turn-persistence'
import type { ResponseVersion } from '../../../../shared/chat-versions'
import {
  appendAnswerVersion,
  selectAnswerVersion,
  failedAnswerVersion,
  withAnswerVersions
} from '@renderer/lib/chat-versions'
import { replaceChatTurn, type ReplacementDependencies } from '@renderer/lib/chat-turn-replacement'
import {
  getChatQueueStore,
  type ChatQueues,
  type QueuedTurn
} from '@renderer/lib/chat-queue-store'
import {
  captureStopTarget,
  unownedTerminal,
  settleUnownedStream,
  type RunStopTarget
} from '@renderer/lib/chat-run-lifecycle'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { queuedCount } from '@renderer/lib/chat-queue'
import {
  submitQueuedTurn,
  queuedDraftAfterSave,
  queuedAttachmentsAfterSave
} from '@renderer/lib/chat-queue-submit'
import { buildSendHistory } from '@renderer/lib/chat-history'
import { waitingLabel } from '@renderer/lib/chat-labels'
import { parseSqliteUtc, shiftLocalDay, startOfLocalDay } from '@renderer/lib/time'
import { writeClipboardWithFallback } from '@renderer/lib/clipboard-write'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { isAgenticTurn } from '@renderer/lib/agentic-active'
import { appendTimelineEvent, applyStreamEvent } from '@renderer/lib/stream-reducer'
import { useActiveModelSummary } from '@renderer/hooks/useActiveModelSummary'
import { shouldFollowBottom } from '@renderer/lib/scroll-follow'
import {
  attachmentKindFor,
  describeAttachment,
  isPromptEnhancementReasoningLabel,
  type ChatStreamPreviewRow,
  type ProjectedSyncedTool
} from '@offgrid/sync'
import type { VoiceTurnMode } from '@offgrid/speech'
import { getSlot, SLOTS } from '@/bootstrap/slotRegistry'
import { callHook } from '@/bootstrap/hookRegistry'
import { useRendererEntitlement } from '@/bootstrap/useRendererEntitlement'
import {
  SYNC_SUBSCRIBE_INCOMING_FILES_HOOK,
  type IncomingSharedFile
} from '@renderer/lib/sync-hooks'
import { ChatThinkingBlock } from '../ChatThinkingBlock'
import { ChatToolRows } from '../ChatToolRows'
import { ArtifactCanvas, parseArtifact, type Artifact } from '../ArtifactCanvas'
import { stopAllVoicePlayback } from '@renderer/lib/voice-playback-bus'
import { ChatVoiceComposer, VoiceModeControl } from '../ChatVoiceComposer'
import { ChatDraftInput, ChatDraftSendButton, type ChatDraftInputHandle } from '../ChatDraftInput'
import { createChatDraftStore } from '../chat-draft-store'
import { NewProjectNameField } from '../NewProjectNameField'
import { ExploreSection } from '../explore/ExploreSection'
import { PresetSetup } from '../explore/PresetSetup'
import {
  buildComicBookReader,
  comicBookHeroImage,
  comicBookPageFromPrompt,
  comicBookPageCount,
  comicBookTitle,
  type ComicBookPage
} from '../explore/comicBookReader'
import { ApprovalSetup, type ApprovalSetupRecord } from '../actions/ApprovalSetup'
import { REQUEST_FORM_URL, presetById, type DemoPreset } from '../explore/presetCatalog'
import { useChatVoiceTurns } from '../use-chat-voice-turns'
import { SkillsPanel } from '../SkillsPanel'
import { ModelPicker } from '../ModelPicker'
import { SettingsPanel } from '../SettingsPanel'
import { OPEN_ACTIVE_MODELS_PANEL_EVENT } from '@renderer/lib/model-settings-panel'
import { LoadingDots } from '../ui/loading-dots'
import { Segmented } from '@offgrid/operator-ui/operator/segmented'
import { Checkbox } from '@offgrid/operator-ui/operator/animate/checkbox'
import { SettingsSelect } from '../SettingsSelect'
import ElasticSlider from '@offgrid/operator-ui/operator/bits/elastic-slider'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'
import { AnimatedNumber } from '@offgrid/operator-ui/operator/motion/animated-number'
import { TextEffect } from '@offgrid/operator-ui/operator/text-effect'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import { SidePanel } from '../SidePanel'
import { ImageLightbox } from '../media/ImageLightbox'
import { resolveImageParams, setOverride, type ImageParamStore } from '@renderer/lib/image-params'
import { IMAGE_SETTINGS_CHANGED_EVENT } from '@renderer/lib/image-settings-events'
import {
  DISPLAY_SETTINGS_INVALIDATED_EVENT,
  LLM_SETTINGS_INVALIDATED_EVENT
} from '@renderer/lib/settings-invalidation'
import {
  DEFAULT_VOICE_PREFERENCES,
  VOICE_PREFERENCES_CHANGED_EVENT,
  readVoicePreferences,
  type VoicePreferences
} from '@renderer/lib/voice-preferences'
import { shouldAutoRouteImage, cleanImagePrompt } from '@renderer/lib/image-intent'
import { buildAssistantContext, type AssistantTimelineEntry } from '../../lib/message-persistence'
import type { GenerationMetrics } from '../../../../shared/generation-metrics'
import { withGeneratedImageReference } from '../../../../shared/generated-image-reference'
import type { RagConversationContract } from '../../../../shared/ipc-contracts'
import {
  parseImageMemoryGuardError,
  type ImageGenerationJobContract,
  type ImageGenerationRequestContract
} from '../../../../shared/image-generation-contract'
import { Button } from '@renderer/components/ui/button'
import {
  MessageQueue,
  type MessageQueueLabels,
  type QueueEdit
} from '@offgrid/operator-ui/operator/workflows/queue'
import { AttachmentList } from '@offgrid/operator-ui/operator/workflows/attachments'
import { AutoHeight } from '@offgrid/operator-ui/operator/presence'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputTools
} from '@offgrid/operator-ui/operator/elements/prompt-input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { ActionGateDock } from '@renderer/components/actions/ActionGateDock'
import { TaskPanelTrigger } from '@renderer/components/tasks/TaskPanelTrigger'
import { useTaskWorkspaceOpen } from '@renderer/lib/task-side-panel'
import { useWorkspacePaneController } from '../workspace/useWorkspacePaneController'
import { ActiveConversationProvider } from '@renderer/lib/ActiveConversationProvider'
import {
  getTaskSessionState,
  guidanceTaskForJourney,
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
import { captureUrlForPath } from '../../../../shared/ogcapture-url'
import { GodIcon } from '../GodIcon'
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
  WarningCircle,
  DownloadSimple,
  Trash,
  Stop
} from '@phosphor-icons/react'
import type { MemoryChatProps } from './interfaces'
import { announceAssistantActivity, announceAssistantListening } from '../../lib/assistant-activity'
import { playChime } from '../../lib/chime'
import { useReplySound } from '../../lib/reply-sound'
import type {
  Attachment,
  ChatMessage,
  ChatMode,
  Conversation,
  ContextNavigation,
  ConversationListRow,
  ImageGenerationMetadata,
  ImageProgress,
  MessageRowActions,
  ProjectLite,
  RagContext
} from './types'
import {
  announceImageMessagePersisted,
  completedImageMessage,
  groupChatTurnWork,
  mapRagMessages,
  mergeDurableAndStreaming,
  mergeRemotePreviewTools,
  queuedTurnId,
  toProcessingAttachment,
  toQueuedMessage
} from './helper'
import {
  findDurableWorkMessageId,
  generationErrorContent,
  IMAGE_MESSAGE_COLUMN_WIDTH,
  imageProgressLabel,
  isPromptEnhancementMessage,
  messageToSpeakable,
  preferredImageModel,
  readActiveConversationId,
  readOpenChatTabs
} from './utlis'
import { ToolMessageTimelineRow } from './components/ToolMessageTimelineRow'
import { AttachmentPreview } from './components/AttachmentPanes'
import { ChatDocuments } from './components/ChatDocuments'
import {
  ASK_EXAMPLES,
  ASK_EXAMPLES_PRO,
  IMAGE_EXAMPLES,
  STYLE_PRESETS,
  StylePresetPicker
} from './components/StylePresetPicker'

import { MessageRow } from './components/MessageRow'
import { ConversationSidebar } from './components/ConversationSidebar'
import {
  applyStreamViewEvent,
  clearStreamViewMessage,
  resetStreamViewMessage,
  seedStreamViewMessage,
  streamViewMessage
} from './stream-view-store'

import { stopLiveTask, stopLiveWebUseForConversation } from './helper'
import { PassPlayback, type PlayableClip } from '@renderer/lib/pass-playback'
import {
  ACTIVE_CHAT_TAB_KEY,
  EMPTY_MSGS,
  NEW_CHAT,
  nextVoicePlaybackOwner,
  OPEN_CHAT_TABS_KEY,
  textRecordingButtonLabel,
  textRecordingTooltip
} from './utlis'

/** OGAD's names for the queue's rows and actions. */
const QUEUE_LABELS: MessageQueueLabels = {
  queue: 'Queued messages',
  section: 'queued',
  attachmentsOnly: (message) => {
    const count = message.attachments?.length ?? 0
    return `(${count} attachment${count === 1 ? '' : 's'})`
  },
  sendNow: 'Send queued message now',
  remove: 'Delete queued message',
  cancel: 'Cancel queued message',
  copy: 'Copy queued message',
  copied: 'Copied queued message',
  edit: 'Edit queued message',
  moveUp: 'Move queued message up',
  moveDown: 'Move queued message down',
  editField: 'Edit queued message'
}

/** The image sizes the composer offers, as segmented options. */
const IMAGE_SIZE_OPTIONS = [256, 512, 640, 768, 1024].map((size) => ({
  id: String(size),
  label: String(size)
}))

/** A new turn rises into the thread; it animates on mount only, never as tokens stream. */
const MESSAGE_ROW_ENTER = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] }
} as const

/** God's own voice turn mode (hands-free unless changed in its voice composer). */

export function MemoryChat({
  onNavigateToMemory,
  onNavigateToChat,
  onNavigateToMeeting,
  onNavigateToEntity,
  onOpenProject,
  onSeekReplay,
  onOpenSkillPreset,
  onOpenConnectors,
  onOpenAssistantUpgrade,
  openTarget,
  onTargetConsumed,
  onActiveConversationChange,
  onTaskDetailModeChange,
  god
}: MemoryChatProps): React.JSX.Element {
  const { isPro } = useRendererEntitlement()
  // God's chat keeps its own conversations, tabs and layout; Chat leaves God's to God.
  const surface = god ? 'god' : 'chat'
  const openTabsKey = god ? `${OPEN_CHAT_TABS_KEY}:god` : OPEN_CHAT_TABS_KEY
  const activeTabKey = god ? `${ACTIVE_CHAT_TAB_KEY}:god` : ACTIVE_CHAT_TAB_KEY
  // Messages are kept PER CONVERSATION so a background tab keeps its own thread and
  // an in-flight stream can't leak into whatever tab you switch to. `messages` (below,
  // after activeConversationId) is the active tab's slice; sends target their own conv.
  const [messagesByConv, setMessagesByConv] = useState<Record<string, ChatMessage[]>>({})
  const messagesByConvRef = useRef(messagesByConv)
  const [nextMessages, setNextMessages] = useState<
    Record<string, { messageId: string; answer: string; text: string }>
  >({})
  const setConvMessages = useCallback(
    (
      cid: string | null,
      updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])
    ): void => {
      const k = cid ?? NEW_CHAT
      const previous = messagesByConvRef.current
      const next = {
        ...previous,
        [k]: typeof updater === 'function' ? updater(previous[k] ?? []) : updater
      }
      messagesByConvRef.current = next
      setMessagesByConv(next)
    },
    []
  )
  const replaceDurableMessages = useCallback(
    (conversationId: string, durable: ChatMessage[]): void => {
      setConvMessages(conversationId, (current) => mergeDurableAndStreaming(durable, current))
    },
    [setConvMessages]
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
      replaceDurableMessages(conversationId, nextMessages)
    },
    [loadLatestConversationMessages, replaceDurableMessages]
  )
  const [draftStore] = useState(createChatDraftStore)
  // A curated run collects its complete brief inside Chat before any model request starts.
  const [presetSetup, setPresetSetup] = useState<DemoPreset | null>(null)
  const [approvalSetup, setApprovalSetup] = useState<ApprovalSetupRecord | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Whether the active chat model can read images. Gate image attachment on this. The
  // main-owned model selection is read on mount and after an explicit invalidation;
  // opening Chat must not create a permanent IPC polling loop.
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
  // Off unless asked for (Settings -> Model -> Generation details), matching mobile.
  const [showGenerationDetails, setShowGenerationDetails] = useState(false)
  useEffect(() => {
    console.log('MemoryChat effect: display settings subscription')
    const refresh = (): void => {
      void window.api
        .getSettings()
        .then((settings) => setShowGenerationDetails(settings.showGenerationDetails === true))
        .catch(() => {})
    }
    window.addEventListener(DISPLAY_SETTINGS_INVALIDATED_EVENT, refresh)
    return () => window.removeEventListener(DISPLAY_SETTINGS_INVALIDATED_EVENT, refresh)
  }, [])
  useEffect(() => {
    console.log('MemoryChat effect: incoming files subscription')
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
  const refreshChatVision = useCallback((): void => {
    void (window.api as { chatVisionAvailable?: () => Promise<boolean> })
      .chatVisionAvailable?.()
      .then((v) => setChatVision(!!v))
      .catch(() => {})
  }, [])
  useEffect(() => {
    console.log('MemoryChat effect: chat vision availability')
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') refreshChatVision()
    }
    refreshChatVision()
    window.addEventListener(LLM_SETTINGS_INVALIDATED_EVENT, refreshChatVision)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.removeEventListener(LLM_SETTINGS_INVALIDATED_EVENT, refreshChatVision)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [refreshChatVision])
  useEffect(() => {
    console.log('MemoryChat effect: clear attachment warning')
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
    console.log('MemoryChat effect: conversation search')
    const q = convSearch.trim()
    if (!q) {
      setContentMatchIds(new Set())
      return
    }
    let live = true
    const t = setTimeout(async () => {
      try {
        const ids = (await window.api.searchRagConversationIds(q)) as string[] | undefined
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
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() =>
    readActiveConversationId(activeTabKey)
  )
  useEffect(() => {
    console.log('MemoryChat effect: active conversation notification')
    onActiveConversationChange?.(activeConversationId)
  }, [activeConversationId, onActiveConversationChange])
  // Active tab's messages (derived) + a shim so the existing active-conversation call
  // sites keep working. The send path targets its own conv via setConvMessages instead.
  const messages = messagesByConv[activeConversationId ?? NEW_CHAT] ?? EMPTY_MSGS
  // A variant can present turns its own way (God shows reactions on your messages).
  const displayMessages = useMemo(
    () => groupChatTurnWork(god?.presentMessages ? god.presentMessages(messages) : messages),
    [god, messages]
  )
  const [remoteWorkPreview, setRemoteWorkPreview] = useState<ChatStreamPreviewRow | null>(null)
  useEffect(() => {
    console.log('MemoryChat effect: reset remote work preview')
    setRemoteWorkPreview(null)
  }, [activeConversationId])
  const durableWorkMessageId = useMemo(
    () => findDurableWorkMessageId(displayMessages),
    [displayMessages]
  )
  const mergedRemoteWorkMessageId = remoteWorkPreview ? durableWorkMessageId : undefined
  // Read without subscribing the whole Chat tree. The streaming row owns the
  // journey-specific live subscription; this snapshot only gates image progress.
  const liveJourneyTask = guidanceTaskForJourney(getTaskSessionState().tasks, activeConversationId)
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
    console.log('MemoryChat effect: voice playback conversation lifecycle')
    stopAllVoicePlayback()
    return () => stopAllVoicePlayback()
  }, [activeConversationId])
  const [openTabs, setOpenTabs] = useState<string[]>(() => readOpenChatTabs(openTabsKey)) // conversation ids open as tabs
  useEffect(() => {
    console.log('MemoryChat effect: persist open chat tabs')
    try {
      window.localStorage.setItem(openTabsKey, JSON.stringify(openTabs))
    } catch {
      // Chat still works when renderer storage is unavailable.
    }
  }, [openTabs, openTabsKey])
  useEffect(() => {
    console.log('MemoryChat effect: persist active chat tab')
    try {
      if (activeConversationId) window.localStorage.setItem(activeTabKey, activeConversationId)
      else window.localStorage.removeItem(activeTabKey)
    } catch {
      // Chat still works when renderer storage is unavailable.
    }
  }, [activeConversationId, activeTabKey])
  const TaskWorkspace = getSlot(SLOTS.taskWorkspace)
  const taskWorkspaceVisible = useTaskWorkspaceOpen() && Boolean(TaskWorkspace)
  const [taskWorkspaceDragging, setTaskWorkspaceDragging] = useState(false)
  const reduceWorkspaceMotion = useReducedMotion()
  const {
    chatBodyRef,
    historyPanelRef,
    taskWorkspaceRef,
    chatCollapsed: chatBodyCollapsed,
    conversationsToggleWillShow,
    taskWorkspaceSize,
    toggleChat: toggleChatBodyVisibility,
    toggleConversations: toggleConversationList,
    setChatCollapsed: setChatBodyVisibility,
    setConversationsVisible,
    reportTaskSize,
    resizeTaskFromKeyboard: resizeTaskWorkspaceFromKeyboard
  } = useWorkspacePaneController(taskWorkspaceVisible)
  const conversationsToggleLabel = conversationsToggleWillShow
    ? 'Show conversations'
    : 'Collapse conversation list'
  const taskWorkspaceTransition =
    reduceWorkspaceMotion || taskWorkspaceDragging
      ? 'none'
      : 'flex-grow 420ms cubic-bezier(0.22, 1, 0.36, 1)'
  const galleryTriggerRef = useRef<HTMLButtonElement>(null)

  const handleTaskDetailModeChange = useCallback(
    (detailOpen: boolean): void => {
      onTaskDetailModeChange?.(detailOpen)
      setChatBodyVisibility(detailOpen)
    },
    [onTaskDetailModeChange, setChatBodyVisibility]
  )

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
  const qwenLatentPreview = /qwen[_-]?image[_-]?2[._-]?1/i.test(imgModel)
  const [projects, setProjects] = useState<ProjectLite[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  // Captured-memory context is a Pro ("remembers") feature; core chats are plain
  // (no memory) or scoped to a project. The UI never says "memory".
  const [noMemory, setNoMemory] = useState(!isPro)
  const [, setProjectMenuOpen] = useState(false)
  const [projCreating, setProjCreating] = useState(false)
  const projectNameInput = useRef<HTMLInputElement>(null)
  const focusProjectName = (event: Event): void => {
    if (!projCreating) return
    // Transfer focus after the menu exit finishes, regardless of animation duration.
    event.preventDefault()
    projectNameInput.current?.focus()
  }
  const [toolsOn, setToolsOn] = useState(false)
  const [toolsEnabled, setToolsEnabled] = useState(true)
  const [assistantGateOpen, setAssistantGateOpen] = useState(false)
  const [connectorsOn, setConnectorsOn] = useState(false)
  const [thinkingEnabled, setThinkingEnabled] = useState(false)
  const [chatVoiceMode, setVoiceMode] = useState(DEFAULT_VOICE_PREFERENCES.voiceMode)
  // God's Chat and Voice modes decide it there; Chat keeps its own saved choice.
  const voiceMode = god ? god.voiceMode : chatVoiceMode
  // One turn mode (Manual, Auto, Hands-free) for Chat and God alike: Settings > Voice and the
  // voice composer's picker change the same saved choice.
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
    console.log('MemoryChat effect: voice mode playback state')
    if (!voiceMode) {
      stopAllVoicePlayback()
      setVoicePlaybackOwner(null)
    }
  }, [voiceMode])

  // Composer preferences persist across sessions (memory scope, thinking, connectors,
  // voice mode). Assistant is deliberately per turn and is not in this snapshot. Main owns the durable values. This snapshot distinguishes hydration
  // and settings invalidations from a real UI edit, so opening Chat never writes the
  // values it just read back through IPC.
  const persistedPreferenceValues = useRef<Record<string, unknown>>({
    composerNoMemory: noMemory,
    composerConnectorsOn: connectorsOn,
    composerThinking: thinkingEnabled,
    composerVoiceMode: chatVoiceMode,
    imgSeed,
    imgNegative,
    enhanceImagePrompts: enhanceImg,
    imgStrength,
    imgStyle: activeStyle,
    imageParams: imgParamStore
  })
  const persistChangedPreference = useCallback((key: string, value: unknown): void => {
    const previous = persistedPreferenceValues.current[key]
    if (Object.is(previous, value)) return
    persistedPreferenceValues.current[key] = value
    // A failed save must not count as saved, or the close-time flush would skip the retry.
    window.api.saveSetting(key, value).catch((error: unknown) => {
      if (Object.is(persistedPreferenceValues.current[key], value)) {
        persistedPreferenceValues.current[key] = previous
      }
      console.error(`[chat] could not save ${key}:`, error)
    })
  }, [])
  useEffect(() => {
    console.log('MemoryChat effect: hydrate composer preferences')
    ;(async () => {
      try {
        const s = await window.api.getSettings()
        const previous = persistedPreferenceValues.current
        Object.assign(persistedPreferenceValues.current, {
          composerNoMemory:
            typeof s.composerNoMemory === 'boolean'
              ? s.composerNoMemory
              : previous.composerNoMemory,
          composerConnectorsOn:
            typeof s.composerConnectorsOn === 'boolean'
              ? s.composerConnectorsOn
              : previous.composerConnectorsOn,
          composerThinking:
            typeof s.composerThinking === 'boolean'
              ? s.composerThinking
              : previous.composerThinking,
          imgSeed: typeof s.imgSeed === 'string' ? s.imgSeed : previous.imgSeed,
          imgNegative: typeof s.imgNegative === 'string' ? s.imgNegative : previous.imgNegative,
          enhanceImagePrompts:
            typeof s.enhanceImagePrompts === 'boolean'
              ? s.enhanceImagePrompts
              : previous.enhanceImagePrompts,
          imgStrength: typeof s.imgStrength === 'number' ? s.imgStrength : previous.imgStrength,
          imgStyle:
            typeof s.imgStyle === 'string' || s.imgStyle === null ? s.imgStyle : previous.imgStyle,
          imageParams:
            s.imageParams && typeof s.imageParams === 'object'
              ? s.imageParams
              : previous.imageParams
        })
        if (typeof s.composerNoMemory === 'boolean') setNoMemory(s.composerNoMemory)
        if (typeof s.composerConnectorsOn === 'boolean') setConnectorsOn(s.composerConnectorsOn)
        setToolsEnabled(s.toolsEnabled !== false)
        if (typeof s.composerThinking === 'boolean') setThinkingEnabled(s.composerThinking)
        setShowGenerationDetails(s.showGenerationDetails === true)
        const voicePreferences = readVoicePreferences(s)
        persistedPreferenceValues.current.composerVoiceMode = voicePreferences.voiceMode
        setVoiceMode(voicePreferences.voiceMode)
        persistedPreferenceValues.current.composerVoiceTurnMode = voicePreferences.turnMode
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
      }
    })()
  }, [])
  useEffect(() => {
    const syncToolsEnabled = (event: Event): void => {
      setToolsEnabled((event as CustomEvent<boolean>).detail)
    }
    window.addEventListener('offgrid-tools-enabled-changed', syncToolsEnabled)
    return () => window.removeEventListener('offgrid-tools-enabled-changed', syncToolsEnabled)
  }, [])
  useEffect(() => {
    console.log('MemoryChat effect: persist no-memory preference')
    persistChangedPreference('composerNoMemory', noMemory)
  }, [noMemory, persistChangedPreference])
  useEffect(() => {
    console.log('MemoryChat effect: persist connectors preference')
    persistChangedPreference('composerConnectorsOn', connectorsOn)
  }, [connectorsOn, persistChangedPreference])
  useEffect(() => {
    console.log('MemoryChat effect: persist thinking preference')
    persistChangedPreference('composerThinking', thinkingEnabled)
  }, [persistChangedPreference, thinkingEnabled])
  useEffect(() => {
    console.log('MemoryChat effect: persist voice-mode preference')
    persistChangedPreference('composerVoiceMode', chatVoiceMode)
  }, [persistChangedPreference, chatVoiceMode])
  useEffect(() => {
    console.log('MemoryChat effect: voice preferences subscription')
    const applyPreferences = (event: Event): void => {
      const next = (event as CustomEvent<VoicePreferences>).detail
      persistedPreferenceValues.current.composerVoiceMode = next.voiceMode
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
  // Persist the global image-composer params only when they differ from the latest
  // main-owned values. Hydration and settings invalidations update the snapshot first.
  // Seed and negative prompt are typed, so they are written once typing pauses rather than on
  // every character.
  useEffect(() => {
    console.log('MemoryChat effect: persist image seed')
    const timer = setTimeout(() => persistChangedPreference('imgSeed', imgSeed), 400)
    return () => clearTimeout(timer)
  }, [imgSeed, persistChangedPreference])
  useEffect(() => {
    console.log('MemoryChat effect: persist negative prompt')
    const timer = setTimeout(() => persistChangedPreference('imgNegative', imgNegative), 400)
    return () => clearTimeout(timer)
  }, [imgNegative, persistChangedPreference])
  // Leaving the composer within the pause must not drop the last edit: write what is pending.
  const typedImageParams = useRef({ imgSeed, imgNegative })
  // Committed values only: a render React discards must not reach the close-time save.
  useEffect(() => {
    typedImageParams.current = { imgSeed, imgNegative }
  }, [imgSeed, imgNegative])
  useEffect(
    () => () => {
      persistChangedPreference('imgSeed', typedImageParams.current.imgSeed)
      persistChangedPreference('imgNegative', typedImageParams.current.imgNegative)
    },
    [persistChangedPreference]
  )
  useEffect(() => {
    console.log('MemoryChat effect: persist image enhancement preference')
    persistChangedPreference('enhanceImagePrompts', enhanceImg)
  }, [enhanceImg, persistChangedPreference])
  useEffect(() => {
    console.log('MemoryChat effect: persist image strength')
    persistChangedPreference('imgStrength', imgStrength)
  }, [imgStrength, persistChangedPreference])
  useEffect(() => {
    console.log('MemoryChat effect: persist image style')
    persistChangedPreference('imgStyle', activeStyle)
  }, [activeStyle, persistChangedPreference])
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
    console.log('MemoryChat effect: drag overlay lifecycle')
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
    page?: number
  } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [queueEdit, setQueueEdit] = useState<QueueEdit | null>(null)
  const [lightbox, setLightbox] = useState<{ url: string; path?: string } | null>(null)
  // Pro registers this slot after the core renderer starts. Resolve it on each render so an
  // execution-chat approval cannot stay hidden behind a value cached before Pro activation.
  const ChatMessagesFooter = isPro ? getSlot(SLOTS.chatMessagesFooter) : undefined
  const TaskSupervisorOverlay = isPro ? getSlot(SLOTS.taskSupervisorOverlay) : undefined
  // Esc closes the open overlay (attachment viewer / image lightbox).
  useEffect(() => {
    console.log('MemoryChat effect: overlay escape handler')
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
    console.log('MemoryChat effect: close conversation-scoped overlays')
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
  const draftInputRef = useRef<ChatDraftInputHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<PlayableClip | null>(null)
  const voiceMountedRef = useRef(true)
  const speechRequestRef = useRef(0)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  // Whether streamed output should keep scrolling to the bottom. Set from the container's onScroll
  // so it tracks the USER'S intent: pinned-to-bottom = follow; scrolled up = leave them be.
  const followBottomRef = useRef(true)
  const onScrollFollow = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const followsBottom = shouldFollowBottom(e.currentTarget)
    followBottomRef.current = followsBottom
    setShowScrollToBottom(!followsBottom)
  }, [])
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto'): void => {
    followBottomRef.current = true
    setShowScrollToBottom(false)
    bottomRef.current?.scrollIntoView({ block: 'end', behavior })
  }, [])
  // Per-conversation generation lock + queue: a send belongs to its OWN conversation,
  // never the active tab. generatingRef is the synchronous source of truth for the
  // queue decision; generatingConvs mirrors it for rendering.
  const generatingRef = useRef<Set<string>>(new Set())
  const [generatingConvs, setGeneratingConvs] = useState<Set<string>>(new Set())
  const restTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Closing the chat mid-rest settles the assistant now, rather than from a timer that outlives it.
  useEffect(
    () => () => {
      if (!restTimerRef.current) return
      clearTimeout(restTimerRef.current)
      restTimerRef.current = null
      announceAssistantActivity('idle')
    },
    []
  )
  const [replySound] = useReplySound()
  const replySoundRef = useRef(replySound)
  replySoundRef.current = replySound
  const markGenerating = useCallback((cid: string, on: boolean): void => {
    if (restTimerRef.current) clearTimeout(restTimerRef.current)
    if (on) announceAssistantActivity('working')
    else {
      // A reply (or God's reaction) arrived: the ding, unless it is off or the user stopped it.
      const arrived = generatingRef.current.has(cid) && !cancelledRef.current.has(cid)
      if (arrived && replySoundRef.current) playChime()
      announceAssistantActivity('done')
      restTimerRef.current = setTimeout(() => announceAssistantActivity('idle'), 900)
    }
    if (on) generatingRef.current.add(cid)
    else generatingRef.current.delete(cid)
    setGeneratingConvs(new Set(generatingRef.current))
  }, [])
  // Queued sends carry their attachments too, so a message waiting behind an in-flight
  // generation keeps its image/files when it finally runs — keyed per conversation.
  const queueStore = getChatQueueStore(window.api)
  const queuedRef = queueStore.ref
  const [queuedByConv, renderQueuedByConv] = useState<ChatQueues>(queuedRef.current)
  const setQueuedByConv = (queues: ChatQueues): void => {
    void queueStore
      .publish(queues)
      .catch((error) => console.error('Failed to save queued messages:', error))
  }
  useEffect(() => queueStore.subscribe(renderQueuedByConv), [queueStore])
  // Map streamId → convId so the onRagStream handler can route tokens to the right
  // conversation regardless of which tab is active when the event fires.
  // Image requests a turn receives while the model is still writing, by stream. Only comic turns
  // whose images run on a remote server register here (see the tools:chat handler).
  const earlyImageRequestByStream = useRef(
    new Map<string, (request: { prompt: string; enhancePrompt?: boolean }) => void>()
  )
  const streamConvRef = useRef<Map<string, string>>(new Map())
  // The async sender survives navigation. Its listener owns cancellation and the final
  // save; mounted views only observe it. No model "done" event releases this reservation.

  const rendererOwnsRun = (conversationId: string): boolean => {
    const detail: RunEvent = { action: 'query', conversationId }
    window.dispatchEvent(new CustomEvent('offgrid:chat-run', { detail }))
    return detail.claimed === true
  }
  const attachRendererRun = (conversationId: string): void => {
    const detail: RunEvent = { action: 'attach', conversationId, owner: streamConvRef.current }
    window.dispatchEvent(new CustomEvent('offgrid:chat-run', { detail }))
  }
  // Accumulated reasoning per streamId, mirrored from the onRagStream reasoning
  // events. Read DETERMINISTICALLY at persist time — reading it out of a
  // setConvMessages updater (a state-updater side effect) was unreliable: React
  // only runs the updater eagerly on a bail-out, else defers it to render, so the
  // read could see undefined and the persisted 'Thinking' block would vanish on
  // reload (the exact T1f bug). A ref is written synchronously and read directly.
  const reasoningByStream = useRef<Record<string, string>>({})
  const timelineByStream = useRef<Record<string, AssistantTimelineEntry[]>>({})
  const toolCallsByStream = useRef<Record<string, NonNullable<ChatMessage['toolCalls']>>>({})
  /** What the model has actually said so far, per stream — see the stream handler for why. */
  const answerByStream = useRef<Record<string, string>>({})
  // Conversations the user hit "stop" on. The in-flight send checks this at each of
  // its awaits and bails (no error bubble, no persisted junk) instead of finalizing a
  // turn the user abandoned. Cleared when the conversation's send settles.
  const cancelledRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    console.log('MemoryChat effect: voice playback lifecycle')
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
      const s = await window.api.imageGenStatus()
      if (!s) return
      setImageAvailable(!!s.available)
      const rawModels: unknown = s.models
      const models: string[] = Array.isArray(rawModels)
        ? rawModels.filter((model: unknown): model is string => typeof model === 'string')
        : []
      setImgModels(models)
      // Skip the parked/slow Core ML directory when choosing a default.
      const preferred = preferredImageModel(models)
      setImgModel(s.active || preferred)
    } catch {
      /* engine may be down; leave prior state */
    }
  }, [])
  useEffect(() => {
    console.log('MemoryChat effect: image settings subscription')
    const refreshImageSettings = (): void => {
      void Promise.all([window.api.getSettings(), refreshImageModel()]).then(([settings]) => {
        if (settings.imageParams && typeof settings.imageParams === 'object') {
          persistedPreferenceValues.current.imageParams = settings.imageParams
          setImgParamStore(settings.imageParams as ImageParamStore)
        }
        if (typeof settings.imgSeed === 'string') {
          persistedPreferenceValues.current.imgSeed = settings.imgSeed
          setImgSeed(settings.imgSeed)
        }
        if (typeof settings.imgNegative === 'string') {
          persistedPreferenceValues.current.imgNegative = settings.imgNegative
          setImgNegative(settings.imgNegative)
        }
        if (typeof settings.enhanceImagePrompts === 'boolean') {
          persistedPreferenceValues.current.enhanceImagePrompts = settings.enhanceImagePrompts
          setEnhanceImg(settings.enhanceImagePrompts)
        }
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
    console.log('MemoryChat effect: refresh image model after picker closes')
    if (prevPickerOpen.current && !modelPickerOpen) void refreshImageModel()
    prevPickerOpen.current = modelPickerOpen
  }, [modelPickerOpen, refreshImageModel])

  // Load conversations on mount; probe image gen; load projects for scoping.
  useEffect(() => {
    console.log('MemoryChat effect: initial chat data load')
    void (async () => {
      const convos = await window.api
        .getRagConversations(undefined, undefined, surface)
        .catch(() => [])
      setConversations(convos)
      // Restore every saved tab. Remove tabs for conversations that no longer exist.
      if (!openTarget && convos.length > 0) {
        const conversationIds = new Set(convos.map((conversation) => conversation.id))
        const restoredTabs = openTabs.filter((id) => conversationIds.has(id))
        if (
          activeConversationId &&
          conversationIds.has(activeConversationId) &&
          !restoredTabs.includes(activeConversationId)
        ) {
          restoredTabs.push(activeConversationId)
        }
        const first =
          convos.find((conversation) => conversation.id === activeConversationId) ??
          convos.find((conversation) => conversation.id === restoredTabs[0]) ??
          convos[0]!
        setActiveConversationId(first.id)
        setActiveProjectId((first as { project_id?: string | null }).project_id ?? null)
        setOpenTabs(restoredTabs.length > 0 ? restoredTabs : [first.id])
        try {
          const nextMessages = await loadLatestConversationMessages(first.id)
          if (nextMessages) replaceDurableMessages(first.id, nextMessages)
        } catch {
          replaceDurableMessages(first.id, [])
        }
      }
    })()
    void refreshImageModel()
    window.api
      .listProjects()
      .then((p: ProjectLite[]) => setProjects(p))
      .catch(() => {})
    window.api
      .styleThumbs()
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
    console.log('MemoryChat effect: resolve image parameters')
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
      .setActiveModalModel('image', value)
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
  useEffect(() => {
    console.log('MemoryChat effect: persist image parameters')
    persistChangedPreference('imageParams', imgParamStore)
  }, [imgParamStore, persistChangedPreference])

  const activeProjectName = projects.find((p) => p.id === activeProjectId)?.name ?? null

  const loadProjects = useCallback(async () => {
    try {
      setProjects((await window.api.listProjects()) || [])
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
  const createAndAssignProject = useCallback(
    async (typedName: string) => {
      const name = typedName.trim()
      if (!name) {
        setProjCreating(false)
        return
      }
      try {
        const id = await window.api.createProject({ name })
        await loadProjects()
        if (id) await assignProject(id)
      } catch (e) {
        console.error('Failed to create project', e)
      }
    },
    [loadProjects, assignProject]
  )

  useEffect(() => {
    console.log('MemoryChat effect: follow streamed messages')
    // Follow the stream to the bottom ONLY while the user hasn't scrolled up. followBottomRef is
    // driven by the container's onScroll (below), so it reflects the user's intent — not a
    // mid-animation position. Instant (not smooth): a smooth animation kept scrollTop near the
    // bottom between tokens, so the next token re-measured as "near bottom" and re-scrolled — a
    // feedback loop that made it impossible to scroll up during generation.
    if (followBottomRef.current) {
      scrollToBottom()
    }
  }, [messages.length, loading, scrollToBottom])

  const followStreamRender = useCallback(() => {
    if (followBottomRef.current) scrollToBottom()
  }, [scrollToBottom])

  // Opening / switching a chat lands you at the latest message (after it loads).
  const justSwitched = useRef(false)
  useEffect(() => {
    console.log('MemoryChat effect: reset scroll follow for conversation')
    justSwitched.current = true
    // A fresh conversation opens pinned to the bottom: reset the follow flag so a scroll-up in the
    // PREVIOUS chat doesn't leave the new one refusing to auto-scroll its stream.
    followBottomRef.current = true
    setShowScrollToBottom(false)
  }, [activeConversationId])
  useEffect(() => {
    console.log('MemoryChat effect: scroll after conversation switch')
    if (!justSwitched.current || !messages.length) return
    justSwitched.current = false
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()))
  }, [messages.length, activeConversationId, scrollToBottom])

  // Image jobs survive this component. Subscribe before reading the snapshot so a
  // navigation/remount cannot miss the transition between status and observation.
  // Cleanup only detaches observers; explicit Stop is the sole cancellation path.
  useEffect(() => {
    console.log('MemoryChat effect: image job subscription')
    let live = true
    const observe = (job: ImageGenerationJobContract): void => {
      if (!live || !job.conversationId) return
      if (job.phase === 'running') {
        attachRendererRun(job.conversationId)
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
      // The sender saves the message after the native job reaches its terminal phase.
      // Its settled signal releases both the local and any reattached queue.
      // Without a sender, the native terminal event must release and drain it.
      if (
        !rendererOwnsRun(job.conversationId) &&
        ![...streamConvRef.current.values()].includes(job.conversationId)
      ) {
        markGenerating(job.conversationId, false)
        drainQueue(job.conversationId)
      }
    }
    const offJob = window.api.onImageGenJobState(observe)
    const offConversation = window.api.onImageGenConversationUpdated((conversationId) => {
      void refreshConversationMessages(conversationId).catch((error) =>
        console.error('Failed to refresh generated image message', error)
      )
    })
    void window.api
      .imageGenJobStatus()
      .then(observe)
      .catch((error) => console.error('Failed to reattach image generation', error))
    return () => {
      live = false
      offJob()
      offConversation()
    }
  }, [refreshConversationMessages, markGenerating])

  const conversationListRequestRef = useRef<Promise<void> | null>(null)
  const conversationListRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const staleConversationIdsRef = useRef(new Set<string>())
  const [switchingConversationId, setSwitchingConversationId] = useState<string | null>(null)

  const loadConversations = useCallback(async (): Promise<void> => {
    if (conversationListRequestRef.current) return conversationListRequestRef.current
    const request = (async () => {
      try {
        const convos = await window.api.getRagConversations(undefined, undefined, surface)
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

  useEffect(() => {
    console.log('MemoryChat effect: conversation refresh timer cleanup')
    return () => {
      if (conversationListRefreshTimerRef.current) {
        clearTimeout(conversationListRefreshTimerRef.current)
      }
    }
  }, [])

  const switchConversation = useCallback(
    async (convId: string, replaceActiveTab = false) => {
      if (convId === activeConversationId) return
      setOpenTabs((tabs) => {
        if (!replaceActiveTab) return tabs.includes(convId) ? tabs : [...tabs, convId]
        const next = tabs.filter((id) => id !== convId)
        const activeIndex = activeConversationId ? next.indexOf(activeConversationId) : -1
        if (activeIndex < 0) return [...next, convId]
        next[activeIndex] = convId
        return next
      })
      setActiveConversationId(convId)
      setActiveProjectId(conversations.find((c) => c.id === convId)?.project_id ?? null)
      setSwitchingConversationId(convId)
      // Open tabs already own their rendered messages. A fresh read here rebuilt the
      // whole transcript and rendered it a second time on every idle tab switch.
      const stale = staleConversationIdsRef.current.delete(convId)
      if (messagesByConvRef.current[convId] && !stale) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setSwitchingConversationId((current) => (current === convId ? null : current))
          })
        })
        return
      }
      try {
        const nextMessages = await loadLatestConversationMessages(convId)
        if (!nextMessages) return
        // Refresh from DB, but never clobber an in-flight stream for this conversation.
        setConvMessages(convId, (previous) =>
          previous.some((message) => message.streaming) ? previous : nextMessages
        )
      } catch (e) {
        console.error('Failed to load messages:', e)
      } finally {
        setSwitchingConversationId((current) => (current === convId ? null : current))
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
  // the visible thread now. Defer hidden chat and sidebar work until the user opens that surface.
  //
  // Skipped while THIS device is generating in that conversation: the in-flight reply lives in local
  // state and re-reading the table mid-stream would drop it.
  useEffect(() => {
    console.log('MemoryChat effect: conversation change subscription')
    const off = window.api.onRagConversationsChanged?.(({ conversationId }) => {
      void (async () => {
        try {
          if (
            conversationId &&
            generatingRef.current.has(conversationId) &&
            !rendererOwnsRun(conversationId) &&
            [...streamConvRef.current.values()].includes(conversationId)
          ) {
            // Main-owned bridge runs publish this only after their assistant row is saved.
            await settleObservedRun(conversationId)
          }
          if (conversationId && !generatingRef.current.has(conversationId)) {
            if (conversationId === activeConversationId) {
              await refreshConversationMessages(conversationId)
            } else {
              // The next visit must load a peer's new messages, not the old tab cache.
              staleConversationIdsRef.current.add(conversationId)
            }
          }
          if (conversationId === activeConversationId || !conversationsToggleWillShow) {
            scheduleConversationListRefresh()
          }
        } catch (error) {
          console.error('Failed to refresh a synced conversation:', error)
        }
      })()
    })
    return () => off?.()
  }, [
    activeConversationId,
    conversationsToggleWillShow,
    refreshConversationMessages,
    scheduleConversationListRefresh
  ])

  // Task guidance is written to the originating conversation by the Tasks
  // workspace. Refresh that conversation immediately so its special guidance
  // turn appears beside the task without waiting for a sync round trip.
  useEffect(() => {
    console.log('MemoryChat effect: task guidance subscription')
    const onTaskGuidanceMessage = (event: Event): void => {
      const conversationId = (event as CustomEvent<{ conversationId?: string }>).detail
        .conversationId
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
    console.log('MemoryChat effect: open chat target')
    if (!openTarget) return
    ;(async () => {
      try {
        setPresetSetup(null)
        setApprovalSetup(null)
        if (openTarget.conversationId) {
          const convId = openTarget.conversationId
          setActiveConversationId(convId)
          setOpenTabs((t) => (t.includes(convId) ? t : [...t, convId]))
          const conv = await window.api.getRagConversation(convId)
          setActiveProjectId((conv as { project_id?: string | null }).project_id ?? null)
          const nextMessages = await loadLatestConversationMessages(convId)
          if (nextMessages) replaceDurableMessages(convId, nextMessages)
          if (openTarget.approvalId) {
            const approval = await window.api.proInvoke?.('approvals:for-execution-chat', convId)
            setApprovalSetup((approval as ApprovalSetupRecord | null | undefined) ?? null)
          }
          if (openTarget.draftPrompt) draftStore.set(openTarget.draftPrompt)
        } else if (openTarget.projectId) {
          setActiveConversationId(null)
          setConvMessages(null, [])
          setActiveProjectId(openTarget.projectId)
        } else if (openTarget.presetId) {
          setActiveConversationId(null)
          setConvMessages(null, [])
          setActiveProjectId(null)
          setPresetSetup(presetById(openTarget.presetId) ?? null)
          setToolsOn(true)
        } else if (openTarget.draftPrompt) {
          setActiveConversationId(null)
          setConvMessages(null, [])
          setActiveProjectId(null)
          draftStore.set(openTarget.draftPrompt)
        }
        if (openTarget.openGallery) setShowGallery(true)
        if (openTarget.draftPrompt) requestAnimationFrame(() => draftInputRef.current?.focus())
        await loadConversations()
      } catch (e) {
        console.error('Failed to open chat target:', e)
      } finally {
        onTargetConsumed?.()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTarget])

  useEffect(() => {
    console.log('MemoryChat effect: approval intake subscription')
    const openApprovalIntake = (event: Event): void => {
      const approvalId = (event as CustomEvent<{ approvalId?: number }>).detail.approvalId
      if (!approvalId) return
      void window.api
        .proInvoke?.('approvals:list')
        .then((approvals) => {
          const match = Array.isArray(approvals)
            ? (approvals as ApprovalSetupRecord[]).find(
                (approval) => Number(approval.id) === approvalId
              )
            : undefined
          if (match) setApprovalSetup(match)
        })
        .catch(() => undefined)
    }
    window.addEventListener('og:approval-intake', openApprovalIntake)
    return () => window.removeEventListener('og:approval-intake', openApprovalIntake)
  }, [])

  const startNewConversation = useCallback(() => {
    setActiveConversationId(null)
    setConvMessages(null, []) // clear the fresh-chat bucket
    setActiveProjectId(null)
    setPresetSetup(null)
    setApprovalSetup(null)
  }, [setConvMessages])

  const deleteConversation = useCallback(
    async (convId: string) => {
      try {
        await window.api.deleteRagConversation(convId)
        // Drop the deleted conversation's cached messages; reset to a fresh chat if active.
        const nextMessages: Record<string, ChatMessage[]> = {
          ...messagesByConvRef.current,
          [NEW_CHAT]: []
        }
        delete nextMessages[convId]
        messagesByConvRef.current = nextMessages
        setMessagesByConv(nextMessages)
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

  function listenToRun(
    convId: string,
    runId: string,
    activeStream?: () => string | undefined
  ): () => void {
    streamConvRef.current.set(runId, convId)
    const observeRun = (event: Event): void =>
      observeOwnedRun((event as CustomEvent<RunEvent>).detail, convId, runId, {
        cancelledRef,
        queuedRef,
        setQueuedByConv,
        answerByStream,
        reasoningByStream,
        timelineByStream,
        toolCallsByStream,
        cancelRag: (id) => window.api.cancelRag(id),
        activeStream
      })
    window.addEventListener('offgrid:chat-run', observeRun)
    return () => {
      window.removeEventListener('offgrid:chat-run', observeRun)
      streamConvRef.current.delete(runId)
    }
  }

  function announceRunSettled(convId: string): boolean {
    cancelledRef.current.delete(convId)
    markGenerating(convId, false)
    setLoading(false)
    const detail: RunEvent = {
      action: 'settled',
      conversationId: convId,
      owner: streamConvRef.current,
      messages: messagesByConvRef.current[convId]
    }
    window.dispatchEvent(new CustomEvent('offgrid:chat-run', { detail }))
    return detail.claimed === true
  }

  const sendMessage = async (
    override?: string,
    opts?: {
      regen?: boolean
      priorVariants?: ResponseVersion[]
      /** The saved answer a retry's new answer sits beside (shown in its place while it streams). */
      versionOf?: string
      priorAnswer?: ChatMessage
      replacementMessageId?: string
      history?: ChatMessage[]
      sendNow?: boolean
      voiceClip?: { url: string; duration: number; path?: string }
      atts?: Attachment[]
      conversationId?: string
      imageRequest?: ImageGenerationRequestContract
      projectIdOverride?: string | null
      modeOverride?: ChatMode
      /** A form submission is user input even though its text is supplied as an argument. */
      asUserInput?: boolean
      /** Captured when a queued turn was submitted; Assistant never persists between turns. */
      assistantEnabled?: boolean
    }
  ): Promise<void> => {
    const isInput = override === undefined || opts?.asUserInput === true
    // Regenerate/Resend: the user turn already exists in the thread — re-run it
    // in place instead of echoing another user bubble.
    const regen = opts?.regen ?? false
    const turnMode = opts?.modeOverride ?? mode
    // God always acts (it is Pro) and reads every account; Chat's Assistant is per turn.
    const assistantForTurn = god ? true : (opts?.assistantEnabled ?? toolsOn)
    if (!regen && opts?.assistantEnabled === undefined) setToolsOn(false)
    // Lock the project for THIS send at send-time, like convId — every attribution
    // below (RAG scope, saved artifacts, generated images) uses it. Reading the live
    // `activeProjectId` at each await instead let a mid-stream project switch land
    // this turn's output in the WRONG project (D21).
    const projectId = god
      ? null
      : opts?.projectIdOverride !== undefined
        ? opts.projectIdOverride
        : activeProjectId
    // Attachments (pasted blocks + processed files) ride along on a normal send
    // from the composer, or on a drained queue item (opts.atts) — not on
    // resend/regenerate/example.
    const atts =
      opts?.atts ??
      (isInput ? attachments.filter((a) => a.status === 'ready' && (a.text || a.path)) : [])
    const typed = (override ?? draftStore.getSnapshot()).trim()
    // The user sees `trimmed`; the model also gets the attachment text folded in.
    const trimmed =
      typed || (atts.length ? `(${atts.length} attachment${atts.length > 1 ? 's' : ''})` : '')
    // Documents are not pasted into the question: main reads every document attached to the
    // conversation and gives the model what fits (documents/chat-turn.ts).
    const turnDocuments = atts
      .filter((a) => a.kind !== 'image' && (a.documentId || a.text))
      .map((a) => ({
        ...(a.documentId ? { documentId: a.documentId } : {}),
        name: a.name,
        kind: a.kind,
        ...(a.path ? { path: a.path } : {}),
        // Pasted text has no file; transcripts and old attachments are read from their text.
        ...(!a.documentId || a.kind === 'pasted' ? { text: a.text } : {})
      }))
    // Actual image files go to the multimodal model (not just their captions).
    const imagePaths = atts.filter((a) => a.kind === 'image' && a.path).map((a) => a.path as string)
    let modelQuery = (
      typed ||
      (turnDocuments.length
        ? `What is in ${turnDocuments.length > 1 ? 'these documents' : 'this document'}? Give a short overview.`
        : '')
    ).trim()
    if (!typed && atts.length === 0) return
    // Don't block the user — if a generation is in flight, queue this message and
    // let them keep typing/sending. The queue drains in order when each finishes.
    const targetConv = opts?.conversationId ?? activeConversationId
    const stopTarget = targetConv
      ? captureStopTarget(
          streamConvRef.current,
          messagesByConvRef.current[targetConv] ?? [],
          targetConv
        )
      : undefined
    if (
      !regen &&
      (await submitQueuedTurn(
        queueStore,
        targetConv,
        generatingRef.current,
        {
          id: crypto.randomUUID(),
          text: typed,
          atts,
          assistantEnabled: assistantForTurn,
          projectId,
          mode: turnMode
        },
        {
          draftStore,
          sendNow: opts?.sendNow,
          clearDraft: isInput
            ? () => {
                draftStore.update((current) => queuedDraftAfterSave(current, typed))
                setAttachments((current) => queuedAttachmentsAfterSave(current, atts))
              }
            : undefined,
          stop: () =>
            stopGeneration(
              targetConv,
              guidanceTaskForJourney(getTaskSessionState().tasks, targetConv),
              true,
              stopTarget
            )
        }
      ))
    )
      return
    // A live operator task owns this journey until it finishes. New Chat input is
    // guidance for that task, not a second memory/model turn running beside it.
    if (!regen && targetConv && !opts?.imageRequest) {
      const listedTasks = await window.api.tasks?.list(50)
      const liveTask = guidanceTaskForJourney(
        listedTasks ?? getTaskSessionState().tasks,
        targetConv
      )
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
            draftStore.set('')
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
    if (isInput) setAttachments([])

    // An installed /skill-name anywhere in the prompt prepends that skill's instructions.
    if (isInput) {
      const skillMention = /(^|\s)\/([A-Za-z0-9_-]+)(?=\s|$)/.exec(typed)
      const skillName = skillMention?.[2]
      if (skillName && skills.some((s) => s.name.toLowerCase() === skillName.toLowerCase())) {
        try {
          const sk = await window.api.getSkill(skillName)
          if (sk) {
            const rest =
              `${typed.slice(0, skillMention!.index)}${skillMention![1]}${typed.slice(skillMention!.index + skillMention![0].length)}`.trim()
            modelQuery =
              `# Skill: ${sk.name}\n${sk.instructions}\n\n${rest}`.trim()
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
        await window.api.createRagConversation(convId, title, projectId, surface)
        const now = new Date().toISOString()
        const createdConversation: RagConversationContract = {
          id: convId,
          title,
          project_id: projectId,
          created_at: now,
          updated_at: now,
          message_count: 0
        }
        setConversations((current) =>
          current.some((conversation) => conversation.id === convId)
            ? current
            : [createdConversation, ...current]
        )
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
    const runId = `send-${crypto.randomUUID()}`
    let activeStreamId: string | undefined
    const releaseRun = listenToRun(convId, runId, () => activeStreamId)
    const settleRun = async (): Promise<void> => {
      releaseRun()
      if (activeStreamId) streamConvRef.current.delete(activeStreamId)
      if (!announceRunSettled(convId)) drainQueue(convId)
      await loadConversations()
    }
    try {
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

      const userMessageId = crypto.randomUUID()
      // This turn's own user message (its draft id, then its saved id). It is already in the
      // conversation by the time history is built, and the request carries it as its own turn.
      const currentTurnIds = new Set<string>([userMessageId])
      if (!regen) {
        const userMessage: ChatMessage = {
          id: userMessageId,
          role: 'user',
          createdAt: Date.now(),
          content: trimmed,
          attachments: [
            ...atts.map((a) => ({
              name: a.name,
              kind: a.kind,
              text: a.text,
              path: a.path,
              ...(a.documentId ? { documentId: a.documentId } : {}),
              ...(a.pages ? { pages: a.pages } : {})
            })),
            // Drawn now, not only after a reload. Persisting it without this left the turn looking as
            // though nothing had been attached until the conversation was loaded again.
            ...(initAttachment
              ? [
                  {
                    name: initAttachment.name,
                    kind: initAttachment.kind,
                    path: initAttachment.path
                  }
                ]
              : []),
            ...(opts?.voiceClip?.path
              ? [
                  {
                    name: opts.voiceClip.path.split(/[\\/]/).at(-1) || 'voice.webm',
                    kind: 'audio' as const,
                    path: opts.voiceClip.path
                  }
                ]
              : [])
          ],
          audioUrl: opts?.voiceClip?.url,
          audioDuration: opts?.voiceClip?.duration
        }
        setConvMessages(convId, (prev) => [...prev, userMessage])
      }
      if (isInput && draftStore.getSnapshot().trim() === typed) draftStore.set('')
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
            createdAt: a.createdAt,
            ...(a.documentId ? { documentId: a.documentId } : {}),
            ...(a.pages ? { pages: a.pages } : {})
          }))
          // Appended, never folded into `atts`: those are what the MODEL is given, and the init image is
          // an input to the image runtime rather than text for the language model to read.
          const voiceAttachment = opts?.voiceClip?.path
            ? {
                name: opts.voiceClip.path.split(/[\\/]/).at(-1) || 'voice.webm',
                kind: 'audio' as const,
                path: opts.voiceClip.path
              }
            : undefined
          const persisted = [
            ...attMeta,
            ...(initAttachment ? [initAttachment] : []),
            ...(voiceAttachment ? [voiceAttachment] : [])
          ]
          const stored = await window.api.addRagMessage(
            convId,
            'user',
            trimmed,
            persisted.length ? { attachments: persisted } : undefined
          )
          currentTurnIds.add(stored.uuid)
          setConvMessages(convId, (previous) =>
            previous.map((message) =>
              message.id === userMessageId ? { ...message, id: stored.uuid } : message
            )
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
      // All memory adds search_memory to the normal tool catalog. Assistant and
      // Connectors keep their own opt-in state.
      if (cancelledRef.current.has(convId)) return
      const explicitAgentic = isAgenticTurn({ toolsOn: assistantForTurn, connectorsOn })
      const autoImage = shouldAutoRouteImage({
        mode: turnMode,
        imageAvailable,
        agenticActive: explicitAgentic,
        text: trimmed
      })
      if (opts?.imageRequest || turnMode === 'image' || autoImage) {
        if (regen && opts?.history) setConvMessages(convId, opts.history)
        setShowImageOptions(false)
        setImgProgress(null)
        setImageGenConv(convId)
        const seedNum = imgSeed.trim() === '' ? -1 : parseInt(imgSeed, 10)
        const styleObj = STYLE_PRESETS.find((s) => s.name === activeStyle)
        // In explicit image mode keep the exact prompt (+ any chosen style); on
        // auto-route strip the "draw/generate an image of" phrasing to the subject.
        const basePrompt = turnMode === 'image' ? trimmed : cleanImagePrompt(trimmed)
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
          enhancePrompt: enhanceImg,
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
            width: img.width ?? imageRequest.width ?? imgSize,
            height: img.height ?? imageRequest.height ?? imgSize,
            steps: img.steps ?? imageRequest.steps ?? imgSteps,
            cfgScale: img.cfgScale ?? imageRequest.cfgScale ?? imgCfgScale,
            seed:
              typeof img.seed === 'number'
                ? img.seed
                : (imageRequest.seed ?? (Number.isNaN(seedNum) ? -1 : seedNum)),
            model: typeof img.model === 'string' ? img.model : imageRequest.model
          }
          const imageMetrics: GenerationMetrics | undefined =
            typeof img.durationMs === 'number'
              ? {
                  computeBackend: img.computeBackend,
                  modelName: img.model,
                  totalSeconds: img.durationMs / 1000
                }
              : undefined
          const completedImage = completedImageMessage(
            `Generated for: ${trimmed}`,
            imageRequest.prompt,
            img.prompt
          )
          const imageContext = withGeneratedImageReference(
            {
              imageMetadata,
              ...(img.durationMs === undefined ? {} : { durationMs: img.durationMs }),
              ...(imageMetrics ? { metrics: imageMetrics } : {})
            },
            { id: img.syncId, path: img.path }
          )
          // A regenerate keeps the answers it replaces as earlier versions of this one.
          const assistantMessage = withAnswerVersions(
            {
              id: `a-${Date.now()}`,
              role: 'assistant',
              createdAt: Date.now(),
              ...completedImage,
              image: img.dataUrl,
              imagePath: img.path,
              imageMetadata,
              context: imageContext as RagContext,
              ...(img.durationMs === undefined ? {} : { generationTimeMs: img.durationMs }),
              ...(imageMetrics ? { metrics: imageMetrics } : {})
            },
            opts?.priorVariants
          )
          setConvMessages(convId, (prev) => [...prev, assistantMessage])
          if (voiceMode) setAutoPlayId(assistantMessage.id)
          try {
            const stored = opts?.replacementMessageId
              ? await window.api.updateRagMessage(
                  convId,
                  opts.replacementMessageId,
                  completedImage.storedContent,
                  assistantMessage.context
                )
              : await window.api.addRagMessage(
                  convId,
                  'assistant',
                  completedImage.storedContent,
                  assistantMessage.context
                )
            if (!stored) throw new Error('Saved response was not found')
            const storedId = stored === true ? opts!.replacementMessageId! : stored.uuid
            setConvMessages(convId, (previous) =>
              previous.map((message) =>
                message.id === assistantMessage.id ? { ...message, id: storedId } : message
              )
            )
            await announceImageMessagePersisted(convId, storedId)
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
                createdAt: Date.now(),
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
          setImgProgress(null)
          setImageGenConv((c) => (c === convId ? null : c))
        }
        return
      }

      // History is built from the TARGET conversation's own messages (never the
      // active tab's `messages`) — a drained-queue or background send is bound to
      // `convId`, so its history must come from that conversation (D8).
      const fullHistory = buildSendHistory(
        (opts?.history ?? messagesByConvRef.current[convId] ?? EMPTY_MSGS).filter(
          (message) => !currentTurnIds.has(message.id)
        ),
        !!regen,
        trimmed,
        20,
        Number.MAX_SAFE_INTEGER
      )
      // Main Chat path. The model calls built-in tools,
      // plus (when Connectors is on) MCP connector tools. STREAMS the answer:
      // a streamId placeholder fills in live - thinking, then each tool-call activity
      // step, then the answer - and the stop button aborts it via rag:cancel.
      if (cancelledRef.current.has(convId)) return
      const toolStreamId = `a-${crypto.randomUUID()}`
      activeStreamId = toolStreamId
      streamConvRef.current.set(toolStreamId, convId!)
      const toolStreamMessage: ChatMessage = {
        id: toolStreamId,
        replacementMessageId: opts?.replacementMessageId,
        ...(opts?.versionOf ? { versionOf: opts.versionOf } : {}),
        role: 'assistant',
        // Stamped when the reply starts, so its time shows the moment it finishes, not after a reload.
        createdAt: Date.now(),
        content: '',
        reasoning: '',
        reasoningRequested: thinkingEnabled,
        streaming: true,
        variants: opts?.priorVariants ? [...opts.priorVariants, ''] : undefined,
        variantIndex: opts?.priorVariants?.length
      }
      seedStreamViewMessage(toolStreamMessage)
      setConvMessages(convId, (prev) => [
        ...(regen && opts?.history ? opts.history : prev),
        toolStreamMessage
      ])
      window.dispatchEvent(
        new CustomEvent<RunEvent>('offgrid:chat-run', {
          detail: {
            action: 'started',
            conversationId: convId,
            owner: streamConvRef.current,
            messages: messagesByConvRef.current[convId]
          }
        })
      )
      const comicPageTotal = modelQuery.includes('<!-- offgrid-action:comic-book -->')
        ? comicBookPageCount(modelQuery)
        : null
      const comicPages: ComicBookPage[] = []
      let comicTitle = comicPageTotal ? (comicBookTitle(modelQuery) ?? 'Comic Book') : 'Comic Book'
      let comicReaderMessageId = `comic-reader-${toolStreamId}`
      // The written answer, shown above the reader while its pages generate (set after the text turn).
      let comicAnswer = ''
      // Failed pages are reported inside the reader row: a separate row after it would become the
      // row Chat shows for the turn and hide both the answer and the reader.
      const comicFailures: ChatMessage[] = []
      const comicReaderPersistence = { saved: false }
      let comicArtifactId: string | null = null
      const updateComicReader = async (): Promise<void> => {
        if (!comicPageTotal) return
        const html = buildComicBookReader(comicPages, comicPageTotal, comicTitle)
        const previousMessageId = comicReaderMessageId
        const content = `Comic book reader: ${comicPages.length} of ${comicPageTotal} pages ready.\n\n\`\`\`html\n${html}\n\`\`\``
        // The card must exist in chat storage before a conversation refresh or
        // renderer remount. The artifact gallery alone cannot restore a chat row.
        try {
          if (comicReaderPersistence.saved) {
            const updated = await window.api.updateRagMessage(convId, comicReaderMessageId, content)
            if (!updated) throw new Error('Comic reader message was not found')
          } else {
            const stored = await window.api.addRagMessage(convId, 'assistant', content)
            comicReaderMessageId = stored.uuid
            comicReaderPersistence.saved = true
          }
        } catch (error) {
          console.error('Failed to save the comic reader message:', error)
        }
        setConvMessages(convId, (previous) => {
          const reader: ChatMessage = {
            id: comicReaderMessageId,
            role: 'assistant',
            // The finished turn saves the answer above the reader in this one row. Chat shows a tool
            // turn through its last answering row, so the tool row's own text is not shown here.
            content: [comicAnswer, content, ...comicFailures.map((failure) => failure.content)]
              .filter((text) => text.trim())
              .join('\n\n')
          }
          const existing = previous.findIndex(
            (message) => message.id === comicReaderMessageId || message.id === previousMessageId
          )
          return existing === -1
            ? [...previous, reader]
            : previous.map((message, index) => (index === existing ? reader : message))
        })
        setCanvasArtifact({ kind: 'html', code: html, title: comicTitle })
        try {
          const previousArtifactId = comicArtifactId
          const saved = await window.api.saveArtifact({
            kind: 'html',
            code: html,
            title: comicTitle,
            conversationId: convId,
            projectId
          })
          comicArtifactId = saved.id
          setArtifacts((current) => [
            saved,
            ...current.filter(
              (artifact) => artifact.id !== saved.id && artifact.id !== previousArtifactId
            )
          ])
          if (previousArtifactId && previousArtifactId !== saved.id) {
            await window.api.deleteArtifact(previousArtifactId)
          }
        } catch {
          /* The live reader remains available if artifact persistence fails. */
        }
      }
      if (comicPageTotal) await updateComicReader()
      // The hero reference is kept before the turn so a page can start as soon as its prompt is
      // written.
      const comicHeroSource = comicPageTotal ? comicBookHeroImage(modelQuery) : null
      const keptComicHero = comicHeroSource
        ? await window.api.keepInitImage(comicHeroSource).catch(() => null)
        : null
      const comicHeroPath = keptComicHero?.path ?? comicHeroSource
      const imageGenerationParams = (imageRequest: {
        prompt: string
        enhancePrompt?: boolean
      }): Parameters<typeof window.api.generateImage>[0] => {
        const comicPage = comicPageTotal ? comicBookPageFromPrompt(imageRequest.prompt) : null
        return {
          prompt: comicPage?.prompt ?? imageRequest.prompt,
          ...(imageRequest.enhancePrompt === undefined
            ? {}
            : { enhancePrompt: imageRequest.enhancePrompt }),
          ...(comicHeroPath
            ? { initImage: comicHeroPath, strength: 0.72 }
            : keptInit?.path || imagePaths[0] || imgInit
              ? {
                  initImage: keptInit?.path ?? imagePaths[0] ?? imgInit ?? undefined,
                  strength: imgStrength
                }
              : {}),
          conversationId: convId,
          projectId: projectId
        }
      }
      // Comic pages still generate one at a time. With a remote image server, each page starts
      // when the model finishes writing its prompt instead of after every prompt is written; the
      // finished turn then shows these results in page order.
      const earlyComicImages = new Map<string, ReturnType<typeof window.api.generateImage>>()
      let earlyComicChain: Promise<unknown> = Promise.resolve()
      let earlyComicCancelled = false
      if (comicPageTotal) {
        earlyImageRequestByStream.current.set(toolStreamId, (request) => {
          if (
            earlyComicCancelled ||
            cancelledRef.current.has(convId) ||
            earlyComicImages.has(request.prompt)
          ) return
          const image = earlyComicChain.then(() =>
            earlyComicCancelled || cancelledRef.current.has(convId)
              ? Promise.reject(new Error('Image generation cancelled.'))
              : window.api.generateImage(imageGenerationParams(request))
          )
          image.catch(() => {
            /* The finished turn reports this page's failure in place. */
          })
          earlyComicChain = image.catch(() => undefined)
          earlyComicImages.set(request.prompt, image)
        })
      }
      const tr = await window.api
        .toolChat(modelQuery, fullHistory.slice(0, -1), {
        assistantOnly: assistantForTurn,
        connectors: god ? true : connectorsOn,
        conversationId: convId,
        // Memory scope drives which memory tools the model gets: a project offers its
        // knowledge base; "All memory" offers search_memory; "No memory" offers neither.
        projectId: projectId ?? undefined,
        allMemory: god ? true : !projectId && !noMemory,
        // God is set up to do everything: every tool, and the selected model reasoning.
        ...(god ? { context: god.context(), rules: god.rules?.(), allTools: true } : {}),
        images: imagePaths,
        ...(turnDocuments.length ? { documents: turnDocuments } : {}),
        imageAvailable,
        streamId: toolStreamId,
        thinking: god ? true : thinkingEnabled
        })
        .catch(async (error) => {
          earlyComicCancelled = true
          if (earlyComicImages.size) await window.api.cancelImageGen().catch(() => {})
          await earlyComicChain
          throw error
        })
        .finally(() => earlyImageRequestByStream.current.delete(toolStreamId))
      const toolCalls: ProjectedSyncedTool[] = (tr?.toolCalls || []).map(
        (c: { name: string; result: string; status?: 'completed' | 'failed' | 'pending' }) => ({
          name: c.name,
          result: c.result,
          status: c.status ?? ('completed' as const)
        })
      )
      const context = tr?.unified?.length ? { unified: tr.unified } : undefined
      // Persist the citation sources + tool calls so they survive a reload.
      const toolCtx =
        tr?.unified?.length || toolCalls.length || tr?.toolsOffered?.length
          ? { unified: tr?.unified ?? [], toolCalls, toolsOffered: tr?.toolsOffered }
          : undefined
      if (cancelledRef.current.has(convId)) {
        // Stop also ends a comic page that started while the model was writing.
        earlyComicCancelled = true
        if (earlyComicImages.size) await window.api.cancelImageGen().catch(() => {})
        await earlyComicChain
        // The tool calls made before the stop are kept, exactly as a completed tool turn keeps
        // them: rendered from `toolCalls`, stored in `toolCtx` beside the citation sources.
        await finalizeStoppedTurn(convId, toolStreamId, {
          answer: tr?.answer,
          context,
          persistContext: toolCtx,
          toolCalls,
          toolsOffered: tr?.toolsOffered
        })
        return
      }
      const answer = tr?.answer || 'No response returned.'
      const priorVariants = opts?.priorVariants
      let imageRequests = tr?.imageRequests ?? []
      if (imageRequests.length === 0 && tr?.imageRequest?.prompt) {
        imageRequests = [tr.imageRequest]
      }
      // Older local models can request an image with a fenced prompt instead
      // of calling generate_image. Keep that request on this same Chat path.
      const fencedImagePrompt = answer.match(/```image\s*\n([\s\S]*?)```/i)?.[1]?.trim()
      let fencedImageRequest = false
      if (imageRequests.length === 0 && fencedImagePrompt) {
        imageRequests = [{ prompt: fencedImagePrompt }]
        fencedImageRequest = true
      }
      // A normal image-tool answer is visible text and must survive the handoff
      // to the deferred native job. A legacy fenced image prompt is transport
      // markup, so keep only that one hidden.
      const visibleToolAnswer = fencedImageRequest ? '' : answer
      // Reasoning read from the ref (populated as it streamed) — deterministic,
      // unlike reading it out of the setConvMessages updater. Rides the persisted
      // context blob so the 'Thinking' block survives reload (T1f).
      const toolReasoning = reasoningByStream.current[toolStreamId]
      const toolTimeline = timelineByStream.current[toolStreamId]
      delete reasoningByStream.current[toolStreamId] // done with this stream — free it
      delete timelineByStream.current[toolStreamId]
      delete answerByStream.current[toolStreamId]
      const pendingToolCalls = toolCalls.map((toolCall) =>
        imageRequests.length > 0 && toolCall.name === 'generate_image'
          ? { ...toolCall, status: 'running' as const }
          : toolCall
      )
      const allVariants = appendAnswerVersion(priorVariants, {
        id: toolStreamId,
        role: 'assistant',
        content: answer,
        context: toolCtx,
        reasoning: toolReasoning,
        timeline: toolTimeline,
        toolCalls: pendingToolCalls,
        toolsOffered: tr?.toolsOffered,
        metrics: tr?.metrics,
        cutoff: tr?.cutoff
      })
      // Keep the tool timeline in place while its deferred image job runs. The completed image
      // replaces this row, so the timeline does not disappear and then return in a new position.
      setConvMessages(convId, (prev) =>
        prev.map((message) =>
          message.id === toolStreamId
            ? {
                ...message,
                content: imageRequests.length > 0 ? visibleToolAnswer : answer,
                context,
                reasoning: toolReasoning,
                toolCalls: pendingToolCalls,
                timeline: toolTimeline,
                toolsOffered: tr?.toolsOffered,
                metrics: tr?.metrics,
                cutoff: tr?.cutoff,
                variants: allVariants,
                variantIndex: allVariants ? allVariants.length - 1 : undefined,
                activity: undefined,
                streaming: false
              }
            : message
        )
      )
      const toolCtxWithReasoning = buildAssistantContext(toolCtx, {
        reasoning: toolReasoning,
        timeline: toolTimeline,
        metrics: tr?.metrics,
        cutoff: tr?.cutoff,
        variants: allVariants,
        variantIndex: allVariants ? allVariants.length - 1 : undefined
      })
      const artifact = parseArtifact(answer)
      if (artifact) {
        void window.api
          .saveArtifact({
            kind: artifact.kind,
            code: artifact.code,
            conversationId: convId,
            projectId
          })
          .catch(() => {
            /* The answer remains available if artifact persistence fails. */
          })
      }
      // Deferred image generation: the tool loop only RECORDS prompts (it never generates inline,
      // which would evict the LLM). Each completed request gets one generated file and one durable
      // assistant image message. A message context has one imageRef by design; putting two results
      // on one row would make the last context write replace the first association.
      if (imageRequests.length > 0 && !cancelledRef.current.has(convId)) {
        // The tool loop has finished its text answer and handed ownership to the
        // deferred image job. Mark that ownership exactly like explicit image mode
        // so the rendered Stop control cancels imagegen (not the already-finished
        // RAG stream) and remains scoped to this conversation.
        setImgProgress(null)
        setImageGenConv(convId)
        let generatedImageCount = 0
        if (comicPageTotal) {
          comicTitle = comicBookTitle(imageRequests[0]?.prompt ?? '') ?? comicTitle
          // A tool row without tool calls is not grouped with the reader and still shows its answer.
          comicAnswer = pendingToolCalls.length ? visibleToolAnswer : ''
          await updateComicReader()
        }
        const setComicImageToolStatus = (
          requestIndex: number,
          status: 'completed' | 'failed'
        ): void => {
          if (!comicPageTotal) return
          setConvMessages(convId, (previous) =>
            previous.map((message) => {
              if (message.id !== toolStreamId || !message.toolCalls) return message
              let imageIndex = -1
              return {
                ...message,
                toolCalls: message.toolCalls.map((toolCall) => {
                  if (toolCall.name !== 'generate_image') return toolCall
                  imageIndex += 1
                  return imageIndex === requestIndex ? { ...toolCall, status } : toolCall
                })
              }
            })
          )
        }
        try {
          for (const [imageRequestIndex, imageRequest] of imageRequests.entries()) {
            if (cancelledRef.current.has(convId)) break
            setImgProgress(null)
            const comicPage = comicPageTotal ? comicBookPageFromPrompt(imageRequest.prompt) : null
            const generationParams = imageGenerationParams(imageRequest)
            const generationPrompt = generationParams.prompt
            const earlyImage = earlyComicImages.get(imageRequest.prompt)
            earlyComicImages.delete(imageRequest.prompt)
            try {
              const img = await (earlyImage ?? window.api.generateImage(generationParams))
              const imageMetadata: ImageGenerationMetadata | undefined =
                typeof img.width === 'number' &&
                typeof img.height === 'number' &&
                typeof img.steps === 'number' &&
                typeof img.cfgScale === 'number'
                  ? {
                      width: img.width,
                      height: img.height,
                      steps: img.steps,
                      cfgScale: img.cfgScale,
                      seed: img.seed,
                      model: img.model
                    }
                  : undefined
              const imageMetrics: GenerationMetrics | undefined =
                typeof img.durationMs === 'number'
                  ? {
                      computeBackend: img.computeBackend,
                      modelName: img.model,
                      totalSeconds: img.durationMs / 1000
                    }
                  : undefined
              if (!comicPageTotal) {
                const ownsToolTurn = generatedImageCount === 0
                const imageContent =
                  ownsToolTurn && visibleToolAnswer.trim()
                    ? visibleToolAnswer
                    : `Generated for: ${imageRequest.prompt}`
                const completedImage = completedImageMessage(
                  imageContent,
                  imageRequest.prompt,
                  img.prompt
                )
                let imageMessageId: string = crypto.randomUUID()
                try {
                  const imageContext = withGeneratedImageReference(
                    {
                      ...(ownsToolTurn ? toolCtxWithReasoning : {}),
                      ...(imageMetadata ? { imageMetadata } : {}),
                      ...(img.durationMs === undefined ? {} : { durationMs: img.durationMs }),
                      ...(imageMetrics ? { metrics: imageMetrics } : {})
                    },
                    { id: img.syncId, path: img.path }
                  )
                  const replacementId = ownsToolTurn ? opts?.replacementMessageId : undefined
                  const stored = replacementId
                    ? await window.api.updateRagMessage(
                        convId,
                        replacementId,
                        completedImage.storedContent,
                        imageContext
                      )
                    : await window.api.addRagMessage(
                        convId,
                        'assistant',
                        completedImage.storedContent,
                        imageContext
                      )
                  if (!stored) throw new Error('Saved response was not found')
                  imageMessageId = stored === true ? replacementId! : stored.uuid
                  await announceImageMessagePersisted(convId, imageMessageId)
                } catch {
                  /* Keep the generated file visible even if this database write fails. */
                }
                setConvMessages(convId, (prev) => [
                  ...prev.filter((message) => !ownsToolTurn || message.id !== toolStreamId),
                  {
                    id: imageMessageId,
                    role: 'assistant',
                    createdAt: Date.now(),
                    ...completedImage,
                    image: img.dataUrl,
                    imagePath: img.path,
                    imageMetadata,
                    ...(ownsToolTurn
                      ? {
                          context,
                          reasoning: toolReasoning,
                          timeline: toolTimeline,
                          toolCalls,
                          toolsOffered: tr?.toolsOffered
                        }
                      : {}),
                    ...(img.durationMs === undefined ? {} : { generationTimeMs: img.durationMs }),
                    ...(imageMetrics ? { metrics: imageMetrics } : {})
                  }
                ])
                if (voiceMode) setAutoPlayId(imageMessageId)
              }
              if (comicPageTotal) {
                comicPages.push({
                  src: captureUrlForPath(img.path),
                  story: comicPage?.story ?? imageRequest.prompt,
                  prompt: generationPrompt
                })
                await updateComicReader()
              }
              setComicImageToolStatus(imageRequestIndex, 'completed')
              generatedImageCount += 1
            } catch (error) {
              // One failed image does not erase or block another completed tool request. Stop is
              // the exception: it cancels the active runtime and ends the remaining local work.
              if (cancelledRef.current.has(convId)) break
              const memoryGuard = parseImageMemoryGuardError(error)
              const message =
                memoryGuard?.message ||
                (error instanceof Error ? error.message : 'Image generation failed.')
              if (!/cancel/i.test(message)) {
                setComicImageToolStatus(imageRequestIndex, 'failed')
                const failure: ChatMessage = {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: comicPageTotal ? `Page ${imageRequestIndex + 1}: ${message}` : message,
                  imageMemoryRetry: memoryGuard
                    ? {
                        request: { prompt: imageRequest.prompt },
                        prompt: imageRequest.prompt,
                        conversationId: convId,
                        projectId
                      }
                    : undefined
                }
                if (comicPageTotal) {
                  comicFailures.push(failure)
                  await updateComicReader()
                } else {
                  setConvMessages(convId, (previous) => [...previous, failure])
                }
              }
            }
          }
          if (comicPageTotal && comicPages.length > 0) {
            const finalHtml = buildComicBookReader(comicPages, comicPageTotal, comicTitle)
            const finalContent = [
              visibleToolAnswer,
              `Comic book reader: ${comicPages.length} of ${comicPageTotal} pages ready.\n\n\`\`\`html\n${finalHtml}\n\`\`\``,
              ...comicFailures.map((failure) => failure.content)
            ]
              .filter((text) => text.trim())
              .join('\n\n')
            try {
              const stored = comicReaderPersistence.saved
                ? await window.api.updateRagMessage(
                    convId,
                    comicReaderMessageId,
                    finalContent,
                    toolCtxWithReasoning
                  )
                : await window.api.addRagMessage(
                    convId,
                    'assistant',
                    finalContent,
                    toolCtxWithReasoning
                  )
              if (!stored) throw new Error('Comic reader message was not found')
              const savedReaderId = stored === true ? comicReaderMessageId : stored.uuid
              setConvMessages(convId, (previous) => [
                ...previous.filter(
                  (message) =>
                    message.id !== toolStreamId &&
                    message.id !== comicReaderMessageId &&
                    message.id !== savedReaderId
                ),
                {
                  id: savedReaderId,
                  role: 'assistant',
                  content: finalContent,
                  context,
                  reasoning: toolReasoning,
                  timeline: toolTimeline,
                  toolCalls,
                  toolsOffered: tr?.toolsOffered,
                  metrics: tr?.metrics,
                  streaming: false
                }
              ])
            } catch {
              /* The live reader remains available if persistence fails. */
            }
          } else if (comicPageTotal) {
            // updateComicReader can set this through its async closure.
            const savedComicArtifactId = comicArtifactId as string | null
            if (savedComicArtifactId) {
              await window.api.deleteArtifact(savedComicArtifactId).catch(() => false)
              setArtifacts((current) =>
                current.filter((artifact) => artifact.id !== savedComicArtifactId)
              )
            }
            // With no reader left to hold them, failed pages are reported as their own rows again.
            setConvMessages(convId, (previous) => [
              ...previous.filter((message) => message.id !== comicReaderMessageId),
              ...comicFailures
            ])
            setCanvasArtifact(null)
          }
        } finally {
          setImgProgress(null)
          setImageGenConv((owner) => (owner === convId ? null : owner))
        }
        if (generatedImageCount === 0) {
          let restoredMessageId = toolStreamId
          try {
            const retainedId =
              opts?.replacementMessageId ??
              (comicReaderPersistence.saved ? comicReaderMessageId : undefined)
            const stored = retainedId
              ? await window.api.updateRagMessage(convId, retainedId, answer, toolCtxWithReasoning)
              : await window.api.addRagMessage(convId, 'assistant', answer, toolCtxWithReasoning)
            if (!stored) throw new Error('Comic reader message was not found')
            restoredMessageId = stored === true ? retainedId! : stored.uuid
          } catch {
            /* The completed text answer remains visible if persistence fails. */
          }
          setConvMessages(convId, (previous) => [
            ...previous.filter(
              (message) =>
                message.id !== toolStreamId &&
                message.id !== restoredMessageId &&
                message.id !== comicReaderMessageId
            ),
            {
              id: restoredMessageId,
              role: 'assistant',
              content: answer,
              context,
              reasoning: toolReasoning,
              timeline: toolTimeline,
              toolCalls,
              toolsOffered: tr?.toolsOffered,
              metrics: tr?.metrics,
              streaming: false
            }
          ])
          if (voiceMode) setAutoPlayId(restoredMessageId)
        }
        return
      }
      try {
        const stored = opts?.replacementMessageId
          ? await window.api.updateRagMessage(
              convId,
              opts.replacementMessageId,
              answer,
              toolCtxWithReasoning
            )
          : await window.api.addRagMessage(convId, 'assistant', answer, toolCtxWithReasoning)
        if (!stored) throw new Error('Saved response was not found')
        const storedId = stored === true ? opts!.replacementMessageId! : stored.uuid
        setConvMessages(convId, (previous) =>
          previous.map((message) =>
            message.id === toolStreamId
              ? { ...message, id: storedId, replacementMessageId: undefined }
              : message
          )
        )
        if (voiceMode) setAutoPlayId(storedId)
        if (
          tr?.answer &&
          !tr.cutoff &&
          !cancelledRef.current.has(convId) &&
          imageRequests.length === 0 &&
          toolCalls.every((call) => call.status === 'completed')
        ) {
          void Promise.resolve()
            .then(() => window.api.suggestNextChatMessage(trimmed, answer))
            .then((text) => {
              const latest = messagesByConvRef.current[convId]?.at(-1)
              if (!text || latest?.id !== storedId || latest.content !== answer) return
              setNextMessages((previous) => ({
                ...previous,
                [convId]: { messageId: storedId, answer, text }
              }))
            })
            .catch(() => {})
        }
      } catch {
        /* ignore */
        if (voiceMode) setAutoPlayId(toolStreamId)
      }
      return
    } catch (e) {
      // User stopped and the call REJECTED rather than returning, so there is no result to read.
      // This is the path that used to save nothing at all: the turn stayed on screen and was gone
      // the next time the conversation loaded. The refs still hold what streamed, so the same
      // owner finalises it.
      if (cancelledRef.current.has(convId)) {
        if (activeStreamId) await finalizeStoppedTurn(convId, activeStreamId)
        return
      }
      console.error('Chat failed', e)
      const errorContent = generationErrorContent(e)
      // Update the streaming placeholder to show the error — never append a second bubble.
      const sid = activeStreamId
      const failedReasoning = sid ? reasoningByStream.current[sid] : undefined
      const failedTimeline = sid ? timelineByStream.current[sid] : undefined
      const failedToolCalls = sid ? toolCallsByStream.current[sid] : undefined
      const failed = failedAnswerVersion(opts?.priorAnswer, errorContent, opts?.priorVariants)
      setConvMessages(convId, (previous) => {
        if (sid && previous.some((message) => message.id === sid))
          return previous.map((message) =>
            message.id === sid
              ? {
                  ...message,
                  ...failed,
                  id: sid,
                  reasoning: failed.reasoning ?? failedReasoning,
                  timeline: failed.timeline ?? failedTimeline,
                  toolCalls: failed.toolCalls ?? failedToolCalls,
                  activity: undefined,
                  streaming: false
                }
              : message
          )
        return [...previous, { ...failed, id: `a-${Date.now()}` }]
      })
      try {
        const context = failed.context
        const stored = opts?.replacementMessageId
          ? await window.api.updateRagMessage(
              convId,
              opts.replacementMessageId,
              failed.content,
              context
            )
          : await window.api.addRagMessage(convId, 'assistant', failed.content, context)
        // A retry that failed is kept as a version, and the answer it was retrying stays shown.
        if (stored && stored !== true && opts?.versionOf)
          await window.api.selectRagMessageVersion(convId, stored.uuid, -1)
        if (stored && sid)
          setConvMessages(convId, (previous) =>
            previous.map((message) =>
              message.id === sid
                ? {
                    ...message,
                    id: stored === true ? opts!.replacementMessageId! : stored.uuid,
                    replacementMessageId: undefined
                  }
                : message
            )
          )
      } catch {
        /* ignore */
      }
    } finally {
      await settleRun()
      if (activeStreamId) {
        streamConvRef.current.delete(activeStreamId)
        delete timelineByStream.current[activeStreamId]
        delete toolCallsByStream.current[activeStreamId]
        clearStreamViewMessage(activeStreamId)
      }
    }
  }

  const drainQueue = (convId: string): void =>
    queueStore.drain(convId, {
      queues: queuedRef,
      blocked: () => cancelledRef.current.has(convId) || generatingRef.current.has(convId),
      publish: setQueuedByConv,
      send: (item) =>
        void sendMessageRef.current(item.text || ' ', {
          atts: item.atts,
          conversationId: convId,
          assistantEnabled: item.assistantEnabled,
          projectIdOverride: item.projectId,
          modeOverride: item.mode
        })
    })

  const removeQueuedMessage = (conversationId: string, item: QueuedTurn): boolean => {
    const queue = queuedRef.current[conversationId] ?? []
    if (!queue.includes(item)) return false
    queuedRef.current = {
      ...queuedRef.current,
      [conversationId]: queue.filter((queued) => queued !== item)
    }
    setQueuedByConv(queuedRef.current)
    return true
  }

  const sendQueuedMessage = (conversationId: string, item: QueuedTurn): void => {
    if (!removeQueuedMessage(conversationId, item)) return
    void sendMessageRef.current(item.text || ' ', {
      sendNow: true,
      atts: item.atts,
      conversationId,
      assistantEnabled: item.assistantEnabled,
      projectIdOverride: item.projectId,
      modeOverride: item.mode
    })
  }

  const findQueuedMessage = (conversationId: string, id: string): QueuedTurn | undefined =>
    (queuedRef.current[conversationId] ?? []).find((queued) => queuedTurnId(queued) === id)

  /** Rewrite one waiting turn in place; a turn that already left the queue is left alone. */
  const saveQueuedEdit = (conversationId: string): void => {
    const edit = queueEdit
    setQueueEdit(null)
    if (!edit) return
    const queue = queuedRef.current[conversationId] ?? []
    const item = findQueuedMessage(conversationId, edit.id)
    if (!item) return
    const text = edit.text.trim()
    if (!text && item.atts.length === 0) return
    setQueuedByConv({
      ...queuedRef.current,
      [conversationId]: queue.map((queued) =>
        queued === item ? { ...queued, id: queuedTurnId(queued), text } : queued
      )
    })
  }

  const moveQueuedMessage = (conversationId: string, id: string, direction: -1 | 1): void => {
    const queue = [...(queuedRef.current[conversationId] ?? [])]
    const index = queue.findIndex((queued) => queuedTurnId(queued) === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= queue.length) return
    ;[queue[index], queue[target]] = [queue[target]!, queue[index]!]
    setQueuedByConv({ ...queuedRef.current, [conversationId]: queue })
  }

  async function settleObservedRun(
    conversationId: string,
    snapshot?: ChatMessage[]
  ): Promise<void> {
    // Renderer senders provide their final saved snapshot synchronously. Main-owned
    // runs are read only after the stream registry confirms their saved completion.
    if (snapshot) setConvMessages(conversationId, snapshot)
    else {
      const observedIds = [...streamConvRef.current]
        .filter(([, cid]) => cid === conversationId)
        .map(([id]) => id)
      if (!observedIds.length) return
      const active = (await window.api.getActiveRagStreams?.()) ?? []
      if (active.some((stream) => stream.conversationId === conversationId)) return
      const durable = await loadLatestConversationMessages(conversationId)
      if (
        !durable ||
        rendererOwnsRun(conversationId) ||
        !observedIds.some((id) => streamConvRef.current.get(id) === conversationId)
      )
        return
      setConvMessages(conversationId, durable)
    }
    for (const [id, cid] of streamConvRef.current) {
      if (cid === conversationId) {
        streamConvRef.current.delete(id)
        clearStreamViewMessage(id)
      }
    }
    cancelledRef.current.delete(conversationId)
    markGenerating(conversationId, false)
    setLoading(false)
    drainQueue(conversationId)
  }

  useEffect(() => {
    const onSettled = (event: Event): void => {
      const detail = (event as CustomEvent<RunEvent>).detail
      if (detail.owner === streamConvRef.current) return
      if (detail.action === 'started' && detail.messages) {
        const streaming = detail.messages.find((message) => message.streaming)
        if (!streaming) return
        streamConvRef.current.set(streaming.id, detail.conversationId)
        seedStreamViewMessage(streaming)
        setConvMessages(detail.conversationId, detail.messages)
        markGenerating(detail.conversationId, true)
        return
      }
      if (detail.action !== 'settled' || !generatingRef.current.has(detail.conversationId)) return
      detail.claimed = true
      const cid = detail.conversationId
      void settleObservedRun(cid, detail.messages).catch((error) =>
        console.error('Failed to refresh the completed conversation:', error)
      )
    }
    window.addEventListener('offgrid:chat-run', onSettled)
    // Native streams cover only model execution. Discover renderer reservations too:
    // preparation and final database writes must keep a remounted composer busy.
    const discovery: RunEvent = { action: 'query', conversationId: '*', conversations: [] }
    window.dispatchEvent(new CustomEvent('offgrid:chat-run', { detail: discovery }))
    for (const cid of new Set(discovery.conversations)) {
      attachRendererRun(cid)
      markGenerating(cid, true)
    }
    return () => {
      window.removeEventListener('offgrid:chat-run', onSettled)
    }
  }, [])

  const handleVoicePlaybackChange = useCallback((messageId: string, active: boolean): void => {
    setVoicePlaybackOwner((current) => nextVoicePlaybackOwner(current, messageId, active))
  }, [])

  const voiceTurns = useChatVoiceTurns({
    // A turn belongs to the chat it was recorded in (a new chat before it has an id).
    ownerId: activeConversationId ?? NEW_CHAT,
    voiceMode,
    mode: voiceMode ? voiceTurnMode : 'tap',
    silenceAfterSpeechMs: voiceSilenceAfterSpeechMs,
    speakerDrainMs: voiceSpeakerDrainMs,
    isGenerating: Boolean(activeConversationId && generatingConvs.has(activeConversationId)),
    isPlaybackActive: voicePlaybackOwner !== null,
    transcribeAudio: (audio, extension, requestId) =>
      window.api.transcribeAudio(audio, extension, requestId),
    saveRecording: (audio, extension) => window.api.saveVoiceRecording(audio, extension),
    cancelTranscription: (requestId) => window.api.cancelTranscription(requestId),
    getTranscriptionLabel: () => window.api.getTranscriptionInfo(),
    onTranscript: (text, clip, owner) => {
      if (voiceMode && clip) {
        // Sent in the chat it was recorded in, even when another chat is open by now.
        const recordedIn = owner === NEW_CHAT ? null : owner
        if (recordedIn !== (activeConversationId ?? null)) {
          // A new chat left before it had any message has nowhere to receive it.
          if (recordedIn === null) return false
          const home = conversations.find((conversation) => conversation.id === recordedIn)
          void sendMessage(text, {
            voiceClip: clip,
            conversationId: recordedIn,
            ...(home ? { projectIdOverride: home.project_id ?? null } : {})
          })
          return true
        }
        void sendMessage(text, { voiceClip: clip })
        return true
      }
      draftStore.update((previous) => `${previous}${previous ? ' ' : ''}${text}`)
      return true
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
  useEffect(() => {
    const listening =
      voiceTurns.phase === 'starting' ||
      voiceTurns.phase === 'listening' ||
      voiceTurns.phase === 'recording'
    announceAssistantListening(listening)
    return () => announceAssistantListening(false)
  }, [voiceTurns.phase])

  // God: questions and the microphone come from outside the chat (Ares, the wake word, Right
  // now), and Ares shows what the chat is doing.
  const godRequestCount = useRef(god?.request.count ?? 0)
  const sendMessageRef = useRef(sendMessage)
  sendMessageRef.current = sendMessage
  const godRequest = god?.request

  const onGodStateChange = god?.onStateChange
  const godThinking = Boolean(activeConversationId && generatingConvs.has(activeConversationId))
  const godSpeaking = voicePlaybackOwner !== null
  useEffect(() => {
    onGodStateChange?.({
      thinking: godThinking,
      speaking: godSpeaking,
      voicePhase: voiceTurns.phase
    })
  }, [onGodStateChange, godThinking, godSpeaking, voiceTurns.phase])

  // Stop the in-flight generation for a conversation: abort the model stream (main
  // keeps whatever streamed so far) or the image job, drop any queued follow-ups, and
  // return the UI to idle now. The in-flight sendMessage sees cancelledRef and bails at
  // its next await; this handles both the pre-stream ("Searching your memory…") window
  // and a live token stream.
  const finalizeStoppedTurn = (
    convId: string,
    streamId: string,
    settled?: Parameters<typeof persistObservedTurn>[3],
    status?: ChatMessage['turnStatus']
  ): Promise<void> =>
    persistObservedTurn(
      {
        streamConvRef,
        messagesByConvRef,
        reasoningByStream,
        timelineByStream,
        toolCallsByStream,
        answerByStream,
        setConvMessages,
        api: window.api
      },
      convId,
      streamId,
      settled,
      status
    )

  const stopGeneration = (
    cid: string | null,
    task: Pick<TaskSession, 'taskId' | 'journeyId' | 'kind'> | null,
    preserveQueue = false,
    requestedTarget?: RunStopTarget
  ): Promise<void> =>
    stopChatRun(
      {
        activeConversationId,
        cancelledRef,
        streamConvRef,
        messagesByConvRef,
        queuedRef,
        setQueuedByConv,
        stopLiveTask,
        setAttachWarn,
        answerByStream,
        reasoningByStream,
        timelineByStream,
        toolCallsByStream,
        dispatch: (detail) => window.dispatchEvent(new CustomEvent('offgrid:chat-run', { detail })),
        cancelRag: (id) => window.api.cancelRag(id),
        finalizeStoppedTurn,
        markGenerating,
        drainQueue,
        imageGenConv,
        cancelImageGen: () => window.api.cancelImageGen(),
        setImageGenConv,
        setImgProgress,
        setLoading
      },
      cid,
      task,
      preserveQueue,
      requestedTarget
    )

  useEffect(() => {
    if (!godRequest || godRequest.count === godRequestCount.current) return
    godRequestCount.current = godRequest.count
    if (godRequest.ask?.trim()) void sendMessageRef.current(godRequest.ask, { asUserInput: true })
    if (godRequest.listen === 'start') voiceTurns.start()
    else if (godRequest.listen === 'toggle') {
      // The God's Stop button also cancels transcription, the answer and its voice playback.
      if (godThinking || godSpeaking || voiceTurns.phase === 'transcribing') {
        voiceTurns.cancel()
        stopAllVoicePlayback()
        if (godThinking) {
          void stopGeneration(
            activeConversationId,
            guidanceTaskForJourney(getTaskSessionState().tasks, activeConversationId)
          )
        }
      } else voiceTurns.toggle()
    } else if (godRequest.listen === 'stop') voiceTurns.cancel()
  }, [godRequest, voiceTurns, godThinking, godSpeaking, stopGeneration, activeConversationId])

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
        // A long reply is spoken in passes: play each as it arrives, so the voice starts after
        // the first sentence instead of after the whole reply.
        const audio = new PassPlayback()
        audioRef.current = audio
        const failed = (): void => {
          setSpeakingId((cur) => (cur === id ? null : cur))
          setSpeakLoadingId((cur) => (cur === id ? null : cur))
          setSpeakError({
            id,
            message:
              'Speech could not be played. Check your audio output, then try speaking the reply again.'
          })
        }
        audio.onended = () => {
          setSpeakingId((cur) => (cur === id ? null : cur))
          if (audioRef.current === audio) audioRef.current = null
        }
        audio.onerror = () => {
          console.error('[tts] audio element error')
          failed()
        }
        const made = window.api
          .speak(messageToSpeakable(text), undefined, (pass) =>
            audio.addPass(pass.index, pass.dataUrl)
          )
          .then(({ dataUrl }) => {
            if (!dataUrl) throw new Error('empty dataUrl')
            audio.setFull(dataUrl)
          })
        const playing = audio.play()
        // The first audio, or the synthesis failing before any audio exists.
        await Promise.race([playing, made.then(() => playing)])
        if (!voiceMountedRef.current || speechRequestRef.current !== request) {
          audio.pause()
          made.catch(() => undefined)
          return
        }
        // The rest of the reply can still fail after its first sentence started playing.
        made.catch((e: unknown) => {
          console.error('[tts] failed', e)
          if (audioRef.current !== audio) return
          audio.pause()
          audioRef.current = null
          failed()
        })
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
            e instanceof Error && e.message.trim()
              ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
              : 'Speech could not be generated. Try again.'
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
      setGallery((await window.api.listGeneratedImages(scope)) || [])
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
    console.log('MemoryChat effect: refresh gallery')
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
  useEffect(() => {
    console.log('MemoryChat effect: active models panel subscription')
    const openActiveModels = (): void => {
      closePanels()
      setModelPickerOpen(true)
    }
    window.addEventListener(OPEN_ACTIVE_MODELS_PANEL_EVENT, openActiveModels)
    return () => window.removeEventListener(OPEN_ACTIVE_MODELS_PANEL_EVENT, openActiveModels)
  }, [closePanels])
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
      await window.api.exportGeneratedImage(path, name || 'off-grid-image.png')
    } catch (e) {
      console.error(e)
    }
  }, [])

  const deleteImage = useCallback(async (path?: string) => {
    if (!path) return
    try {
      await window.api.deleteGeneratedImage(path)
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

  useEffect(() => {
    console.log('MemoryChat effect: load skills')
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
    console.log('MemoryChat effect: RAG stream subscription')
    let disposed = false
    const off = window.api.onRagStream((incoming) => {
      // An early image request belongs to the comic turn waiting for it, not to the stream view.
      if (incoming.type === 'image_request') {
        if (incoming.request)
          earlyImageRequestByStream.current.get(incoming.streamId)?.(incoming.request)
        return
      }
      const data = { ...incoming, type: incoming.type }
      const cid = streamConvRef.current.get(data.streamId)
      if (!cid) return
      if (unownedTerminal(data.type, rendererOwnsRun(cid))) {
        void settleUnownedStream(
          () =>
            finalizeStoppedTurn(
              cid,
              data.streamId,
              undefined,
              data.type === 'done' ? 'completed' : 'cancelled'
            ),
          () => {
            clearStreamViewMessage(data.streamId)
            markGenerating(cid, false)
            setLoading(false)
          },
          () => drainQueue(cid)
        ).catch((error) => console.error('Failed to settle reattached stream:', error))
        return
      }
      if (data.type === 'done') return
      if (
        data.type === 'step' &&
        data.step &&
        typeof data.step === 'object' &&
        'kind' in data.step &&
        data.step.kind === 'model_changed'
      ) {
        const failed =
          'failed' in data.step && typeof data.step.failed === 'string'
            ? data.step.failed
            : 'The selected model'
        const next =
          'next' in data.step && typeof data.step.next === 'string'
            ? data.step.next
            : 'another model'
        const content = `Model changed: ${failed} could not answer. ${next} is answering.`
        const noticeId = crypto.randomUUID()
        reasoningByStream.current[data.streamId] = ''
        answerByStream.current[data.streamId] = ''
        timelineByStream.current[data.streamId] = []
        toolCallsByStream.current[data.streamId] = []
        resetStreamViewMessage(data.streamId)
        setConvMessages(cid, (previous) => {
          const streamIndex = previous.findIndex((message) => message.id === data.streamId)
          const notice: ChatMessage = { id: noticeId, role: 'assistant', content, notice: true }
          if (streamIndex < 0) return [...previous, notice]
          const clean = {
            ...previous[streamIndex]!,
            content: '',
            reasoning: '',
            timeline: [],
            toolCalls: []
          }
          return [
            ...previous.slice(0, streamIndex),
            notice,
            clean,
            ...previous.slice(streamIndex + 1)
          ]
        })
        void window.api
          .addRagMessage(cid, 'assistant', content, { notice: true })
          .then((stored) =>
            setConvMessages(cid, (previous) =>
              previous.map((message) =>
                message.id === noticeId ? { ...message, id: stored.uuid } : message
              )
            )
          )
          .catch((error) => console.warn('Could not save the model-change notice', error))
        return
      }
      if (
        data.type === 'step' &&
        data.step &&
        typeof data.step === 'object' &&
        'kind' in data.step &&
        data.step.kind === 'compacted'
      ) {
        const noticeId = crypto.randomUUID()
        const summary = (data.step as { summary?: unknown }).summary
        // The summary stands in for every earlier turn on later sends, so it is kept on the notice.
        const noticeContext: RagContext =
          typeof summary === 'string' && summary
            ? { notice: true, compactionSummary: summary }
            : { notice: true }
        const notice: ChatMessage = {
          id: noticeId,
          role: 'assistant',
          content: '_Compacted_',
          notice: true,
          ...(noticeContext.compactionSummary ? { context: noticeContext } : {})
        }
        setConvMessages(cid, (previous) => {
          const streamIndex = previous.findIndex((message) => message.id === data.streamId)
          if (streamIndex < 0) return [...previous, notice]
          return [...previous.slice(0, streamIndex), notice, ...previous.slice(streamIndex)]
        })
        void window.api
          .addRagMessage(cid, 'assistant', '_Compacted_', noticeContext)
          .then((stored) =>
            setConvMessages(cid, (previous) =>
              previous.map((message) =>
                message.id === noticeId ? { ...message, id: stored.uuid } : message
              )
            )
          )
          .catch((error) => console.warn('Could not save the compaction notice', error))
        return
      }
      if (data.type === 'step') {
        const step = data.step as { kind?: unknown } | undefined
        if (step?.kind === 'running_tool') announceAssistantActivity('acting')
      } else if (data.type === 'tool_result') {
        announceAssistantActivity('working')
      }
      // Mirror reasoning into a ref as it streams, so persistence can read it
      // deterministically (not via a state-updater side effect). Rendering still
      // uses message.reasoning below; this is the durable source for the saved blob.
      if (data.type === 'reasoning') {
        reasoningByStream.current[data.streamId] =
          (reasoningByStream.current[data.streamId] || '') + (data.text || '')
      }
      if (data.type === 'reasoning' || data.type === 'step') {
        const timeline = appendTimelineEvent(timelineByStream.current[data.streamId], data)
        if (timeline) timelineByStream.current[data.streamId] = timeline
      }
      if (data.type === 'step' || data.type === 'tool_result') {
        const next = applyStreamEvent(
          { toolCalls: toolCallsByStream.current[data.streamId] },
          data
        ).toolCalls
        if (next) toolCallsByStream.current[data.streamId] = next
      }
      // The answer is mirrored for the same reason: when the user stops, the call can REJECT
      // rather than return, and then there is no result to read the partial answer out of. This
      // ref is the one place that always has what arrived.
      if (data.type === 'content') {
        answerByStream.current[data.streamId] =
          (answerByStream.current[data.streamId] || '') + (data.text || '')
      }
      applyStreamViewEvent(data.streamId, data)
    })
    void (window.api.getActiveRagStreams?.() ?? Promise.resolve([]))
      .then(async (streams) => {
        await queueStore.ready
        if (disposed) return
        for (const stream of streams) {
          attachRendererRun(stream.conversationId)
          streamConvRef.current.set(stream.streamId, stream.conversationId)
          reasoningByStream.current[stream.streamId] = stream.reasoning
          // The sender's view still names the answer a regenerate replaces and its versions.
          const restored = restoredStreamMessage(stream, streamViewMessage(stream.streamId))
          timelineByStream.current[stream.streamId] = restored.timeline ?? []
          toolCallsByStream.current[stream.streamId] = restored.toolCalls ?? []
          answerByStream.current[stream.streamId] = stream.content
          markGenerating(stream.conversationId, true)
          seedStreamViewMessage(restored)
          setConvMessages(stream.conversationId, (previous) =>
            withRestoredStream(previous, restored)
          )
        }
        for (const cid of Object.keys(queuedRef.current)) {
          if (!generatingRef.current.has(cid)) drainQueue(cid)
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

  const replacementDependencies = (): ReplacementDependencies => ({
    conversationId: activeConversationId,
    messages,
    generating: generatingRef.current,
    cancelled: cancelledRef.current,
    newId: () => crypto.randomUUID(),
    listen: listenToRun,
    markGenerating,
    resetPreview: () => setRemoteWorkPreview(null),
    stopTask: stopLiveWebUseForConversation,
    addVersion: (...args) => window.api.addRagMessageVersion(...args),
    prepareAnswerVersion: (...args) => window.api.prepareAnswerVersion(...args),
    setMessages: setConvMessages,
    refresh: refreshConversationMessages,
    announceSettled: announceRunSettled,
    drain: drainQueue,
    send: sendMessage
  })
  const regenerate = (id: string): void => {
    void replaceChatTurn(replacementDependencies(), id)
  }
  const saveEdit = (id: string, text: string): void => {
    setEditingId(null)
    void replaceChatTurn(replacementDependencies(), id, text)
  }

  const updateVoiceTranscript = useCallback(
    async (message: ChatMessage, text: string): Promise<void> => {
      const cid = activeConversationId
      if (!cid) throw new Error('No active conversation')
      let updatedAudio = false
      const nextAttachments = message.attachments?.map((attachment) => {
        if (updatedAudio || attachmentKindFor({ fileName: attachment.name }) !== 'audio') {
          return attachment
        }
        updatedAudio = true
        return { ...attachment, text }
      })
      const nextContext = nextAttachments
        ? { ...(message.context ?? {}), attachments: nextAttachments }
        : undefined
      const updated = await window.api.updateRagMessage(cid, message.id, text, nextContext)
      if (!updated) throw new Error('Saved message was not found')
      setConvMessages(cid, (previous) =>
        previous.map((entry) =>
          entry.id === message.id
            ? {
                ...entry,
                content: text,
                context: nextContext ?? entry.context,
                attachments: nextAttachments
              }
            : entry
        )
      )
    },
    [activeConversationId, setConvMessages]
  )

  // Documents keep reading and indexing in the background after they are attached; their pills
  // show how far it has got.
  useEffect(
    () =>
      window.api.documents.onProgress((progress) =>
        setAttachments((previous) =>
          previous.some((a) => a.documentId === progress.id)
            ? previous.map((a) =>
                a.documentId === progress.id
                  ? {
                      ...a,
                      ...(progress.pageCount ? { pages: progress.pageCount } : {}),
                      progress: {
                        phase: progress.phase,
                        done: progress.done,
                        total: progress.total,
                        ...(progress.error ? { error: progress.error } : {})
                      }
                    }
                  : a
              )
            : previous
        )
      ),
    []
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
          // A picked or dropped file is read where it is: a large document never crosses IPC.
          const filePath = window.api.filePath(file)
          const res = filePath
            ? await window.api.processFilePath(filePath, file.name)
            : await window.api.processFile(await file.arrayBuffer(), file.name)
          // An image is ready once its file is saved - it carries no text at all, because the
          // image itself goes to the vision model and captioning it here was removed (it ran the
          // model synchronously and left the chip stuck on "Reading…"). A document is ready as
          // soon as it is kept and indexing has started (a scanned PDF has no text until OCR);
          // anything else once it has extracted text.
          const ok = res.kind === 'image' ? !!res.path : !!(res.documentId || res.text)
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? {
                    ...a,
                    kind: res.kind as Attachment['kind'],
                    text: res.text || '',
                    path: res.path,
                    ...(res.documentId ? { documentId: res.documentId } : {}),
                    ...(res.pages ? { pages: res.pages } : {}),
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

  const installedSkillNames = useMemo(() => skills.map((skill) => skill.name), [skills])
  const messageNavigation = useMemo<ContextNavigation>(
    () => ({
      onNavigateToMemory,
      onNavigateToChat,
      onNavigateToMeeting,
      onNavigateToEntity,
      onOpenProject,
      onSeekReplay,
      installedSkillNames,
      onOpenSkillPreset,
      onOpenInstalledSkill: (name) => {
        closePanels()
        setSelectedSkillName(name)
        setSkillsOpen(true)
      },
      // A document citation opens the document at the page it cites.
      onOpenDocument: (documentId, page) => {
        const conversation = messagesByConvRef.current[activeConversationId ?? NEW_CHAT] ?? EMPTY_MSGS
        const attachment = conversation
          .flatMap((message) => message.attachments ?? [])
          .find((candidate) => candidate.documentId === documentId)
        if (!attachment) return
        closePanels()
        const isPdf = attachment.kind === 'pdf' && !!attachment.path
        setViewer({
          title: attachment.name,
          text: isPdf ? '' : attachment.text || '',
          path: attachment.path,
          kind: isPdf ? 'pdf' : attachment.kind,
          renderer: isPdf ? 'document' : 'text',
          ...(isPdf ? { page } : {})
        })
      }
    }),
    [
      activeConversationId,
      closePanels,
      installedSkillNames,
      onNavigateToChat,
      onNavigateToEntity,
      onNavigateToMeeting,
      onNavigateToMemory,
      onOpenProject,
      onOpenSkillPreset,
      onSeekReplay
    ]
  )
  const currentMessageActions: MessageRowActions = {
    copy: (text, key) => void copyText(text, key),
    regenerate,
    openImage: setLightbox,
    openAttachment: (attachment) => {
      const view = describeAttachment({
        fileName: attachment.name,
        mimeType: (attachment as { mimeType?: string }).mimeType,
        path: attachment.path,
        text: attachment.text,
        // A recorded voice note is saved as .webm; its stored kind keeps it audio.
        recordedKind: attachment.kind
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
    },
    cancelEdit: () => setEditingId(null),
    saveEdit,
    updateVoiceTranscript,
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
      const selected = messages.find((message) => message.id === messageId)
      const cid = activeConversationId
      if (!selected || !cid || selected.streaming) return
      // A saved version shows its own thread: the turns after it come back with it.
      if (selected.threadVersions) {
        void window.api
          .selectRagMessageVersion(cid, messageId, direction)
          .then((changed) => (changed ? refreshConversationMessages(cid) : undefined))
          .catch((error) => console.error('Failed to show the selected version:', error))
        return
      }
      if (!selected.variants?.length) return
      const restored = selectAnswerVersion(selected, direction)
      setMessages((previous) =>
        previous.map((message) => (message.id === messageId ? restored : message))
      )
      void window.api
        .updateRagMessage(cid, messageId, restored.content, restored.context)
        .then((stored) => {
          if (!stored) throw new Error('Saved response was not found')
        })
        .catch((error) => {
          console.error('Failed to save the selected response:', error)
        })
    }
  }
  const messageActionsRef = useRef(currentMessageActions)
  messageActionsRef.current = currentMessageActions
  const messageActions = useMemo<MessageRowActions>(
    () => ({
      copy: (...args) => messageActionsRef.current.copy(...args),
      regenerate: (...args) => messageActionsRef.current.regenerate(...args),
      openImage: (...args) => messageActionsRef.current.openImage(...args),
      openAttachment: (...args) => messageActionsRef.current.openAttachment(...args),
      startEdit: (...args) => messageActionsRef.current.startEdit(...args),
      cancelEdit: (...args) => messageActionsRef.current.cancelEdit(...args),
      saveEdit: (...args) => messageActionsRef.current.saveEdit(...args),
      updateVoiceTranscript: (...args) => messageActionsRef.current.updateVoiceTranscript(...args),
      retryImageMemory: (...args) => messageActionsRef.current.retryImageMemory(...args),
      openArtifact: (...args) => messageActionsRef.current.openArtifact(...args),
      selectAskOption: (...args) => messageActionsRef.current.selectAskOption(...args),
      submitAsk: (...args) => messageActionsRef.current.submitAsk(...args),
      speak: (...args) => messageActionsRef.current.speak(...args),
      voicePlaybackChange: (...args) => messageActionsRef.current.voicePlaybackChange(...args),
      selectVariant: (...args) => messageActionsRef.current.selectVariant(...args)
    }),
    []
  )
  const latestVoiceAssistantId = voiceMode
    ? ([...messages].reverse().find((message) => message.role === 'assistant')?.id ?? null)
    : null
  const showGenerationProgress = Boolean(
    activeConversationId &&
    !liveJourneyTask &&
    generatingConvs.has(activeConversationId) &&
    (generatingImage || !messages.some((message) => message.streaming))
  )
  const activeImageTimelineMessageId =
    showGenerationProgress && generatingImage
      ? [...messages]
          .reverse()
          .find(
            (message) =>
              message.role === 'assistant' &&
              !message.image &&
              message.toolCalls?.some((tool) => tool.name === 'generate_image')
          )?.id
      : undefined
  const activeEnhancedPrompt =
    imageJobStage === 'enhancing' || streamingEnhancedPrompt ? (
      <ChatThinkingBlock
        content={streamingEnhancedPrompt || 'Starting…'}
        live={imageJobStage === 'enhancing'}
        label={imageJobStage === 'enhancing' ? 'Enhancing prompt…' : 'Enhanced prompt'}
      />
    ) : undefined
  const activeImageProgress = showGenerationProgress ? (
    <div
      className={
        imgProgress?.preview
          ? 'w-full rounded-md border border-neutral-800 bg-neutral-900/40 p-3'
          : 'w-fit max-w-full py-1'
      }
    >
      {imgProgress?.preview ? (
        <img
          src={imgProgress.preview}
          alt="forming"
          className={`mb-2 aspect-square w-full rounded-md border border-neutral-800 object-cover ${qwenLatentPreview ? 'grayscale' : ''}`}
        />
      ) : null}
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500"
      >
        <TextShimmer as="span">
          {imgProgress || imageJobStage
            ? imageProgressLabel(imageJobStage, imgProgress)
            : 'Preparing image…'}
        </TextShimmer>
        {imgProgress && imgProgress.step < imgProgress.total ? (
          <span className="text-neutral-600">
            · ~
            {Math.max(
              0,
              Math.round((imgProgress.total - imgProgress.step) * imgProgress.secPerStep)
            )}
            s left
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className="h-full bg-green-500 transition-all duration-300"
          style={{
            width: imgProgress ? `${(imgProgress.step / imgProgress.total) * 100}%` : '5%'
          }}
        />
      </div>
    </div>
  ) : undefined

  const conversationListRows = useMemo(() => {
    const query = convSearch.trim().toLowerCase()
    const filtered = query
      ? conversations.filter(
          (conversation) =>
            (conversation.title || '').toLowerCase().includes(query) ||
            contentMatchIds.has(conversation.id)
        )
      : conversations
    if (!filtered.length) return []

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
    const ordered = [...filtered].sort(
      (a, b) => parseSqliteUtc(b.updated_at).getTime() - parseSqliteUtc(a.updated_at).getTime()
    )
    for (const conversation of ordered) {
      const updatedAt = parseSqliteUtc(conversation.updated_at).getTime()
      if (updatedAt >= startToday) groups[0]!.items.push(conversation)
      else if (updatedAt >= startYesterday) groups[1]!.items.push(conversation)
      else if (updatedAt >= startThisWeek) groups[2]!.items.push(conversation)
      else groups[3]!.items.push(conversation)
    }
    return groups.flatMap<ConversationListRow>((group) =>
      group.items.length
        ? [
            { kind: 'group' as const, key: `group:${group.label}`, label: group.label },
            ...group.items.map((conversation) => ({
              kind: 'conversation' as const,
              key: conversation.id,
              conversation
            }))
          ]
        : []
    )
  }, [contentMatchIds, convSearch, conversations])

  return (
    <ActiveConversationProvider conversationId={activeConversationId}>
      {/* prettier-ignore */}
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
            onClick={toggleConversationList}
            className="rounded-md border border-neutral-800 p-1.5 text-neutral-500 transition-colors hover:border-green-500 hover:text-green-500"
            title={conversationsToggleLabel}
            aria-label={conversationsToggleLabel}
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
            <h2 className="text-sm font-medium tracking-wide text-neutral-200">
              {god ? god.name : 'Off Grid AI'}
            </h2>
            {god ? (
              <p className="truncate text-xs text-neutral-500">
                Knows your day, memory and accounts. Asks before it acts.
              </p>
            ) : activeProjectId && activeProjectName ? (
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

          {/* Active models and Settings: the same drawers in Chat and God (God runs tasks too). */}
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
          {/* God has no image gallery. */}
          {!god && (
            <>
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
            </>
          )}
          <TaskPanelTrigger conversationId={activeConversationId} />
        </header>

        {/* Body */}
        <PanelGroup
          direction="horizontal"
          className="min-h-0 flex-1"
          data-testid="main-task-workspace"
        >
          <Panel
            ref={chatBodyRef}
            id="chat-body-workspace"
            order={1}
            defaultSize={52}
            minSize={28}
            collapsible
            collapsedSize={0}
            style={{ transition: taskWorkspaceTransition }}
            onCollapse={() => setChatBodyVisibility(true)}
            onExpand={() => setChatBodyVisibility(false)}
            className="min-w-0"
          >
            <PanelGroup
              direction="horizontal"
              autoSaveId={god ? 'offgrid-god-chat-layout' : 'offgrid-memory-chat-layout'}
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
                onCollapse={() => setConversationsVisible(false)}
                onExpand={() => {
                  setConversationsVisible(true)
                  void loadConversations()
                }}
                className="min-w-0 overflow-hidden transition-[flex-grow] duration-200 ease-out motion-reduce:transition-none"
              >
                <ConversationSidebar
                  conversationCount={conversations.length}
                  rows={conversationListRows}
                  search={convSearch}
                  activeConversationId={activeConversationId}
                  onSearchChange={setConvSearch}
                  onStartNewConversation={startNewConversation}
                  onSwitchConversation={switchConversation}
                  onConversationRenamed={conversationRenamed}
                  onDeleteConversation={deleteConversation}
                />
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
                      <AnimatePresence initial={false}>
                        {openTabs.map((id) => {
                          const t = conversations.find((c) => c.id === id)
                          const active = activeConversationId === id
                          return (
                            <motion.div
                              key={id}
                              layout
                              initial={{ opacity: 0, y: 6 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0 }}
                              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
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
                            </motion.div>
                          )
                        })}
                      </AnimatePresence>
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
                  <div className="relative min-h-0 flex-1">
                    <div ref={scrollRef} onScroll={onScrollFollow} className="h-full overflow-y-auto">
                      {switchingConversationId !== null &&
                        switchingConversationId === activeConversationId ? (
                        <div
                          className="flex min-h-full items-center justify-center"
                          role="status"
                          aria-label="Loading conversation"
                        >
                          <LoadingDots />
                          <span className="sr-only">Loading conversation</span>
                        </div>
                      ) : approvalSetup ? (
                        <div className="flex min-h-full w-full flex-col items-center justify-center px-6 py-6 text-center">
                          <ApprovalSetup
                            key={approvalSetup.id}
                            record={approvalSetup}
                            onCancel={() => setApprovalSetup(null)}
                            onSubmit={(prompt) => {
                              void (async () => {
                                const approved = await window.api.proInvoke?.(
                                  'approvals:approve-for-chat',
                                  approvalSetup.id
                                )
                                if (!approved) return
                                setApprovalSetup(null)
                                await sendMessage(prompt, { asUserInput: true })
                              })()
                            }}
                          />
                        </div>
                      ) : messages.length === 0 ? (
                        <div className="flex min-h-full w-full flex-col items-center justify-center px-6 py-6 text-center">
                          {presetSetup ? (
                            <PresetSetup
                              key={presetSetup.id}
                              preset={presetSetup}
                              onCancel={() => setPresetSetup(null)}
                              onOpenConnectors={onOpenConnectors}
                              styleThumbs={styleThumbs}
                              onSubmit={(prompt) => {
                                setPresetSetup(null)
                                void sendMessage(prompt, { asUserInput: true, assistantEnabled: true })
                              }}
                            />
                          ) : god?.welcome ? (
                            god.welcome((prompt) => void sendMessage(prompt))
                          ) : (
                            <>
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
                                <TextEffect
                                  as="h2"
                                  preset="fade-in-blur"
                                  per="char"
                                  className="text-3xl font-semibold tracking-tight text-foreground"
                                >
                                  {god
                                    ? `Ask ${god.name}`
                                    : mode === 'image'
                                      ? 'Create an image'
                                      : 'Start a conversation'}
                                </TextEffect>
                                <p className="mt-3 max-w-md text-sm text-muted-foreground">
                                  {god
                                    ? 'It knows your day, memory and accounts, and asks before it acts.'
                                    : mode === 'image'
                                    ? 'Pick a style, then describe your subject — generated on-device.'
                                    : activeProjectName
                                      ? `Grounded in the “${activeProjectName}” knowledge base.`
                                      : isPro
                                        ? 'Ask across your memories, chats, and entities from every source.'
                                        : 'Ask anything, generate images, or build — all on-device.'}
                                </p>
                              </div>
                              {/* God's workflows and suggestions sit beside Ares. */}
                              {god ? null : mode !== 'image' ? (
                                <ExploreSection
                                  onRun={(preset) => {
                                    setPresetSetup(preset)
                                    setToolsOn(true)
                                  }}
                                  requestUrl={REQUEST_FORM_URL}
                                  className="mt-6 w-full text-left"
                                />
                              ) : null}
                              {god ? null : mode === 'image' ? (
                                showImageOptions ? (
                                  <StylePresetPicker
                                    activeStyle={activeStyle}
                                    styleThumbs={styleThumbs}
                                    onChange={setActiveStyle}
                                  />
                                ) : null
                              ) : (
                                <AnimatedGroup
                                  preset="blur-slide"
                                  className="mt-6 grid w-full grid-cols-1 gap-2 sm:grid-cols-2"
                                >
                                  {examples.map((ex) => (
                                    <button
                                      key={ex}
                                      onClick={() => sendMessage(ex)}
                                      className="h-full w-full rounded-md border border-border bg-background px-3 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-foreground"
                                    >
                                      {ex}
                                    </button>
                                  ))}
                                </AnimatedGroup>
                              )}
                            </>
                          )}
                        </div>
                      ) : (
                        <div className="w-full px-6 py-5">
                          {/* New turns rise in. Rows are keyed by position, not message id, so a draft id
                    swapping for its saved id (or a streamed answer settling) never replays the entrance. */}
                          <AnimatePresence initial={false}>
                            {displayMessages.map((message, messageIndex) => {
                              if (message.role === 'tool') {
                                if (displayMessages[messageIndex - 1]?.role === 'tool') return null
                                const run: ChatMessage[] = []
                                for (
                                  let index = messageIndex;
                                  displayMessages[index]?.role === 'tool';
                                  index += 1
                                ) {
                                  run.push(displayMessages[index]!)
                                }
                                return (
                                  <motion.div key={messageIndex} {...MESSAGE_ROW_ENTER}>
                                    <ToolMessageTimelineRow key={message.id} messages={run} />
                                  </motion.div>
                                )
                              }
                              const displayedMessage =
                                message.id === mergedRemoteWorkMessageId
                                  ? {
                                    ...message,
                                    streaming: true,
                                    toolCalls: mergeRemotePreviewTools(
                                      message.toolCalls,
                                      remoteWorkPreview
                                    )
                                  }
                                  : message
                              return (
                                <motion.div key={messageIndex} {...MESSAGE_ROW_ENTER}>
                                  <MessageRow
                                    key={message.id}
                                    message={displayedMessage}
                                    onStreamRender={followStreamRender}
                                    journeyId={activeConversationId}
                                    nextMessageRole={displayMessages[messageIndex + 1]?.role}
                                    timelineThinking={
                                      message.id === activeImageTimelineMessageId
                                        ? activeEnhancedPrompt
                                        : message.id === mergedRemoteWorkMessageId
                                          ? remoteWorkPreview?.reasoning?.trim()
                                            ? (
                                              <ChatThinkingBlock
                                                content={remoteWorkPreview.reasoning}
                                                live
                                                className="max-w-full"
                                              />
                                            )
                                            : undefined
                                          : undefined
                                    }
                                    workFooter={
                                      message.id === mergedRemoteWorkMessageId ? (
                                        <LoadingDots size="small" className="px-0" />
                                      ) : undefined
                                    }
                                    continuation={
                                      message.id === activeImageTimelineMessageId ? (
                                        <div
                                          className={`flex ${IMAGE_MESSAGE_COLUMN_WIDTH} flex-col items-start gap-2`}
                                        >
                                          {activeImageProgress}
                                        </div>
                                      ) : undefined
                                    }
                                    voiceMode={voiceMode}
                                    state={{
                                      autoPlayId,
                                      copiedKey,
                                      editingId,
                                      loading,
                                      speakingId,
                                      speakLoadingId,
                                      speakError,
                                      ttsEnabled,
                                      ttsSpeed,
                                      latestVoiceAssistantId,
                                      askSelections: askSel,
                                      incomingFiles: incomingFilesFor(message.id),
                                      // God shows the answer and its actions, not how it was made.
                                      showGenerationDetails: god ? false : showGenerationDetails,
                                      // The tool list is request detail, shown with the other generation details.
                                      showToolsSent: !god && showGenerationDetails,
                                      regenerationDisabled:
                                        !!activeConversationId && generatingConvs.has(activeConversationId)
                                    }}
                                    actions={messageActions}
                                    navigation={messageNavigation}
                                  />
                                </motion.div>
                              )
                            })}
                          </AnimatePresence>
                          {/* A reply generating on another one of your devices, streaming here live. Pro
                    registers the renderer; the free build has no slot and this is nothing. */}
                          {ChatMessagesFooter && activeConversationId ? (
                            <ChatMessagesFooter
                              conversationId={activeConversationId}
                              promptEnhancementActive={promptEnhancementActive}
                              promptEnhancementComplete={promptEnhancementComplete}
                              chatBusy={loading || generatingConvs.has(activeConversationId)}
                              executionRunning={messages.some(
                                (message) => message.context?.executionApproval?.status === 'running'
                              )}
                              durableWorkActive={Boolean(durableWorkMessageId)}
                              onRemoteWorkPreviewChange={setRemoteWorkPreview}
                            />
                          ) : null}
                          {showGenerationProgress && !activeImageTimelineMessageId ? (
                            <div className="mb-5 flex flex-col items-start">
                              <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-600">
                                Off Grid AI
                              </div>
                              {mode === 'image' || generatingImage ? (
                                <div
                                  className={`flex ${IMAGE_MESSAGE_COLUMN_WIDTH} flex-col items-start gap-2`}
                                >
                                  {activeEnhancedPrompt}
                                  {activeImageProgress}
                                </div>
                              ) : (
                                <ChatToolRows
                                  live
                                  thinkingHasContent={false}
                                  thinking={
                                    <span className="text-[11px]" role="status">
                                      <TextShimmer as="span">
                                        {waitingLabel({ noMemory, hasProject: !!activeProjectId })}
                                      </TextShimmer>
                                    </span>
                                  }
                                  footer={<LoadingDots />}
                                />
                              )}
                            </div>
                          ) : null}
                          <div ref={bottomRef} className="h-2" />
                        </div>
                      )}
                    </div>
                    {showScrollToBottom ? (
                      <Button
                        type="button"
                        size="icon"
                        variant="secondary"
                        className="absolute bottom-3 left-1/2 z-10 h-7 w-7 -translate-x-1/2 rounded-full border border-border shadow-sm transition-all duration-150 active:scale-95"
                        aria-label="Scroll to latest message"
                        title="Scroll to latest message"
                        onClick={() => scrollToBottom(reduceWorkspaceMotion ? 'auto' : 'smooth')}
                      >
                        <CaretDown className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>

                  {/* Composer */}
                  <div className="border-t border-neutral-900 px-6 py-3">
                    <div className="w-full">
                      {/* Image options (image mode, expandable) */}
                      {mode === 'image' && showImageOptions && (
                        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-neutral-800 px-3 py-2 text-[11px] text-neutral-500">
                          {imgModels.length > 1 && (
                            <div className="flex items-center gap-1.5">
                              Model
                              <SettingsSelect
                                id="chat-image-model"
                                label="Model"
                                value={imgModel}
                                options={imgModels.map((m) => ({
                                  value: m,
                                  label: m.replace(/\.gguf$/i, '').replace(/-Q\d.*$/i, '')
                                }))}
                                onValueChange={chooseImageModel}
                              />
                            </div>
                          )}
                          <div className="flex items-center gap-1.5">
                            Size
                            <Segmented
                              label="Size"
                              size="sm"
                              value={String(imgSize)}
                              options={IMAGE_SIZE_OPTIONS}
                              onValueChange={(value) => setSizeOverride(Number(value))}
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            Steps
                            <ElasticSlider
                              aria-label="Steps"
                              className="pt-3"
                              value={imgSteps}
                              onValueChange={(value) =>
                                setStepsOverride(Math.max(4, Math.min(50, Math.round(value) || 16)))
                              }
                              startingValue={4}
                              maxValue={50}
                              isStepped
                              stepSize={1}
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            Guidance
                            <ElasticSlider
                              aria-label="Guidance"
                              className="pt-3"
                              value={imgCfgScale}
                              onValueChange={(value) =>
                                setCfgScaleOverride(
                                  Math.max(0, Math.min(20, Math.round(value * 2) / 2 || 0))
                                )
                              }
                              startingValue={0}
                              maxValue={20}
                              isStepped
                              stepSize={0.5}
                              formatValue={(value) => value.toFixed(1)}
                            />
                          </div>
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
                            <Checkbox
                              checked={enhanceImg}
                              onCheckedChange={(checked) => setEnhanceImg(checked)}
                            />
                            Enhance
                          </label>
                          {imgInit ? (
                            <span className="flex items-center gap-2 rounded-md border border-green-500/40 px-2 py-1 text-green-500">
                              {imgInit.split('/').pop()}
                              <span
                                className="flex items-center gap-1 text-neutral-500"
                                title="img2img strength: how much to change the init image (0.1 = subtle, 1 = ignore it)"
                              >
                                Strength
                                <ElasticSlider
                                  aria-label="Strength"
                                  className="pt-3"
                                  value={imgStrength}
                                  onValueChange={(value) =>
                                    setImgStrength(
                                      Math.max(0.1, Math.min(1, Math.round(value * 20) / 20 || 0.6))
                                    )
                                  }
                                  startingValue={0.1}
                                  maxValue={1}
                                  isStepped
                                  stepSize={0.05}
                                  formatValue={(value) => value.toFixed(2)}
                                />
                              </span>
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
                                const p = await window.api.pickImageForGen()
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
                        {mode === 'image' && showImageOptions && messages.length > 0 ? (
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
                        <NewProjectNameField
                          inputRef={projectNameInput}
                          onCreate={createAndAssignProject}
                          onCancel={() => setProjCreating(false)}
                        />
                      )}

                      {/* The queue rises above the composer: rows can be edited, reordered, sent now
                  or dropped while the current reply finishes. */}
                      <AutoHeight>
                        {activeConversationId &&
                        queuedCount(queuedByConv, activeConversationId) > 0 ? (
                          <div className="mb-2">
                            <MessageQueue
                              items={(queuedByConv[activeConversationId] ?? []).map(toQueuedMessage)}
                              rowRole="group"
                              rowLabel={(_message, index) => `Queued message ${index + 1}`}
                              labels={QUEUE_LABELS}
                              edit={queueEdit}
                              copiedId={
                                copiedKey?.startsWith('queued:') ? copiedKey.slice('queued:'.length) : null
                              }
                              onCopy={(id) => {
                                const item = findQueuedMessage(activeConversationId, id)
                                if (item) void copyText(item.text, `queued:${id}`)
                              }}
                              onEdit={(id) => {
                                const item = findQueuedMessage(activeConversationId, id)
                                if (item) setQueueEdit({ id, text: item.text })
                              }}
                              onEditChange={(text) =>
                                setQueueEdit((current) => (current ? { ...current, text } : null))
                              }
                              onSaveEdit={() => saveQueuedEdit(activeConversationId)}
                              onCancelEdit={() => setQueueEdit(null)}
                              onMove={(id, direction) =>
                                moveQueuedMessage(activeConversationId, id, direction)
                              }
                              onSendNow={(id) => {
                                const item = findQueuedMessage(activeConversationId, id)
                                if (item) sendQueuedMessage(activeConversationId, item)
                              }}
                              onRetry={(id) => {
                                const item = findQueuedMessage(activeConversationId, id)
                                if (item) sendQueuedMessage(activeConversationId, item)
                              }}
                              onCancel={(id) => {
                                const item = findQueuedMessage(activeConversationId, id)
                                if (item) removeQueuedMessage(activeConversationId, item)
                              }}
                              onRemove={(id) => {
                                const item = findQueuedMessage(activeConversationId, id)
                                if (item) removeQueuedMessage(activeConversationId, item)
                              }}
                            />
                          </div>
                        ) : null}
                      </AutoHeight>

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
                        className="relative"
                      >
                        {dragOver ? (
                          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-xl bg-card/80 text-xs text-primary">
                            Drop files to attach
                          </div>
                        ) : null}
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
                        {/* The composer sends through its own handlers (Enter, ⌘Enter, the send button), so
                        a stray form submit (a button without a type, Enter in a gate field) does nothing
                        and leaves the draft as it is. */}
                        <PromptInput
                          // The page's main action: its beam runs even before it is focused.
                          data-field-focus="always"
                          onSubmit={() => {}}
                          resetOnSubmit={false}
                          groupClassName={`relative h-auto flex-col items-stretch rounded-xl bg-card text-card-foreground shadow-sm transition-colors ${dragOver ? 'border-primary' : ''}`}
                        >
                        <PromptInputHeader className="cursor-auto select-auto flex-col items-stretch gap-0 p-0 font-normal text-foreground">
                        <AutoHeight>
                        {attachWarn && (
                          <div className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
                            <WarningCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" weight="fill" />
                            <span className="flex-1">{attachWarn}</span>
                            <button
                              type="button"
                              onClick={() => setAttachWarn(null)}
                              className="shrink-0 text-amber-400/70 hover:text-amber-200"
                            >
                              ✕
                            </button>
                          </div>
                        )}
                        </AutoHeight>
                        <AutoHeight>
                          {attachments.length > 0 ? (
                            <div
                              className="px-3 pt-3"
                              aria-busy={attachments.some((a) => a.status === 'loading')}
                            >
                              <AttachmentList
                                attachments={attachments.map(toProcessingAttachment)}
                                // One compact row of pills, so a few files do not push the
                                // composer up the screen.
                                layout="chips"
                                onRemove={removeAttachment}
                                onOpen={(id) => {
                                  const a = attachments.find((attachment) => attachment.id === id)
                                  if (!a) return
                                  if (a.kind === 'image') {
                                    const url = a.preview || (a.path ? captureUrlForPath(a.path) : '')
                                    if (url) {
                                      closePanels()
                                      setLightbox({ url, path: a.path })
                                    }
                                    return
                                  }
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
                              />
                            </div>
                          ) : null}
                        </AutoHeight>
                        </PromptInputHeader>
                        {/* Approval UX v2: pending gate cards + outcomes, in-flow above the composer */}
                        <ActionGateDock conversationId={activeConversationId} />
                        {/* Vision rail: the supervisor overlay slides in during a computer-use task */}
                        {TaskSupervisorOverlay ? <TaskSupervisorOverlay /> : null}
                        {voiceTurns.microphoneDenied && (
                          <div
                            role="alert"
                            className="mx-2 mb-2 flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
                          >
                            <span>
                              Microphone access is off. Allow Off Grid AI Desktop in System Settings,
                              then try again.
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
                            subscribeAmplitudes={voiceTurns.subscribeAmplitudes}
                            onToggleRecording={toggleRecording}
                            onTurnModeChange={(mode: VoiceTurnMode) => {
                              setVoiceTurnMode(mode)
                              persistChangedPreference('composerVoiceTurnMode', mode)
                            }}
                          />
                        ) : (
                          <PromptInputBody>
                          <ChatDraftInput
                            ref={draftInputRef}
                            store={draftStore}
                            skills={skills}
                            mode={mode}
                            suggestion={
                              activeConversationId &&
                              nextMessages[activeConversationId]?.messageId === messages.at(-1)?.id &&
                              nextMessages[activeConversationId]?.answer === messages.at(-1)?.content
                                ? nextMessages[activeConversationId]?.text
                                : undefined
                            }
                            activeProjectName={activeProjectName ?? undefined}
                            attachmentPending={attachments.some(
                              (attachment) => attachment.status === 'loading'
                            )}
                            onPaste={handlePaste}
                            onSubmit={() => void sendMessage()}
                            onSendNow={() => void sendMessage(undefined, { sendNow: true })}
                            busy={Boolean(activeConversationId && generatingConvs.has(activeConversationId))}
                          />
                          </PromptInputBody>
                        )}
                        <PromptInputFooter className="cursor-auto select-auto flex-wrap gap-x-2 gap-y-2 px-2.5 pb-2.5 pt-1 font-normal text-foreground">
                          {/* Chips wrap to a new line on narrow widths instead of overflowing the composer
                      (the Image chip used to clip off the right edge). */}
                          <PromptInputTools className="flex-wrap gap-2">
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
                                onCloseAutoFocus={focusProjectName}
                              >
                                <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                                  <Paperclip /> Attach files
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => imageInputRef.current?.click()}>
                                  <ImageIcon /> Add image
                                </DropdownMenuItem>
                                {!god && (
<><DropdownMenuItem
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
                                          <FolderOpen />{' '}
                                          <span className="flex-1 truncate">{p.name}</span>
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
                                  <GodIcon /> <span className="flex-1">God</span>
                                  <span
                                    className={`text-xs ${toolsOn ? 'text-primary' : 'text-muted-foreground'}`}
                                  >
                                    {toolsOn ? 'On' : 'Off'}
                                  </span>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={(e) => {
                                    e.preventDefault()
                                    const next = !toolsEnabled
                                    setToolsEnabled(next)
                                    void window.api.saveSetting('toolsEnabled', next)
                                    window.dispatchEvent(new CustomEvent('offgrid-tools-enabled-changed', { detail: next }))
                                  }}
                                >
                                  <Wrench /> <span className="flex-1">Tools</span>
                                  <span className={`text-xs ${toolsEnabled ? 'text-primary' : 'text-muted-foreground'}`}>
                                    {toolsEnabled ? 'On' : 'Off'}
                                  </span>
                                </DropdownMenuItem></>
)}
                                {!god && (
<><DropdownMenuItem
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
                                </DropdownMenuItem></>
)}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            {!god && (
<>{/* Scope — Off Grid AI (default) or a project */}
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
                                onCloseAutoFocus={focusProjectName}
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
                            </DropdownMenu></>
)}
                            {/* God is set up already: its model, thinking and voice come from God's own settings. */}
{!god && (
<>{/* Active model + context window — click to change (opens the same
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
                                  {`Active model: ${modelSummary.name}${modelSummary.ctx ? ` · ${modelSummary.ctx} context window` : ''
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
                                  aria-pressed={toolsOn}
                                  onClick={() => {
                                    if (!isPro) {
                                      setAssistantGateOpen(true)
                                      return
                                    }
                                    setToolsOn((current) => !current)
                                  }}
                                  className={`h-8 gap-1.5 rounded-full ${toolsOn ? 'border-primary text-primary' : 'text-muted-foreground'}`}
                                >
                                  <GodIcon className="h-3.5 w-3.5" /> God
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {toolsOn
                                  ? 'God on - can act with Web Use or Computer Use'
                                  : 'God off - answers without controlling websites or apps'}
                              </TooltipContent>
                            </Tooltip>
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
                            </Tooltip></>
)}
                            {mode === 'image' && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    aria-label="Image options"
                                    onClick={() => setShowImageOptions((o) => !o)}
                                    className={`size-8 rounded-full ${showImageOptions ? 'border-green-500 text-primary' : ''}`}
                                  >
                                    <SlidersHorizontal className="h-3.5 w-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Image options</TooltipContent>
                              </Tooltip>
                            )}
                            <ChatDocuments
                              conversationId={activeConversationId}
                              revision={messages.length}
                              onOpen={(row) => messageNavigation.onOpenDocument?.(row.id, 1)}
                            />
                            {queuedCount(queuedByConv, activeConversationId) > 0 && (
                              <span className="flex h-8 items-center rounded-full border border-neutral-800 px-2.5 text-[11px] text-neutral-400">
                                <AnimatedNumber value={queuedCount(queuedByConv, activeConversationId)} />{' '}
                                queued
                              </span>
                            )}
                          </PromptInputTools>

                          <div className={`flex shrink-0 items-center gap-1.5 ${voiceMode ? 'mr-10' : ''}`}>
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
                                      <svg
                                        className="h-4 w-4"
                                        fill="currentColor"
                                        viewBox="0 0 24 24"
                                      >
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
                                        void stopGeneration(
                                          activeConversationId,
                                          guidanceTaskForJourney(getTaskSessionState().tasks, activeConversationId)
                                        )
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
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    aria-label="Stop"
                                    onClick={() => {
                                      void stopGeneration(
                                        activeConversationId,
                                        guidanceTaskForJourney(getTaskSessionState().tasks, activeConversationId)
                                      )
                                    }}
                                    className="size-8 rounded-full border-red-500/50 text-red-400 hover:bg-red-500/10"
                                  >
                                    <Stop className="h-3.5 w-3.5" weight="fill" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Stop</TooltipContent>
                              </Tooltip>
                            ) : voiceMode ? null : (
                              <ChatDraftSendButton
                                store={draftStore}
                                hasAttachments={attachments.length > 0}
                                attachmentPending={attachments.some(
                                  (attachment) => attachment.status === 'loading'
                                )}
                                onSubmit={() => void sendMessage()}
                              />
                            )}
                          </div>
                        </PromptInputFooter>
                        </PromptInput>
                      </div>
                    </div>
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          </Panel>
          {TaskWorkspace ? (
            <PanelResizeHandle
              aria-label="Resize Chat and task"
              title="Drag to resize Chat and task"
              className={`group relative w-2 shrink-0 cursor-col-resize border-x border-neutral-800 bg-neutral-950 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-500 ${taskWorkspaceVisible ? '' : 'hidden'
                }`}
              onDragging={setTaskWorkspaceDragging}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                event.stopPropagation()
                resizeTaskWorkspaceFromKeyboard(event.key)
              }}
              aria-valuemin={32}
              aria-valuemax={68}
              aria-valuenow={Math.round(taskWorkspaceSize)}
              aria-valuetext={`Task workspace ${Math.round(taskWorkspaceSize)} percent`}
            >
              <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-transparent group-hover:bg-green-500/50 group-focus-visible:bg-green-500 group-data-[resize-handle-state=drag]:bg-green-500" />
            </PanelResizeHandle>
          ) : null}
          {TaskWorkspace ? (
            <Panel
              ref={taskWorkspaceRef}
              id="task-workspace"
              order={2}
              defaultSize={48}
              minSize={32}
              collapsible
              collapsedSize={0}
              className="min-w-0"
              style={{ transition: taskWorkspaceTransition }}
              onResize={reportTaskSize}
            >
              <TaskWorkspace
                mainWorkspaceCollapsed={chatBodyCollapsed}
                onToggleMainWorkspace={toggleChatBodyVisibility}
                onDetailModeChange={handleTaskDetailModeChange}
                routeActive
                conversationId={activeConversationId}
              />
            </Panel>
          ) : null}
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
            <ModelPicker
              key="model-picker"
              onClose={() => {
                setModelPickerOpen(false)
                refreshChatVision()
              }}
            />
          )}

          {settingsOpen && (
            <SettingsPanel
              key={`model-settings-${settingsInitialTab}`}
              initialTab={settingsInitialTab}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </AnimatePresence>

        {/* Attachment viewer — preserve chat context in the shared Desktop side panel. */}
        <AnimatePresence>
          {viewer && (
            <SidePanel
              key="viewer"
              ariaLabel={viewer.title}
              onClose={() => setViewer(null)}
              className="w-[min(720px,92vw)] overflow-hidden text-white"
            >
              <header className="flex items-center justify-between gap-3 border-b border-neutral-900 px-4 py-3">
                <h2 className="min-w-0 truncate text-sm font-normal text-neutral-200">
                  {viewer.title}
                </h2>
                <div className="flex shrink-0 items-center gap-1.5">
                  {viewer.path && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="outline"
                          aria-label="Download"
                          onClick={() => downloadImage(viewer.path, viewer.title)}
                        >
                          <DownloadSimple />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Download</TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Close"
                        onClick={() => setViewer(null)}
                      >
                        <X />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Close</TooltipContent>
                  </Tooltip>
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-auto p-4">
                <AttachmentPreview
                  key={`${viewer.path ?? ''}:${viewer.title}:${viewer.page ?? 0}`}
                  content={viewer}
                />
              </div>
            </SidePanel>
          )}
        </AnimatePresence>

        <ImageLightbox
          image={
            lightbox
              ? {
                url: lightbox.url,
                alt: 'Generated preview',
                dialogLabel: 'Generated image preview'
              }
              : null
          }
          onClose={() => setLightbox(null)}
          actions={
            lightbox?.path ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      aria-label="Download"
                      onClick={() => downloadImage(lightbox.path!, lightbox.path?.split('/').pop())}
                      className="hover:border-green-500 hover:text-green-500"
                    >
                      <DownloadSimple />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Download</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      aria-label="Delete"
                      onClick={() => deleteImage(lightbox.path!)}
                      className="hover:border-red-500 hover:text-red-400"
                    >
                      <Trash />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete</TooltipContent>
                </Tooltip>
              </>
            ) : undefined
          }
        />

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
                      <div className="flex flex-col divide-y divide-neutral-900 overflow-hidden rounded-md border border-neutral-800">
                        {artifacts.map((a) => (
                          <div
                            key={a.id}
                            className="group flex items-center gap-2 px-3 py-2 transition-colors hover:bg-neutral-900/60"
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
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  size="icon-xs"
                                  variant="ghost"
                                  onClick={() => deleteArtifact(a.id)}
                                  aria-label="Delete"
                                  className="text-neutral-600 opacity-0 transition-opacity hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
                                >
                                  <Trash />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Delete</TooltipContent>
                            </Tooltip>
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
        <Dialog open={assistantGateOpen} onOpenChange={setAssistantGateOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>God acting needs Pro</DialogTitle>
              <DialogDescription>
                God acts with Web Use and Computer Use on this Desktop.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                onClick={() => {
                  setAssistantGateOpen(false)
                  onOpenAssistantUpgrade?.()
                }}
              >
                View Pro
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </ActiveConversationProvider>
  )
}
