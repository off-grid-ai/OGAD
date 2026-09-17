import { memo } from 'react'
import { ChatToolRows } from '../../ChatToolRows'
import type { ChatMessage } from '../types'

export const ToolMessageTimelineRow = memo(function ToolMessageTimelineRow({
  messages
}: Readonly<{ messages: ChatMessage[] }>): React.JSX.Element {
  console.log('MemoryChat ToolMessageTimelineRow rendered')
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
})
