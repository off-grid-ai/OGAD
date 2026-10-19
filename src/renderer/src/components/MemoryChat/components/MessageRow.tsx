import { memo, useCallback, useEffect, useState } from 'react'
import { attachmentKindFor, type SyncedMessageRole } from '@offgrid/sync'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import { Message, MessageContent } from '@offgrid/operator-ui/operator/elements/message-core'
import { hasLiveStreamActivity } from '@renderer/lib/stream-reducer'
import { type TaskSession, useGuidanceTaskForJourney } from '@renderer/lib/task-session-store'
import { captureUrlForPath, capturePathFromUrl } from '../../../../../shared/ogcapture-url'
import { useMediaUrl } from '@renderer/lib/media-url'
import { ChatThinkingBlock } from '../../ChatThinkingBlock'
import { ChatToolRows } from '../../ChatToolRows'
import { VoiceBubble } from '../../VoiceBubble'
import { LoadingDots } from '../../ui/loading-dots'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { parseArtifact } from '../../ArtifactCanvas'
import type {
  ChatMessage,
  ContextNavigation,
  MessageRowActions,
  MessageRowProps,
  MessageRowState,
  OpenImage,
  StoredMessageAttachment
} from '../types'
import {
  activityLabel,
  assistantWorkIsSettled,
  isPromptEnhancementMessage,
  isSupportingMessage,
  messageContentClass,
  messageToSpeakable,
  parseAsk,
  selectedMessageContent,
  standardMessageBubbleClass,
  standardMessageRowClass
} from '../utlis'
import { ChatImagePreview } from './ChatImagePreview'
import { NoticeMessageRow } from './NoticeMessageRow'
import { PromptEnhancementMessageRow } from './PromptEnhancementMessageRow'
import { ToolMessageTimelineRow } from './ToolMessageTimelineRow'
import { MessageThinkingHeader } from './MessageThinkingHeader'
import { IncomingFileRows, MessageAttachments, MessageEditor } from './MessageContent'
import { GenerationMetricsRow, ResponseCutoffNotice, ToolsSentDisclosure } from './MessageMetadata'
import { ArtifactCard, AskCard, ImageMemoryRetryAction } from './MessageCards'
import {
  CopyAction,
  MessageActionsMenu,
  UserMessageActions,
  VoiceMessageActions
} from './MessageActions'
import { MessageMarkdown } from './MessageMarkdown'
import {
  AssistantMessageActions,
  MessageTime,
  speechControlState,
  VariantNavigation
} from './AssistantMessageActions'
import { ContextDisclosure, hasInlineMemorySources, UnifiedContextSection } from './MessageContext'
import { useStreamViewMessage } from '../stream-view-store'
import {
  answerVersionsNavigable,
  liveAnswerVersionView,
  nextLiveVersionIndex
} from '@renderer/lib/live-answer-versions'

/** The pause before the first reaction on a message just sent: a beat, as a person takes, between
 *  one and three seconds. Fixed per message (from its id), so it never jumps on a re-render. */
