import { memo, useState } from 'react'
import { Paperclip } from '@phosphor-icons/react'
import { describeAttachment } from '@offgrid/sync'
import type { IncomingSharedFile } from '@renderer/lib/sync-hooks'
import { captureUrlForPath } from '../../../../../shared/ogcapture-url'
import { LoadingDots } from '../../ui/loading-dots'
import { ChatImagePreview } from './ChatImagePreview'
import type { OpenImage, StoredMessageAttachment } from '../types'

function IncomingFileRowsComponent({
  files
}: Readonly<{ files: readonly IncomingSharedFile[] }>): React.JSX.Element {
  console.log('MemoryChat IncomingFileRows rendered')
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

function MessageAttachmentsComponent({
  attachments,
  onOpenAttachment,
  onOpenImage
}: Readonly<{
  attachments: readonly StoredMessageAttachment[]
  onOpenAttachment: (attachment: StoredMessageAttachment) => void
  onOpenImage: (image: OpenImage) => void
}>): React.JSX.Element {
  console.log('MemoryChat MessageAttachments rendered')
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

/**
 * The editor for one sent message.
 *
 * The text being edited used to live in the chat screen, so every character re-rendered every
 * message in the transcript. It lives here instead: the screen is told the message and gets the
 * text back once, when the user saves.
 */
function MessageEditorComponent({
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
  console.log('MemoryChat MessageEditor rendered')
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
        rows={Math.min(10, Math.max(5, text.split('\n').length + 1))}
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

export const IncomingFileRows = memo(IncomingFileRowsComponent)
export const MessageAttachments = memo(MessageAttachmentsComponent)
export const MessageEditor = memo(MessageEditorComponent)
