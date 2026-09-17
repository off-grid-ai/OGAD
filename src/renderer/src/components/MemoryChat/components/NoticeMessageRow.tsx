import { memo } from 'react'
import type { ChatMessage } from '../types'
import { noticeText } from '../utlis'

export const NoticeMessageRow = memo(function NoticeMessageRow({
  message
}: Readonly<{ message: ChatMessage }>): React.JSX.Element {
  console.log('MemoryChat NoticeMessageRow rendered')
  const text = noticeText(message.content)
  if (text === 'Compacted') {
    return (
      <div className="mb-2 flex items-start" aria-live="polite">
        <span className="rounded-sm border border-neutral-800 px-2.5 py-2 text-[11px] text-neutral-500">
          Compacted conversation to make room for more messages.
        </span>
      </div>
    )
  }
  return (
    <div className="mb-4 flex justify-center">
      <span className="px-3 text-center text-[11px] leading-relaxed text-neutral-500">{text}</span>
    </div>
  )
})