function firstReactionPauseMs(messageId: string): number {
  let hash = 0
  for (const char of messageId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return 1_000 + (hash % 2_000)
}

/** One reaction. On a message just sent it waits its turn, then settles in; on an older one it is
 *  simply there. The wait is set when it first shows, so later renders never move it. */
function ReactionPill({
  emoji,
  dueAt
}: Readonly<{ emoji: string; dueAt: number }>): React.JSX.Element {
  const [delayMs] = useState(() => Math.max(0, dueAt - Date.now()))
  return (
    <span
      role="img"
      aria-label={`Reacted ${emoji}`}
      title="Reacted"
      style={delayMs > 0 ? { animationDelay: `${delayMs}ms` } : undefined}
      className="og-reaction rounded-full border border-border bg-background px-1.5 py-0.5 text-sm leading-none shadow-sm"
    >
      {emoji}
    </span>
  )
}

/** God's reactions to your message, as tapbacks sit on a message in iMessage. They only add up:
 *  each new one settles in beside the last, and none is replaced. */
function Reactions({
  emojis,
  messageId,
  sentAt
}: Readonly<{
  emojis?: readonly string[]
  messageId: string
  sentAt?: number
}>): React.JSX.Element | null {
  if (!emojis?.length) return null
  const first = (sentAt ?? 0) + firstReactionPauseMs(messageId)
  return (
    <span className="-mt-2.5 mr-2 flex gap-1 self-end">
      {emojis.map((emoji, index) => (
        // Each one after the first a moment after the one before it.
        <ReactionPill key={emoji} emoji={emoji} dueAt={first + index * 300} />
      ))}
    </span>
  )
}

function VoiceMessageRow({
  message,
  nextMessageRole,
  liveTask,
  timelineThinking,
  workFooter,
  continuation,
  navigation,
  autoPlay,
  copied,
  showTranscriptInitially,
  showGenerationDetails,
  showToolsSent,
  regenerationDisabled,
  playbackSpeed,
  onPlaybackStateChange,
  onCopy,
  onOpenAttachment,
  onOpenImage,
  onRegenerate,
  editing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onUpdateTranscript
}: Readonly<{
  message: ChatMessage
  nextMessageRole?: SyncedMessageRole
  liveTask?: TaskSession
  timelineThinking?: React.JSX.Element
  workFooter?: React.JSX.Element
  continuation?: React.JSX.Element
  navigation: ContextNavigation
  autoPlay: boolean
  copied: boolean
  showTranscriptInitially: boolean
  showGenerationDetails: boolean
  showToolsSent?: boolean
  regenerationDisabled: boolean
  playbackSpeed: number
  onPlaybackStateChange: (messageId: string, active: boolean) => void
  onCopy: (text: string, key?: string) => void
  onOpenAttachment: (attachment: StoredMessageAttachment) => void
  onOpenImage: (image: OpenImage) => void
  onRegenerate: (messageId: string) => void
  editing: boolean
  onStartEdit: (message: ChatMessage) => void
  onCancelEdit: () => void
  onSaveEdit: (messageId: string, text: string) => void
  onUpdateTranscript: (message: ChatMessage, text: string) => Promise<void>
}>): React.JSX.Element {
  const [transcribing, setTranscribing] = useState(false)
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null)
  const [openFooterDetail, setOpenFooterDetail] = useState<'tools' | 'generation' | null>(null)
  const alignment = message.role === 'user' ? 'items-end' : 'items-start'
  const reduceMotion = useReducedMotion()
  const audioUrl = useRecordedClipUrl(message)
  const reportPlayback = useCallback(
    (active: boolean) => onPlaybackStateChange(message.id, active),
    [message.id, onPlaybackStateChange]
  )
  const thinking =
    timelineThinking ??
    (message.role === 'assistant' &&
    (!message.timeline?.some((entry) => entry.kind === 'thinking') || message.reasoningLabel) &&
    (message.turnStatus !== 'cancelled' || Boolean(message.reasoning?.trim())) &&
    (message.streaming || message.reasoning?.trim() || message.reasoningRequested) ? (
      <MessageThinkingHeader message={message} timeline />
    ) : undefined)
  const isFinalAssistantResponse =
    message.role === 'assistant' &&
    !message.streaming &&
    nextMessageRole !== 'assistant' &&
    nextMessageRole !== 'tool' &&
    !isSupportingMessage(message)
  const memorySources = hasInlineMemorySources(message)
    ? {
        count: message.context.unified.length,
        content: <UnifiedContextSection items={message.context.unified} navigation={navigation} />
      }
    : undefined
  const transcribeAgain = useCallback(async (): Promise<void> => {
    if (!audioUrl || transcribing) return
    setTranscriptionError(null)
    setTranscribing(true)
    try {
      const response = await fetch(audioUrl)
      if (!response.ok) throw new Error('missing-audio')
      const bytes = new Uint8Array(await response.arrayBuffer())
      const source =
        message.attachments?.find(
          (attachment) =>
            attachment.kind === 'audio' ||
            attachmentKindFor({ fileName: attachment.name }) === 'audio'
        )?.path ?? audioUrl
      const extension = source.match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1] ?? 'webm'
      const transcript = (
        await window.api.transcribeAudio(bytes, extension, crypto.randomUUID())
      ).trim()
      if (!transcript) throw new Error('empty-transcript')
      await onUpdateTranscript(message, transcript)
    } catch (error) {
      console.error('Saved voice transcription failed:', error)
      setTranscriptionError(
        error instanceof Error && error.message === 'missing-audio'
          ? 'This voice note is not on this device.'
          : 'Transcription failed. Check the speech-to-text model in Settings > Setup & health.'
      )
    } finally {
      setTranscribing(false)
    }
  }, [audioUrl, message, onUpdateTranscript, transcribing])
  let body: React.JSX.Element
  if (message.role === 'user' && editing) {
    body = (
      <div className="w-full max-w-2xl">
        <MessageEditor
          messageId={message.id}
          initialText={message.content}
          onCancel={onCancelEdit}
          onSave={onSaveEdit}
        />
      </div>
    )
  } else if (message.role === 'user') {
    const imageAttachments = message.attachments?.filter(
      (attachment) => attachment.kind === 'image' && attachment.path
    )
    const voiceBubble = (
      <VoiceBubble
        messageId={message.id}
        isUser
        transcript={messageToSpeakable(message.content)}
        audioUrl={audioUrl}
        durationSeconds={message.audioDuration}
        synthesize={(text) => window.api.speak(text)}
        onPlaybackStateChange={reportPlayback}
        defaultSpeed={playbackSpeed}
        embedded={Boolean(imageAttachments?.length)}
      />
    )
    body = imageAttachments?.length ? (
      <div className={standardMessageBubbleClass(message, false)}>
        <div className="flex w-full flex-col gap-2">
          <MessageAttachments
            attachments={imageAttachments}
            onOpenAttachment={onOpenAttachment}
            onOpenImage={onOpenImage}
          />
          {voiceBubble}
        </div>
      </div>
    ) : (
      voiceBubble
    )
  } else if (isSupportingMessage(message)) {
    body = (
      <ChatToolRows
        thinking={
          <ChatThinkingBlock content={message.reasoning ?? ''} label={message.reasoningLabel} />
        }
      />
    )
  } else if (message.image) {
    body = (
      <>
        <ChatToolRows
          tools={message.toolCalls}
          thinking={thinking}
          thinkingHasContent={Boolean(message.reasoning?.trim())}
          thinkingText={
            timelineThinking || message.reasoningLabel ? undefined : (message.reasoning ?? '')
          }
          footer={
            workFooter ??
            (message.streaming && hasLiveStreamActivity(message) ? <LoadingDots /> : undefined)
          }
          timeline={message.timeline}
          thinkingLive={Boolean(message.streaming && !message.content)}
          memorySources={memorySources}
          liveTask={liveTask}
          live={Boolean(message.streaming || continuation)}
          settled={assistantWorkIsSettled(message)}
          stopped={message.turnStatus === 'cancelled'}
          failed={message.turnStatus === 'failed'}
        />
        <div className={standardMessageBubbleClass(message, false)}>
          <div className="flex w-full flex-col gap-2">
            <ChatImagePreview
              src={message.image}
              path={message.imagePath}
              metadata={message.imageMetadata}
              className="w-full max-w-full cursor-zoom-in rounded-md border border-neutral-800 object-contain transition-opacity hover:opacity-90"
              fill
              onOpen={onOpenImage}
            />
            <VoiceBubble
              messageId={message.id}
              transcript={messageToSpeakable(selectedMessageContent(message))}
              autoPlay={autoPlay}
              showTranscriptInitially={showTranscriptInitially}
              defaultSpeed={playbackSpeed}
              readVoice={async () => {
                const settings = await window.api.getSettings()
                return typeof settings.ttsVoice === 'string' ? settings.ttsVoice : undefined
              }}
              synthesize={(text, voice, onPass) => window.api.speak(text, voice, onPass)}
              onPlaybackStateChange={reportPlayback}
              copied={copied}
              onCopy={(text) => onCopy(text, message.id)}
              onRetry={() => onRegenerate(message.id)}
              embedded
            />
          </div>
        </div>
      </>
    )
  } else {
    body = (
      <>
        <ChatToolRows
          tools={message.toolCalls}
          thinking={thinking}
          thinkingHasContent={Boolean(message.reasoning?.trim())}
          thinkingText={
            timelineThinking || message.reasoningLabel ? undefined : (message.reasoning ?? '')
          }
          footer={
            workFooter ??
            (message.streaming && hasLiveStreamActivity(message) ? <LoadingDots /> : undefined)
          }
          timeline={message.timeline}
          thinkingLive={Boolean(message.streaming && !message.content)}
          memorySources={memorySources}
          liveTask={liveTask}
          live={Boolean(message.streaming || continuation)}
          settled={assistantWorkIsSettled(message)}
          stopped={message.turnStatus === 'cancelled'}
          failed={message.turnStatus === 'failed'}
        />
        {/* No empty player while the reply is still being written: the dots under the work say a
            reply is coming (one loader, not a second one inside the card), and the card arrives
            with its words. Cards already on screen do not animate. */}
        <AnimatePresence initial={false}>
          {message.streaming ? null : (
            <motion.div
              key="voice"
              className="flex w-full flex-col"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: reduceMotion ? 0.15 : 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <VoiceBubble
                messageId={message.id}
                transcript={messageToSpeakable(selectedMessageContent(message))}
                autoPlay={autoPlay}
                showTranscriptInitially={showTranscriptInitially}
                defaultSpeed={playbackSpeed}
                readVoice={async () => {
                  const settings = await window.api.getSettings()
                  return typeof settings.ttsVoice === 'string' ? settings.ttsVoice : undefined
                }}
                synthesize={(text, voice, onPass) => window.api.speak(text, voice, onPass)}
                onPlaybackStateChange={reportPlayback}
                copied={copied}
                onCopy={(text) => onCopy(text, message.id)}
                onRetry={() => onRegenerate(message.id)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </>
    )
  }
  return (
    <div className={`my-2 flex flex-col gap-1.5 ${alignment}`}>
      {body}
      {message.role === 'user' ? (
        <Reactions emojis={message.reactions} messageId={message.id} sentAt={message.createdAt} />
      ) : null}
      {continuation}
      {message.role === 'user' ? (
        <div className="flex items-center gap-2 pr-1">
          <MessageTime message={message} />
          {!editing ? (
            <VoiceMessageActions
              copied={copied}
              regenerationDisabled={regenerationDisabled}
              transcribing={transcribing}
              canTranscribe={Boolean(audioUrl)}
              onCopy={() => onCopy(message.content, message.id)}
              onRegenerate={() => onRegenerate(message.id)}
              onEdit={() => onStartEdit(message)}
              onTranscribe={() => void transcribeAgain()}
            />
          ) : null}
        </div>
      ) : null}
      {transcribing ? (
        <div role="status" className="text-[11px] text-neutral-500">
          <TextShimmer as="span">Transcribing...</TextShimmer>
        </div>
      ) : null}
      {transcriptionError ? (
        <div role="alert" className="max-w-[34rem] text-[11px] text-red-300">
          {transcriptionError}
        </div>
      ) : null}
      {isFinalAssistantResponse ? (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pr-1">
          {showToolsSent !== false ? (
            <ToolsSentDisclosure
              names={message.toolsOffered}
              open={openFooterDetail === 'tools'}
              onOpenChange={(open) => setOpenFooterDetail(open ? 'tools' : null)}
            />
          ) : null}
          {showGenerationDetails ? (
            <GenerationMetricsRow
              metrics={message.metrics}
              open={openFooterDetail === 'generation'}
              onOpenChange={(open) => setOpenFooterDetail(open ? 'generation' : null)}
            />
          ) : null}
          <MessageTime message={message} />
        </div>
      ) : null}
    </div>
  )
}

// Live web-task step narration, surfaced in the streaming turn (not below the browser).
// Self-contained: subscribes to the browser step feed and shows the last few notes while a
// task runs; a new running task resets it, and it renders nothing when there are no steps.
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
  const visibleAttachments = message.attachments?.filter(
    (attachment) => attachmentKindFor({ fileName: attachment.name }) !== 'audio'
  )
  return (
    <MessageContent className={messageContentClass(message, editing)}>
      {message.context?.taskGuidance ? (
        <div className="mb-2 flex items-center justify-between gap-3 border-b border-green-500/20 pb-2 text-[9px] uppercase tracking-wide text-green-600 dark:text-green-400">
          <span>Task guidance</span>
          <span>{message.context.taskGuidance.state}</span>
        </div>
      ) : null}
      {!message.image && state.incomingFiles.length ? (
        <IncomingFileRows files={state.incomingFiles} />
      ) : null}
      {visibleAttachments?.length ? (
        <MessageAttachments
          attachments={visibleAttachments}
          onOpenAttachment={actions.openAttachment}
          onOpenImage={actions.openImage}
        />
      ) : null}
      {message.image ? (
        <ChatImagePreview
          src={message.image}
          path={message.imagePath}
          metadata={message.imageMetadata}
          className="w-full max-w-full cursor-zoom-in rounded-md border border-neutral-800 object-contain transition-opacity hover:opacity-90"
          spacing="mb-2"
          fill
          onOpen={actions.openImage}
        />
      ) : null}
      {editing ? (
        <MessageEditor
          messageId={message.id}
          initialText={message.content}
          onCancel={actions.cancelEdit}
          onSave={actions.saveEdit}
        />
      ) : (
        <MessageMarkdown message={message} navigation={navigation} withoutArtifact={!!artifact} />
      )}
      <ResponseCutoffNotice cutoff={message.cutoff} />
      {message.imageMemoryRetry ? (
        <ImageMemoryRetryAction
          message={message}
          loading={state.loading}
          onRetry={actions.retryImageMemory}
        />
      ) : null}
      <ArtifactCard
        artifact={artifact}
        building={Boolean(message.streaming && artifact?.partial)}
        onOpen={(opened) => actions.openArtifact(opened, message.id)}
      />
      {ask ? (
        <AskCard
          ask={ask}
          selected={selected}
          onSelect={(option, active) => {
            actions.selectAskOption({ message, ask, option, selected: active })
          }}
          onSubmit={() => actions.submitAsk(selected)}
        />
      ) : null}
    </MessageContent>
  )
}

function StandardMessageRow({
  message,
  nextMessageRole,
  liveTask,
  timelineThinking,
  workFooter,
  continuation,
  state,
  actions,
  navigation,
  onBrowseVersion
}: Omit<MessageRowProps, 'voiceMode'> & {
  /** Set while the newest version streams: the arrows only change which version is read. */
  onBrowseVersion?: (direction: -1 | 1) => void
}): React.JSX.Element {
  const artifact = message.role === 'assistant' ? parseArtifact(message.content) : null
  const copied = state.copiedKey === message.id
  const [openFooterDetail, setOpenFooterDetail] = useState<'tools' | 'generation' | null>(null)
  const speechState = speechControlState(message.id, state.speakingId, state.speakLoadingId)
  const speechError = state.speakError?.id === message.id ? state.speakError.message : undefined
  const preparingToolCalls =
    (message.activity as { kind?: unknown } | undefined)?.kind === 'preparing_tool_calls'
  const liveActivity = activityLabel(message.activity)
  const hasTimelineThinking = message.timeline?.some((entry) => entry.kind === 'thinking') ?? false
  const shouldShowThinking =
    message.role === 'assistant' &&
    (!hasTimelineThinking || Boolean(message.reasoningLabel)) &&
    (message.turnStatus !== 'cancelled' || Boolean(message.reasoning?.trim())) &&
    Boolean(message.streaming || message.reasoning?.trim() || message.reasoningRequested)
  const thinking =
    timelineThinking ??
    (shouldShowThinking ? <MessageThinkingHeader message={message} timeline /> : undefined)
  const isFinalAssistantResponse =
    message.role === 'assistant' &&
    !message.streaming &&
    !onBrowseVersion &&
    nextMessageRole !== 'assistant' &&
    nextMessageRole !== 'tool' &&
    !isSupportingMessage(message)
  const showVersionsOnly =
    !isFinalAssistantResponse && answerVersionsNavigable(message, nextMessageRole)
  const memorySources = hasInlineMemorySources(message)
    ? {
        count: message.context.unified.length,
        content: <UnifiedContextSection items={message.context.unified} navigation={navigation} />
      }
    : undefined
  return (
    <div className={standardMessageRowClass(message)} data-testid={`chat-message-${message.id}`}>
      <ChatToolRows
        tools={message.toolCalls}
        thinking={thinking}
        thinkingHasContent={Boolean(message.reasoning?.trim())}
        thinkingText={
          timelineThinking || message.reasoningLabel ? undefined : (message.reasoning ?? '')
        }
        footer={
          workFooter ??
          (message.streaming && hasLiveStreamActivity(message) ? (
            liveActivity ? (
              // Only a labelled host thinking block still carries the activity line itself; the
              // timeline's own thinking row does not, so the footer names it.
              message.toolCalls?.length && message.reasoningLabel ? (
                <LoadingDots size="small" />
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] text-neutral-500">
                  <TextShimmer as="span">{liveActivity}</TextShimmer>
                  <LoadingDots size="small" />
                </span>
              )
            ) : (
              <LoadingDots />
            )
          ) : undefined)
        }
        timeline={message.timeline}
        thinkingLive={Boolean(message.streaming && !message.content && !preparingToolCalls)}
        memorySources={memorySources}
        liveTask={liveTask}
        live={Boolean(message.streaming || continuation)}
        settled={assistantWorkIsSettled(message)}
        stopped={message.turnStatus === 'cancelled'}
        failed={message.turnStatus === 'failed'}
      />
      <Message
        from={message.role === 'user' ? 'user' : 'assistant'}
        className={`gap-0 ${message.role === 'user' ? 'items-end' : 'items-start'} ${message.image || state.editingId === message.id ? 'w-full max-w-2xl' : 'w-fit max-w-[85%]'}`}
      >
        <MessageBubble message={message} state={state} actions={actions} navigation={navigation} />
        {message.role === 'user' ? (
          <Reactions emojis={message.reactions} messageId={message.id} sentAt={message.createdAt} />
        ) : null}
        {message.role === 'user' ? (
          <div className="mt-1.5 flex items-center justify-end gap-2 pr-1">
            <VariantNavigation
              message={message}
              noun="question"
              onSelect={(direction) => actions.selectVariant(message.id, direction)}
            />
            <MessageTime message={message} />
            {message.context?.taskGuidance ? (
              <MessageActionsMenu>
                <CopyAction
                  copied={copied}
                  onCopy={() => actions.copy(message.content, message.id)}
                />
              </MessageActionsMenu>
            ) : (
              <UserMessageActions
                copied={copied}
                regenerationDisabled={state.regenerationDisabled}
                onCopy={() => actions.copy(message.content, message.id)}
                onEdit={() => actions.startEdit(message)}
                onRegenerate={() => actions.regenerate(message.id)}
              />
            )}
          </div>
        ) : null}
      </Message>
      {continuation}
      {isFinalAssistantResponse ? (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pr-1">
          {state.showToolsSent !== false ? (
            <ToolsSentDisclosure
              names={message.toolsOffered}
              open={openFooterDetail === 'tools'}
              onOpenChange={(open) => setOpenFooterDetail(open ? 'tools' : null)}
            />
          ) : null}
          {state.showGenerationDetails ? (
            <GenerationMetricsRow
              metrics={message.metrics}
              open={openFooterDetail === 'generation'}
              onOpenChange={(open) => setOpenFooterDetail(open ? 'generation' : null)}
            />
          ) : null}
          <MessageTime message={message} />
          <AssistantMessageActions
            message={message}
            artifact={artifact}
            copied={copied}
            speechState={speechState}
            speechError={speechError}
            speechEnabled={state.ttsEnabled}
            onCopy={() => actions.copy(message.content, message.id)}
            onOpenArtifact={(opened) => actions.openArtifact(opened, message.id)}
            onRegenerate={() => actions.regenerate(message.id)}
            onSelectVariant={(direction) => actions.selectVariant(message.id, direction)}
            onSpeak={() => actions.speak(message.id, message.content)}
          />
        </div>
      ) : null}
      {showVersionsOnly ? (
        <div className="flex w-full min-w-0 items-center pr-1">
          <VariantNavigation
            message={message}
            onSelect={
              onBrowseVersion ?? ((direction) => actions.selectVariant(message.id, direction))
            }
          />
        </div>
      ) : null}
      {isFinalAssistantResponse ? (
        <ContextDisclosure
          context={memorySources ? { ...message.context, unified: [] } : message.context}
          navigation={navigation}
        />
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
function recordedClipPath(message: ChatMessage): string | undefined {
  if (message.audioUrl)
    return isCaptureUrl(message.audioUrl) ? capturePathFromUrl(message.audioUrl) : undefined
  const clip = message.attachments?.find(
    (a) => !!a.path && (a.kind === 'audio' || attachmentKindFor({ fileName: a.name }) === 'audio')
  )
  return clip?.path
}

const isCaptureUrl = (url: string): boolean => url.startsWith('ogcapture:')

/**
 * A URL the page can FETCH for the clip. The player decodes the bytes to draw the waveform (and
 * Transcribe again reads them), and a page cannot fetch ogcapture://, so every saved voice note
 * logged a blocked request and drew no waveform. The media server's http URL, as attachments use.
 */
function useRecordedClipUrl(message: ChatMessage): string | undefined {
  const path = recordedClipPath(message)
  const media = useMediaUrl(path ?? null)
  if (message.audioUrl && !isCaptureUrl(message.audioUrl)) return message.audioUrl
  if (!path) return undefined
  if (media.status === 'ready') return media.url
  // Nothing to resolve it through: the capture URL still plays, without a waveform.
  return media.status === 'missing' ? captureUrlForPath(path) : undefined
}

function MessageRowComponent({
  message,
  onStreamRender,
  journeyId,
  nextMessageRole,
  liveTask,
  timelineThinking,
  workFooter,
  continuation,
  voiceMode,
  state,
  actions,
  navigation
}: MessageRowProps): React.JSX.Element {
  const liveMessage = useStreamViewMessage(message)
  // While a new version streams, an earlier one can be read without touching the live row.
  const [viewedVersion, setViewedVersion] = useState<number | null>(null)
  const currentMessage = liveAnswerVersionView(liveMessage, viewedVersion)
  const browseLiveVersion =
    liveMessage.streaming && liveMessage.variants?.length
      ? (direction: -1 | 1): void =>
          setViewedVersion((viewed) => nextLiveVersionIndex(liveMessage, viewed, direction))
      : undefined
  useEffect(() => {
    if (currentMessage.streaming) onStreamRender?.()
  }, [currentMessage, onStreamRender])
  const journeyTask = useGuidanceTaskForJourney(currentMessage.streaming ? journeyId : null)
  const currentLiveTask = liveTask ?? journeyTask ?? undefined
  let body: React.JSX.Element
  if (currentMessage.notice) {
    body = <NoticeMessageRow message={currentMessage} />
  } else if (isPromptEnhancementMessage(currentMessage)) {
    body = <PromptEnhancementMessageRow message={currentMessage} />
  } else if (currentMessage.role === 'tool') {
    body = <ToolMessageTimelineRow messages={[currentMessage]} />
  } else if (voiceMode) {
    body = (
      <VoiceMessageRow
        message={currentMessage}
        nextMessageRole={nextMessageRole}
        liveTask={currentLiveTask}
        timelineThinking={timelineThinking}
        workFooter={workFooter}
        continuation={continuation}
        navigation={navigation}
        autoPlay={state.autoPlayId === currentMessage.id}
        copied={state.copiedKey === currentMessage.id}
        showTranscriptInitially={state.latestVoiceAssistantId === currentMessage.id}
        showGenerationDetails={state.showGenerationDetails}
        showToolsSent={state.showToolsSent}
        regenerationDisabled={state.regenerationDisabled}
        playbackSpeed={state.ttsSpeed}
        onPlaybackStateChange={actions.voicePlaybackChange}
        onCopy={actions.copy}
        onOpenAttachment={actions.openAttachment}
        onOpenImage={actions.openImage}
        onRegenerate={actions.regenerate}
        editing={state.editingId === currentMessage.id}
        onStartEdit={actions.startEdit}
        onCancelEdit={actions.cancelEdit}
        onSaveEdit={actions.saveEdit}
        onUpdateTranscript={actions.updateVoiceTranscript}
      />
    )
  } else {
    body = (
      <StandardMessageRow
        message={currentMessage}
        nextMessageRole={nextMessageRole}
        liveTask={currentLiveTask}
        timelineThinking={timelineThinking}
        workFooter={workFooter}
        continuation={continuation}
        state={state}
        actions={actions}
        navigation={navigation}
        onBrowseVersion={browseLiveVersion}
      />
    )
  }
  return body
}

function sameIncomingFiles(
  left: MessageRowState['incomingFiles'],
  right: MessageRowState['incomingFiles']
): boolean {
  return left.length === right.length && left.every((file, index) => file === right[index])
}

function sameMessageState(
  messageId: string,
  left: MessageRowState,
  right: MessageRowState
): boolean {
  return (
    (left.autoPlayId === messageId) === (right.autoPlayId === messageId) &&
    (left.copiedKey === messageId) === (right.copiedKey === messageId) &&
    (left.editingId === messageId) === (right.editingId === messageId) &&
    left.loading === right.loading &&
    (left.speakingId === messageId) === (right.speakingId === messageId) &&
    (left.speakLoadingId === messageId) === (right.speakLoadingId === messageId) &&
    (left.speakError?.id === messageId ? left.speakError.message : undefined) ===
      (right.speakError?.id === messageId ? right.speakError.message : undefined) &&
    left.ttsEnabled === right.ttsEnabled &&
    left.ttsSpeed === right.ttsSpeed &&
    (left.latestVoiceAssistantId === messageId) === (right.latestVoiceAssistantId === messageId) &&
    left.askSelections[messageId] === right.askSelections[messageId] &&
    sameIncomingFiles(left.incomingFiles, right.incomingFiles) &&
    left.showGenerationDetails === right.showGenerationDetails &&
    left.showToolsSent === right.showToolsSent &&
    left.regenerationDisabled === right.regenerationDisabled
  )
}

export const MessageRow = memo(
  MessageRowComponent,
  (left, right) =>
    left.message === right.message &&
    left.onStreamRender === right.onStreamRender &&
    left.journeyId === right.journeyId &&
    left.nextMessageRole === right.nextMessageRole &&
    left.liveTask === right.liveTask &&
    left.timelineThinking === right.timelineThinking &&
    left.workFooter === right.workFooter &&
    left.continuation === right.continuation &&
    left.voiceMode === right.voiceMode &&
    left.actions === right.actions &&
    left.navigation === right.navigation &&
    sameMessageState(left.message.id, left.state, right.state)
)

// Core (free) suggestions — generic chat/build/image. Pro adds memory-aware ones.
