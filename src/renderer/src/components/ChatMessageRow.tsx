/**
 * One rendered chat message.
 *
 * Lifted out of `MemoryChat` so the chat root no longer owns how a turn looks. A row renders the
 * projection it is handed and emits intent; it holds no chat policy and no persistence, and the
 * only state inside it is the editor's own draft.
 */
import { useCallback, useEffect, useState } from 'react'
import { useActiveTurn } from '@renderer/hooks/useActiveTurn'
import { hasLiveStreamActivity } from '@renderer/lib/stream-reducer'
import { type WorkRunStep } from '@offgrid/application'
import { ChatLoadingCard } from './ChatLoadingCard'
import { ChatThinkingBlock } from './ChatThinkingBlock'
import { ChatToolRows } from './ChatToolRows'
import { parseArtifact } from '@renderer/lib/artifact-parser'
import { VoiceBubble } from './VoiceBubble'
import { LoadingDots } from './ui/loading-dots'
import { type ChatMessage } from '@renderer/lib/chat-transcript-types'
import { ArtifactCard, AskCard, AssistantMessageActions, CopyAction, GenerationMetricsRow, ImageMemoryRetryAction, ResponseCutoffNotice, UserMessageActions } from './ChatMessageActions'
import { ChatImagePreview, IncomingFileRows, MessageAttachments } from './ChatMessageAttachments'
import { ContextDisclosure } from './ChatMessageContext'
import { MessageMarkdown } from './ChatMessageMarkdown'
import { activityLabel, isPromptEnhancementMessage, isSupportingMessage, messageToSpeakable, noticeText, parseAsk, recordedClipUrl, selectedMessageContent, speechControlState, standardMessageBubbleClass, standardMessageRowClass, type ContextNavigation, type MessageRowActions, type MessageRowProps, type MessageRowState, type OpenImage } from './chat-message-projection'

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

