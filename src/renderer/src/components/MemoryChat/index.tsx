import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { shouldQueue, enqueue, dequeue, queuedCount, clearQueue } from '@renderer/lib/chat-queue'
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
import {
  REQUEST_FORM_URL,
  presetById,
  type DemoPreset
} from '../explore/presetCatalog'
import { useChatVoiceTurns } from '../use-chat-voice-turns'
import { SkillsPanel } from '../SkillsPanel'
import { ModelPicker } from '../ModelPicker'
import { SettingsPanel } from '../SettingsPanel'
import { OPEN_ACTIVE_MODELS_PANEL_EVENT } from '@renderer/lib/model-settings-panel'
import { LoadingDots } from '../ui/loading-dots'
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
import {
  buildAssistantContext,
  type AssistantTimelineEntry
} from '../../lib/message-persistence'
import type { GenerationMetrics } from '../../../../shared/generation-metrics'
import { withGeneratedImageReference } from '../../../../shared/generated-image-reference'
import type {
  RagConversationContract,
  ResponseCutoffContract
} from '../../../../shared/ipc-contracts'
import {
  parseImageMemoryGuardError,
  type ImageGenerationJobContract,
  type ImageGenerationRequestContract
} from '../../../../shared/image-generation-contract'
import { Button } from '@renderer/components/ui/button'
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
import {
  Plus,
  Paperclip,
  Image as ImageIcon,
  Sparkle as Sparkles,
  FolderPlus,
  Robot,
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

import type { MemoryChatProps } from './interfaces'
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
  RagContext,
  StoredAttachment
} from './types'
import {
  announceImageMessagePersisted,
  attachmentsOf,
  completedImageMessage,
  groupChatTurnWork,
  mapRagMessages,
  mergeDurableAndStreaming,
  mergeRemotePreviewTools
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
import { AudioPane, DocumentPane } from './components/AttachmentPanes'
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
  seedStreamViewMessage
} from './stream-view-store'

