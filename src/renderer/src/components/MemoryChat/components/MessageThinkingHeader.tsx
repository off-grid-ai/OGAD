import { memo, useEffect, useState } from 'react'
import { isPromptEnhancementReasoningLabel } from '@offgrid/sync'
import { hasLiveStreamActivity } from '@renderer/lib/stream-reducer'
import { ChatThinkingBlock } from '../../ChatThinkingBlock'
import { ChatToolRows } from '../../ChatToolRows'
import { LoadingDots } from '../../ui/loading-dots'
import type { ChatMessage } from '../types'
import { activityLabel, isSupportingMessage } from '../utlis'

function WebTaskStepFeed(): React.JSX.Element | null {
  console.log('MemoryChat WebTaskStepFeed rendered')
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

/** The main process rethrows the real reason; Electron wraps it as "Error invoking remote method". */
function MessageThinkingHeaderComponent({
  message,
  timeline = false
}: Readonly<{ message: ChatMessage; timeline?: boolean }>): React.JSX.Element {
  console.log('MemoryChat MessageThinkingHeader rendered')
  if (message.role !== 'assistant') return <></>
  if (message.streaming) {
    const activity = activityLabel(message.activity)
    const showLiveActivity = hasLiveStreamActivity(message)
    return (
      <div className="mb-1.5 flex flex-col gap-1.5">
        {showLiveActivity && !timeline ? <LoadingDots /> : null}
        {message.reasoning?.trim() ? (
          <ChatThinkingBlock
            content={message.reasoning ?? ''}
            live
            className={timeline ? 'max-w-full' : undefined}
          />
        ) : null}
        {showLiveActivity && activity ? (
          <span className="text-[11px] text-neutral-500">{activity}</span>
        ) : null}
        {showLiveActivity ? <WebTaskStepFeed /> : null}
      </div>
    )
  }
  const reasoning = message.reasoning?.trim()
  if (!reasoning && message.turnStatus === 'cancelled') return <></>
  if (!reasoning && !message.reasoningRequested) return <></>
  const readableContent = reasoning || THINKING_UNAVAILABLE_TEXT
  const supporting = isSupportingMessage(message)
  if (supporting && !timeline && isPromptEnhancementReasoningLabel(message.reasoningLabel)) {
    return (
      <ChatToolRows
        thinking={<ChatThinkingBlock content={readableContent} label={message.reasoningLabel} />}
      />
    )
  }
  return (
    <div
      className={
        supporting && !timeline
          ? // The same box a tool row uses. This pill sits BETWEEN tool rows in a tool-calling turn,
          // and at px-3.5/py-2.5 it was visibly fatter than the rows either side of it, so a
          // sequence of reasoning and calls read as two competing shapes rather than one list.
          'rounded-sm border border-neutral-800 bg-neutral-900/40 px-2 py-1'
          : 'mb-1'
      }
      data-testid={supporting ? 'supporting-context-bubble' : undefined}
    >
      <ChatThinkingBlock
        content={readableContent}
        label={reasoning ? message.reasoningLabel : 'Thinking unavailable'}
        className={timeline ? 'max-w-full' : undefined}
      />
    </div>
  )
}

const THINKING_UNAVAILABLE_TEXT =
  'This model did not return readable thinking details for this turn.'

export const MessageThinkingHeader = memo(MessageThinkingHeaderComponent)