export function ToolMessageTimelineRow({
  steps
}: Readonly<{ steps: WorkRunStep<ChatMessage>[] }>): React.JSX.Element {
  return (
    <div
      className="mb-2 flex flex-col items-start"
      data-testid={`chat-tool-timeline-${steps[0]?.tool.id ?? 'unknown'}`}
    >
      <ChatToolRows
        tools={steps.map(({ tool: message, reasoning }) => ({
          name: message.toolName || 'Tool result',
          result: message.content,
          status: message.turnStatus === 'failed' ? 'failed' : 'completed',
          ...(reasoning ? { reasoning } : {}),
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
  copied,
  showTranscriptInitially,
  playbackSpeed,
  onPlaybackStateChange,
  onCopy,
  onOpenImage,
  onRegenerate
}: Readonly<{
  message: ChatMessage
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
        onPlaybackStateChange={reportPlayback}
        copied={copied}
        onCopy={(text) => onCopy(text, message.id)}
        onRetry={() => onRegenerate(message.id)}
        defaultSpeed={playbackSpeed}
      />
    )
  } else if (isSupportingMessage(message)) {
    body = <ChatThinkingBlock content={message.reasoning ?? ''} label={message.reasoningLabel} />
  } else if (message.image) {
    body = (
      <>
        <MessageThinkingHeader message={message} />
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
        <MessageThinkingHeader message={message} />
        <VoiceBubble
          messageId={message.id}
          transcript={messageToSpeakable(selectedMessageContent(message))}
          isLoading={Boolean(message.streaming)}
          showTranscriptInitially={showTranscriptInitially}
          defaultSpeed={playbackSpeed}
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
    const offStep = window.api.browser?.onStep((e) => {
      const note = (e as { note?: string }).note
      if (typeof note === 'string') {
        setSteps((prev) => [...prev, note])
      }
    })
    const offState = window.api.browser?.onTaskState((e) => {
      if ((e as { status?: string }).status === 'running') {
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

/** The main process rethrows the real reason; Electron wraps it as "Error invoking remote method". */
function MessageThinkingHeader({ message }: Readonly<{ message: ChatMessage }>): React.JSX.Element {
  if (message.role !== 'assistant') return <></>
  if (message.streaming) {
    const activity = activityLabel(message.activity)
    const showLiveActivity = hasLiveStreamActivity(message)
    return (
      <div className="mb-1.5 flex flex-col gap-1.5">
        {showLiveActivity ? <LoadingDots /> : null}
        {message.reasoningRequested || message.reasoning?.trim() ? (
          <ChatThinkingBlock content={message.reasoning ?? ''} live />
        ) : null}
        {showLiveActivity && activity ? (
          <span className="text-[11px] text-neutral-500">{activity}</span>
        ) : null}
        {showLiveActivity ? <WebTaskStepFeed /> : null}
      </div>
    )
  }
  const reasoning = message.reasoning?.trim()
  if (!reasoning && !message.reasoningRequested) return <></>
  const readableContent =
    reasoning || 'This model did not return readable thinking details for this turn.'
  const supporting = isSupportingMessage(message)
  return (
    <div
      // One look for a thought process wherever it sits: the bare toggle, no frame. A reasoning
      // row between tool rounds now travels inside the work timeline; one left over here is the
      // same thing as the one above an answer.
      className="mb-1"
      data-testid={supporting ? 'supporting-context-bubble' : undefined}
    >
      <ChatThinkingBlock
        content={readableContent}
        label={reasoning ? message.reasoningLabel : 'Thinking unavailable'}
      />
    </div>
  )
}

function MessageEditor({
  messageId,
  initialText,
  onCancel,
  onSave
}: Readonly<{
  messageId: string
  initialText: string
  onCancel: () => void
  onSave: (messageId: string, text: string) => void
}>): React.JSX.Element {
  const [text, setText] = useState(initialText)
  return (
    <div className="flex flex-col gap-2">
      <textarea
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onSave(messageId, text)
          }
          if (event.key === 'Escape') onCancel()
        }}
        rows={Math.min(10, text.split('\n').length + 1)}
        className="w-full resize-none rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-green-500"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onSave(messageId, text)}
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

/** A seed is a number; anything else typed into the field is dropped as it is typed. */
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
      {message.persistenceWarning ? (
        <p role="alert" className="mb-2 text-xs text-amber-500">
          {message.persistenceWarning}
        </p>
      ) : null}
      {editing ? (
        <MessageEditor
          messageId={message.id}
          initialText={message.content}
          onCancel={actions.cancelEdit}
          onSave={actions.saveEdit}
        />
      ) : (
        <MessageMarkdown message={message} navigation={navigation} />
      )}
      <ResponseCutoffNotice cutoff={message.cutoff} />
      {state.showGenerationDetails ? <GenerationMetricsRow metrics={message.metrics} /> : null}
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
  liveTask,
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
      <ChatToolRows tools={message.toolCalls} liveTask={liveTask} />
      {message.role === 'user' ? (
        message.context?.taskGuidance ? (
          <div className="mt-1.5 flex items-center gap-3">
            <CopyAction copied={copied} onCopy={() => actions.copy(message.content, message.id)} />
          </div>
        ) : (
          <UserMessageActions
            copied={copied}
            regenerationDisabled={state.regenerationDisabled}
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
/**
 * The row for a turn, live or committed.
 *
 * This shell is the ONLY subscriber to a generating turn: its text, reasoning, tool calls and
 * activity come from the session's active-turn projection rather than from the transcript, so a
 * token wakes this leaf and nothing above it. A committed row passes `null`, subscribes to
 * nothing, and keeps the object identity the transcript gave it.
 */
export function MessageRow(props: MessageRowProps): React.JSX.Element {
  const live = useActiveTurn(props.message.streaming ? props.message.id : null)
  const message = live ? { ...props.message, ...live } : props.message
  return <MessageRowBody {...props} message={message} />
}

function MessageRowBody({
  message,
  liveTask,
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
    body = <ToolMessageTimelineRow steps={[{ tool: message }]} />
  } else if (voiceMode) {
    body = (
      <VoiceMessageRow
        message={message}
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
        liveTask={liveTask}
        state={state}
        actions={actions}
        navigation={navigation}
      />
    )
  }
  return body
}

// Core (free) suggestions — generic chat/build/image. Pro adds memory-aware ones.