import { stopLiveTask, stopLiveWebUseForConversation } from './helper'
import {
  ACTIVE_CHAT_TAB_KEY,
  EMPTY_MSGS,
  NEW_CHAT,
  nextVoicePlaybackOwner,
  OPEN_CHAT_TABS_KEY,
  stopFailureMessage,
  textRecordingButtonLabel,
  textRecordingTooltip
} from './utlis'

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
  onTaskDetailModeChange
}: MemoryChatProps): React.JSX.Element {
  const { isPro } = useRendererEntitlement()
  // Messages are kept PER CONVERSATION so a background tab keeps its own thread and
  // an in-flight stream can't leak into whatever tab you switch to. `messages` (below,
  // after activeConversationId) is the active tab's slice; sends target their own conv.
  const [messagesByConv, setMessagesByConv] = useState<Record<string, ChatMessage[]>>({})
  const messagesByConvRef = useRef(messagesByConv)
  messagesByConvRef.current = messagesByConv
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
        .catch(() => { })
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
      .catch(() => { })
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
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    readActiveConversationId
  )
  useEffect(() => {
    console.log('MemoryChat effect: active conversation notification')
    onActiveConversationChange?.(activeConversationId)
  }, [activeConversationId, onActiveConversationChange])
  // Active tab's messages (derived) + a shim so the existing active-conversation call
  // sites keep working. The send path targets its own conv via setConvMessages instead.
  const messages = messagesByConv[activeConversationId ?? NEW_CHAT] ?? EMPTY_MSGS
  const displayMessages = useMemo(() => groupChatTurnWork(messages), [messages])
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
  const liveJourneyTask = guidanceTaskForJourney(
    getTaskSessionState().tasks,
    activeConversationId
  )
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
  const [openTabs, setOpenTabs] = useState<string[]>(readOpenChatTabs) // conversation ids open as tabs
  useEffect(() => {
    console.log('MemoryChat effect: persist open chat tabs')
    try {
      window.localStorage.setItem(OPEN_CHAT_TABS_KEY, JSON.stringify(openTabs))
    } catch {
      // Chat still works when renderer storage is unavailable.
    }
  }, [openTabs])
  useEffect(() => {
    console.log('MemoryChat effect: persist active chat tab')
    try {
      if (activeConversationId)
        window.localStorage.setItem(ACTIVE_CHAT_TAB_KEY, activeConversationId)
      else window.localStorage.removeItem(ACTIVE_CHAT_TAB_KEY)
    } catch {
      // Chat still works when renderer storage is unavailable.
    }
  }, [activeConversationId])
  const TaskWorkspace = isPro ? getSlot(SLOTS.taskWorkspace) : undefined
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
  const [projects, setProjects] = useState<ProjectLite[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  // Captured-memory context is a Pro ("remembers") feature; core chats are plain
  // (no memory) or scoped to a project. The UI never says "memory".
  const [noMemory, setNoMemory] = useState(!isPro)
  const [, setProjectMenuOpen] = useState(false)
  const [projCreating, setProjCreating] = useState(false)
  const [toolsOn, setToolsOn] = useState(false)
  const [toolsEnabled, setToolsEnabled] = useState(true)
  const [assistantGateOpen, setAssistantGateOpen] = useState(false)
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
    composerVoiceMode: voiceMode,
    imgSeed,
    imgNegative,
    enhanceImagePrompts: enhanceImg,
    imgStrength,
    imgStyle: activeStyle,
    imageParams: imgParamStore
  })
  const persistChangedPreference = useCallback((key: string, value: unknown): void => {
    if (Object.is(persistedPreferenceValues.current[key], value)) return
    persistedPreferenceValues.current[key] = value
    void window.api.saveSetting(key, value)
  }, [])
  useEffect(() => {
    console.log('MemoryChat effect: hydrate composer preferences')
      ; (async () => {
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
    persistChangedPreference('composerVoiceMode', voiceMode)
  }, [persistChangedPreference, voiceMode])
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
  useEffect(() => {
    console.log('MemoryChat effect: persist image seed')
    persistChangedPreference('imgSeed', imgSeed)
  }, [imgSeed, persistChangedPreference])
  useEffect(() => {
    console.log('MemoryChat effect: persist negative prompt')
    persistChangedPreference('imgNegative', imgNegative)
  }, [imgNegative, persistChangedPreference])
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
  } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
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
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const voiceMountedRef = useRef(true)
  const speechRequestRef = useRef(0)
  const pendingVariantsRef = useRef<string[] | null>(null) // prior answers to keep when regenerating
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
  const markGenerating = useCallback((cid: string, on: boolean): void => {
    if (on) generatingRef.current.add(cid)
    else generatingRef.current.delete(cid)
    setGeneratingConvs(new Set(generatingRef.current))
  }, [])
  // Queued sends carry their attachments too, so a message waiting behind an in-flight
  // generation keeps its image/files when it finally runs — keyed per conversation.
  const queuedRef = useRef<
    Record<string, { text: string; atts: Attachment[]; assistantEnabled?: boolean }[]>
  >({})
  const [queuedByConv, setQueuedByConv] = useState<
    Record<string, { text: string; atts: Attachment[]; assistantEnabled?: boolean }[]>
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
      const convos = await window.api.getRagConversations().catch(() => [])
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
      .catch(() => { })
    window.api
      .styleThumbs()
      .then((t: Record<string, string>) => setStyleThumbs(t))
      .catch(() => { })
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
        setMessagesByConv((prev) =>
          prev[convId]?.some((m) => m.streaming) ? prev : { ...prev, [convId]: nextMessages }
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
      ; (async () => {
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
    const assistantForTurn = opts?.assistantEnabled ?? toolsOn
    if (!regen && opts?.assistantEnabled === undefined) setToolsOn(false)
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
    const typed = (override ?? draftStore.getSnapshot()).trim()
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
    if (shouldQueue(targetConv, generatingRef.current)) {
      const item = { text: typed, atts, assistantEnabled: assistantForTurn }
      queuedRef.current = enqueue(queuedRef.current, targetConv as string, item)
      setQueuedByConv({ ...queuedRef.current })
      if (isInput) {
        draftStore.set('')
        setAttachments([])
      }
      return
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
    draftStore.set('')
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
    const agenticActive = isAgenticTurn({ toolsOn: assistantForTurn, connectorsOn })
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
            ? { modelName: img.model, totalSeconds: img.durationMs / 1000 }
            : undefined
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
          imageMetadata,
          ...(img.durationMs === undefined ? {} : { generationTimeMs: img.durationMs }),
          ...(imageMetrics ? { metrics: imageMetrics } : {})
        }
        setConvMessages(convId, (prev) => [...prev, assistantMessage])
        if (voiceMode) setAutoPlayId(assistantMessage.id)
        try {
          const stored = await window.api.addRagMessage(
            convId,
            'assistant',
            completedImage.storedContent,
            withGeneratedImageReference(
              {
                imageMetadata,
                ...(img.durationMs === undefined ? {} : { durationMs: img.durationMs }),
                ...(imageMetrics ? { metrics: imageMetrics } : {})
              },
              { id: img.syncId, path: img.path }
            )
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
      const contextWindowTokens =
        typeof window.api.getLlmSettings === 'function'
          ? await window.api
            .getLlmSettings()
            .then((settings) => settings?.ctxSize)
            .catch(() => undefined)
          : undefined
      const history = buildSendHistory(
        messagesByConv[convId] ?? EMPTY_MSGS,
        !!regen,
        trimmed,
        20,
        contextWindowTokens
      )
      const fullHistory = buildSendHistory(
        messagesByConv[convId] ?? EMPTY_MSGS,
        !!regen,
        trimmed,
        20,
        Number.MAX_SAFE_INTEGER
      )
      if (!agenticActive && JSON.stringify(history) !== JSON.stringify(fullHistory)) {
        try {
          const stored = await window.api.addRagMessage(convId, 'assistant', '_Compacted_', {
            notice: true
          })
          setConvMessages(convId, (previous) => [
            ...previous,
            { id: stored.uuid, role: 'assistant', content: '_Compacted_', notice: true }
          ])
        } catch (error) {
          console.warn('Could not save the compaction notice', error)
        }
      }
      // Agentic tools path (opt-in, non-project). The model calls built-in tools,
      // plus (when Connectors is on) MCP connector tools. STREAMS like the RAG path:
      // a streamId placeholder fills in live - thinking, then each tool-call activity
      // step, then the answer - and the stop button aborts it via rag:cancel.
      if (agenticActive) {
        if (cancelledRef.current.has(convId)) return
        const toolStreamId = `a-${Date.now()}`
        activeStreamId = toolStreamId
        streamConvRef.current.set(toolStreamId, convId!)
        const toolStreamMessage: ChatMessage = {
          id: toolStreamId,
          role: 'assistant',
          content: '',
          reasoning: '',
          reasoningRequested: thinkingEnabled,
          streaming: true
        }
        seedStreamViewMessage(toolStreamMessage)
        setConvMessages(convId, (prev) => [
          ...prev,
          toolStreamMessage
        ])
        const tr = await window.api.toolChat(modelQuery, fullHistory.slice(0, -1), {
          assistantOnly: assistantForTurn,
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
        let imageRequests = tr?.imageRequests ?? []
        if (imageRequests.length === 0 && tr?.imageRequest?.prompt) {
          imageRequests = [tr.imageRequest]
        }
        const pureImageToolTurn =
          toolCalls.length > 0 && toolCalls.every((toolCall) => toolCall.name === 'generate_image')
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
        // Keep the tool timeline in place while its deferred image job runs. The completed image
        // replaces this row, so the timeline does not disappear and then return in a new position.
        setConvMessages(convId, (prev) =>
          prev.map((message) =>
            message.id === toolStreamId
              ? {
                ...message,
                content: imageRequests.length > 0 ? '' : answer,
                context,
                reasoning: toolReasoning,
                toolCalls: pendingToolCalls,
                timeline: toolTimeline,
                toolsOffered: tr?.toolsOffered,
                metrics: tr?.metrics,
                activity: undefined,
                streaming: false
              }
              : message
          )
        )
        const toolCtxWithReasoning = buildAssistantContext(toolCtx, {
          reasoning: toolReasoning,
          timeline: toolTimeline,
          metrics: tr?.metrics
        })
        // Deferred image generation: the tool loop only RECORDS prompts (it never generates inline,
        // which would evict the LLM). Each completed request gets one generated file and one durable
        // assistant image message. A message context has one imageRef by design; putting two results
        // on one row would make the last context write replace the first association.
        if (
          imageRequests.length > 0 &&
          !cancelledRef.current.has(convId)
        ) {
          // The tool loop has finished its text answer and handed ownership to the
          // deferred image job. Mark that ownership exactly like explicit image mode
          // so the rendered Stop control cancels imagegen (not the already-finished
          // RAG stream) and remains scoped to this conversation.
          setImgProgress(null)
          setImageGenConv(convId)
          let generatedImageCount = 0
          const comicPageTotal = modelQuery.includes('<!-- offgrid-action:comic-book -->')
            ? comicBookPageCount(modelQuery)
            : null
          const comicPages: ComicBookPage[] = []
          const comicTitle = comicPageTotal
            ? comicBookTitle(imageRequests[0]?.prompt ?? '') ??
              comicBookTitle(modelQuery) ??
              'Comic Book'
            : 'Comic Book'
          const comicHeroSource = comicPageTotal ? comicBookHeroImage(modelQuery) : null
          const keptComicHero = comicHeroSource
            ? await window.api.keepInitImage(comicHeroSource).catch(() => null)
            : null
          const comicHeroPath = keptComicHero?.path ?? comicHeroSource
          const comicReaderMessageId = `comic-reader-${toolStreamId}`
          let comicArtifactId: string | null = null
          const updateComicReader = async (): Promise<void> => {
            if (!comicPageTotal) return
            const html = buildComicBookReader(comicPages, comicPageTotal, comicTitle)
            const content = `Comic book reader: ${comicPages.length} of ${comicPageTotal} pages ready.\n\n\`\`\`html\n${html}\n\`\`\``
            setConvMessages(convId, (previous) => {
              const reader: ChatMessage = {
                id: comicReaderMessageId,
                role: 'assistant',
                content
              }
              const existing = previous.findIndex((message) => message.id === comicReaderMessageId)
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
                  (artifact) =>
                    artifact.id !== saved.id && artifact.id !== previousArtifactId
                )
              ])
              if (previousArtifactId && previousArtifactId !== saved.id) {
                await window.api.deleteArtifact(previousArtifactId)
              }
            } catch {
              /* The live reader remains available if artifact persistence fails. */
            }
          }
          if (comicPageTotal) {
            setConvMessages(convId, (previous) =>
              previous.filter((message) => message.id !== toolStreamId)
            )
            await updateComicReader()
          }
          try {
            for (const imageRequest of imageRequests) {
              if (cancelledRef.current.has(convId)) break
              setImgProgress(null)
              const comicPage = comicPageTotal
                ? comicBookPageFromPrompt(imageRequest.prompt)
                : null
              const generationPrompt = comicPage?.prompt ?? imageRequest.prompt
              try {
                const img = await window.api.generateImage({
                  prompt: generationPrompt,
                  ...(comicHeroPath ? { initImage: comicHeroPath, strength: 0.72 } : {}),
                  conversationId: convId,
                  projectId: projectId
                })
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
                    ? { modelName: img.model, totalSeconds: img.durationMs / 1000 }
                    : undefined
                if (!comicPageTotal) {
                  const ownsToolTurn = generatedImageCount === 0
                  const imageContent =
                    ownsToolTurn && !pureImageToolTurn
                      ? answer
                      : `Generated for: ${imageRequest.prompt}`
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
                      withGeneratedImageReference(
                        {
                          ...(ownsToolTurn ? toolCtxWithReasoning : {}),
                          ...(imageMetadata ? { imageMetadata } : {}),
                          ...(img.durationMs === undefined ? {} : { durationMs: img.durationMs }),
                          ...(imageMetrics ? { metrics: imageMetrics } : {})
                        },
                        { id: img.syncId, path: img.path }
                      )
                    )
                    imageMessageId = stored.uuid
                    await announceImageMessagePersisted(convId, stored.uuid)
                  } catch {
                    /* Keep the generated file visible even if this database write fails. */
                  }
                  setConvMessages(convId, (prev) => [
                    ...prev.filter((message) => !ownsToolTurn || message.id !== toolStreamId),
                    {
                      id: imageMessageId,
                      role: 'assistant',
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
                      ...(img.durationMs === undefined
                        ? {}
                        : { generationTimeMs: img.durationMs }),
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
                  setConvMessages(convId, (previous) => [
                    ...previous,
                    {
                      id: crypto.randomUUID(),
                      role: 'assistant',
                      content: message,
                      imageMemoryRetry: memoryGuard
                        ? {
                          request: { prompt: imageRequest.prompt },
                          prompt: imageRequest.prompt,
                          conversationId: convId,
                          projectId
                        }
                        : undefined
                    }
                  ])
                }
              }
            }
            if (comicPageTotal && comicPages.length > 0) {
              const finalHtml = buildComicBookReader(comicPages, comicPageTotal, comicTitle)
              const finalContent = `Comic book reader: ${comicPages.length} of ${comicPageTotal} pages ready.\n\n\`\`\`html\n${finalHtml}\n\`\`\``
              try {
                const stored = await window.api.addRagMessage(
                  convId,
                  'assistant',
                  finalContent,
                  toolCtxWithReasoning
                )
                setConvMessages(convId, (previous) => [
                  ...previous.filter(
                    (message) => message.id !== toolStreamId && message.id !== comicReaderMessageId
                  ),
                  {
                    id: stored.uuid,
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
              if (comicArtifactId) {
                await window.api.deleteArtifact(comicArtifactId).catch(() => false)
                setArtifacts((current) =>
                  current.filter((artifact) => artifact.id !== comicArtifactId)
                )
              }
              setConvMessages(convId, (previous) =>
                previous.filter((message) => message.id !== comicReaderMessageId)
              )
              setCanvasArtifact(null)
            }
          } finally {
            setImgProgress(null)
            setImageGenConv((owner) => (owner === convId ? null : owner))
          }
          if (generatedImageCount === 0) {
            let restoredMessageId = toolStreamId
            try {
              const stored = await window.api.addRagMessage(
                convId,
                'assistant',
                answer,
                toolCtxWithReasoning
              )
              restoredMessageId = stored.uuid
            } catch {
              /* The completed text answer remains visible if persistence fails. */
            }
            setConvMessages(convId, (previous) => [
              ...previous.filter((message) => message.id !== toolStreamId),
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
      const streamMessage: ChatMessage = {
        id: streamId,
        role: 'assistant',
        content: '',
        reasoning: '',
        reasoningRequested: thinkingEnabled,
        streaming: true
      }
      seedStreamViewMessage(streamMessage)
      setConvMessages(convId, (prev) => [
        ...prev,
        streamMessage
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
      if (imgMatch) {
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
              ? { modelName: img.model, totalSeconds: img.durationMs / 1000 }
              : undefined
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
                  imagePath: img.path,
                  imageMetadata,
                  ...(img.durationMs === undefined ? {} : { generationTimeMs: img.durationMs }),
                  ...(imageMetrics ? { metrics: imageMetrics } : {})
                }
                : m
            )
          )
          if (voiceMode) setAutoPlayId(streamId)
          try {
            const stored = await window.api.addRagMessage(
              convId,
              'assistant',
              completedImage.storedContent,
              withGeneratedImageReference(
                {
                  ...(imageMetadata ? { imageMetadata } : {}),
                  ...(img.durationMs === undefined ? {} : { durationMs: img.durationMs }),
                  ...(imageMetrics ? { metrics: imageMetrics } : {})
                },
                { id: img.syncId, path: img.path }
              )
            )
            await announceImageMessagePersisted(convId, stored.uuid)
          } catch {
            /* ignore */
          }
        } catch (err) {
          const memoryGuard = parseImageMemoryGuardError(err)
          const msg =
            memoryGuard?.message ||
            (err instanceof Error ? err.message : 'Image generation failed.')
          if (!/cancel/i.test(msg))
            setConvMessages(convId, (prev) =>
              prev.map((m) =>
                m.id === streamId
                  ? {
                    ...m,
                    content: msg,
                    streaming: false,
                    imageMemoryRetry: memoryGuard
                      ? {
                        request: { prompt: imgPrompt },
                        prompt: imgPrompt,
                        conversationId: convId,
                        projectId
                      }
                      : undefined
                  }
                  : m
              )
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
        const ragTimeline = timelineByStream.current[streamId]
        const ragToolCalls = toolCallsByStream.current[streamId]
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
                // On the LIVE message too, not only in the persisted context: the numbers are
                // about the turn that just finished, so waiting for a reload to show them defeats
                // the point.
                metrics: result.metrics,
                reasoning: ragReasoning,
                timeline: ragTimeline,
                toolCalls: ragToolCalls,
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
              cutoff: result.cutoff,
              metrics: result.metrics
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
      const errorContent = generationErrorContent(e)
      // Update the streaming placeholder to show the error — never append a second bubble.
      const sid = activeStreamId
      const failedReasoning = sid ? reasoningByStream.current[sid] : undefined
      const failedTimeline = sid ? timelineByStream.current[sid] : undefined
      const failedToolCalls = sid ? toolCallsByStream.current[sid] : undefined
      setConvMessages(convId, (prev) => {
        const hasPlaceholder = sid && prev.some((m) => m.id === sid)
        if (hasPlaceholder)
          return prev.map((m) =>
            m.id === sid
              ? {
                ...m,
                content: errorContent,
                reasoning: failedReasoning,
                timeline: failedTimeline,
                toolCalls: failedToolCalls,
                activity: undefined,
                streaming: false
              }
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
      if (activeStreamId) {
        streamConvRef.current.delete(activeStreamId)
        delete timelineByStream.current[activeStreamId]
        delete toolCallsByStream.current[activeStreamId]
        clearStreamViewMessage(activeStreamId)
      }
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
      void sendMessage(item.text || ' ', {
        atts: item.atts,
        conversationId: convId,
        assistantEnabled: item.assistantEnabled
      })
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
    transcribeAudio: (audio, extension, requestId) =>
      window.api.transcribeAudio(audio, extension, requestId),
    cancelTranscription: (requestId) => window.api.cancelTranscription(requestId),
    getTranscriptionLabel: () => window.api.getTranscriptionInfo(),
    onTranscript: (text, clip) => {
      if (voiceMode && clip) {
        void sendMessage(text, { voiceClip: clip })
        return
      }
      draftStore.update((previous) => `${previous}${previous ? ' ' : ''}${text}`)
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
        toolsOffered?: ChatMessage['toolsOffered']
      }
    ): Promise<void> => {
      if (!streamConvRef.current.has(streamId)) return
      streamConvRef.current.delete(streamId)
      const current = (messagesByConv[convId] ?? []).find((message) => message.id === streamId)
      const reasoning = reasoningByStream.current[streamId]?.trim() || undefined
      const timeline = timelineByStream.current[streamId] ?? current?.timeline
      const toolCalls =
        settled?.toolCalls ?? toolCallsByStream.current[streamId] ?? current?.toolCalls
      const toolsOffered = settled?.toolsOffered ?? current?.toolsOffered
      const streamed = answerByStream.current[streamId] || ''
      delete reasoningByStream.current[streamId]
      delete timelineByStream.current[streamId]
      delete toolCallsByStream.current[streamId]
      delete answerByStream.current[streamId]

      const answer = (settled?.answer ?? streamed).trim()

      setConvMessages(convId, (prev) =>
        prev.map((m) =>
          m.id === streamId
            ? {
              ...m,
              content: answer,
              reasoning,
              timeline,
              context: settled?.context ?? m.context,
              cutoff: settled?.cutoff ?? m.cutoff,
              toolCalls,
              toolsOffered,
              turnStatus: 'cancelled',
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
          buildAssistantContext(
            {
              ...(settled?.persistContext ?? settled?.context),
              ...(toolCalls?.length ? { toolCalls } : {}),
              ...(toolsOffered?.length ? { toolsOffered } : {}),
              status: 'cancelled'
            },
            {
              reasoning,
              timeline,
              cutoff: settled?.cutoff
            }
          )
        )
      } catch (e) {
        console.error('Failed to persist stopped assistant message:', e)
      }
    },
    [messagesByConv, setConvMessages]
  )

  const stopGeneration = useCallback(
    async (
      cid: string | null,
      task: Pick<TaskSession, 'taskId' | 'journeyId' | 'kind'> | null
    ): Promise<void> => {
      const convId = cid ?? activeConversationId
      if (!convId) return
      cancelledRef.current.add(convId)
      if (task?.journeyId === convId) {
        try {
          const stopped = await stopLiveTask(task)
          if (!stopped) {
            cancelledRef.current.delete(convId)
            setAttachWarn(stopFailureMessage(task.kind))
            return
          }
        } catch (error) {
          cancelledRef.current.delete(convId)
          console.error(`Failed to stop ${task.kind} task ${task.taskId}:`, error)
          setAttachWarn(stopFailureMessage(task.kind))
          return
        }
      }
      setAttachWarn(null)
      const streamingId = (messagesByConv[convId] ?? []).find((m) => m.streaming)?.id
      if (streamingId) {
        window.api.cancelRag(streamingId)
        await finalizeStoppedTurn(convId, streamingId)
      }
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
    [activeConversationId, finalizeStoppedTurn, messagesByConv, markGenerating, imageGenConv]
  )

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
    const off = window.api.onRagStream((data) => {
      const cid = streamConvRef.current.get(data.streamId)
      if (!cid) return
      if (data.type === 'done') {
        streamConvRef.current.delete(data.streamId)
        markGenerating(cid, false)
        return
      }
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
        const notice: ChatMessage = {
          id: noticeId,
          role: 'assistant',
          content: '_Compacted_',
          notice: true
        }
        setConvMessages(cid, (previous) => {
          const streamIndex = previous.findIndex((message) => message.id === data.streamId)
          if (streamIndex < 0) return [...previous, notice]
          return [...previous.slice(0, streamIndex), notice, ...previous.slice(streamIndex)]
        })
        void window.api
          .addRagMessage(cid, 'assistant', '_Compacted_', { notice: true })
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
      .then((streams) => {
        if (disposed) return
        for (const stream of streams) {
          streamConvRef.current.set(stream.streamId, stream.conversationId)
          reasoningByStream.current[stream.streamId] = stream.reasoning
          timelineByStream.current[stream.streamId] = [
            ...(stream.reasoning.trim()
              ? [{ kind: 'thinking' as const, text: stream.reasoning }]
              : []),
            ...(stream.tools ?? []).map((_, toolIndex) => ({ kind: 'tool' as const, toolIndex }))
          ]
          toolCallsByStream.current[stream.streamId] = (stream.tools ?? []).map((tool) => ({
            name: tool.name,
            result: tool.result ?? '',
            status: tool.status
          }))
          answerByStream.current[stream.streamId] = stream.content
          markGenerating(stream.conversationId, true)
          const restored: ChatMessage = {
            id: stream.streamId,
            role: 'assistant',
            content: stream.content,
            reasoning: stream.reasoning,
            timeline: timelineByStream.current[stream.streamId],
            reasoningRequested: stream.reasoningRequested,
            streaming: true,
            toolCalls: stream.tools?.map((tool) => ({
              name: tool.name,
              result: tool.result ?? '',
              status: tool.status
            }))
          }
          seedStreamViewMessage(restored)
          setConvMessages(stream.conversationId, (previous) => {
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
      // A regeneration replaces the current answer. Do not let a stale click race an active
      // stream and truncate the turn that still owns the conversation.
      if (activeConversationId && generatingRef.current.has(activeConversationId)) return
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
            // Resend replaces this turn immediately. Do this before stopping its
            // operator task, because that stop can publish a terminal preview while
            // the main process is still removing the old durable answer.
            setRemoteWorkPreview(null)
            setMessages((prev) => prev.slice(0, i + 1))
            await stopLiveWebUseForConversation(activeConversationId)
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
  const saveEdit = (id: string, editedText: string): void => {
    const text = editedText.trim()
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
    const keptAtts = edited
      ? attachmentsOf(edited).map((attachment) =>
        attachment.kind === 'audio' ? { ...attachment, text } : attachment
      )
      : []
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
      }
    }),
    [
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
      updateVoiceTranscript: (...args) =>
        messageActionsRef.current.updateVoiceTranscript(...args),
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
                                    setPresetSetup(preset)
                                    setToolsOn(true)
                                  }}
                                  requestUrl={REQUEST_FORM_URL}
                                  className="mt-6 w-full text-left"
                                />
                              ) : null}
                              {mode === 'image' ? (
                                showImageOptions ? (
                                  <StylePresetPicker
                                    activeStyle={activeStyle}
                                    styleThumbs={styleThumbs}
                                    onChange={setActiveStyle}
                                  />
                                ) : null
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
                            </>
                          )}
                        </div>
                      ) : (
                        <div className="w-full px-6 py-5">
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
                              return <ToolMessageTimelineRow key={message.id} messages={run} />
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
                                  showGenerationDetails,
                                  regenerationDisabled:
                                    !!activeConversationId && generatingConvs.has(activeConversationId)
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
                                    <span className="text-[11px] text-neutral-500" role="status">
                                      {waitingLabel({ noMemory, hasProject: !!activeProjectId })}
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
                                setStepsOverride(
                                  Math.max(4, Math.min(50, Number(e.target.value) || 16))
                                )
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
                          onCreate={createAndAssignProject}
                          onCancel={() => setProjCreating(false)}
                        />
                      )}

                      {queuedCount(queuedByConv, activeConversationId) > 0 && (
                        <div className="mb-2 flex flex-col gap-1">
                          {(activeConversationId
                            ? (queuedByConv[activeConversationId] ?? [])
                            : []
                          ).map((q, i) => (
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
                          ))}
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
                                      const url =
                                        a.preview || (a.path ? captureUrlForPath(a.path) : '')
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
                                  <span
                                    className="truncate text-[10px] text-neutral-400"
                                    title={a.name}
                                  >
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
                            onToggleRecording={toggleRecording}
                          />
                        ) : (
                          <ChatDraftInput
                            ref={draftInputRef}
                            store={draftStore}
                            skills={skills}
                            mode={mode}
                            activeProjectName={activeProjectName ?? undefined}
                            attachmentPending={attachments.some(
                              (attachment) => attachment.status === 'loading'
                            )}
                            onPaste={handlePaste}
                            onSubmit={() => void sendMessage()}
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
                                  <Robot /> <span className="flex-1">Assistant</span>
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
                            {/* Scope — Off Grid AI (default) or a project */}
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
                                  <Robot className="h-3.5 w-3.5" /> Assistant
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {toolsOn
                                  ? 'Assistant on - can use Web Use or Computer Use'
                                  : 'Assistant off - answers without controlling websites or apps'}
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
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => {
                                  void stopGeneration(
                                    activeConversationId,
                                    guidanceTaskForJourney(getTaskSessionState().tasks, activeConversationId)
                                  )
                                }}
                                className="h-8 gap-1.5 border-red-500/50 text-red-400 hover:bg-red-500/10"
                              >
                                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                                  <rect x="6" y="6" width="12" height="12" rx="2" />
                                </svg>
                                Stop
                              </Button>
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
                        </div>
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
                <button
                  type="button"
                  onClick={() => downloadImage(lightbox.path!, lightbox.path?.split('/').pop())}
                  className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:border-green-500 hover:text-green-500"
                >
                  Download
                </button>
                <button
                  type="button"
                  onClick={() => deleteImage(lightbox.path!)}
                  className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:border-red-500 hover:text-red-400"
                >
                  Delete
                </button>
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
        <Dialog open={assistantGateOpen} onOpenChange={setAssistantGateOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Assistant requires Pro</DialogTitle>
              <DialogDescription>
                Assistant uses Web Use and Computer Use on this Desktop.
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
