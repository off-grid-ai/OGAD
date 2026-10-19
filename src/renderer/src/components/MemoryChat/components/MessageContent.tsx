import { memo, useState } from 'react'
import { Paperclip, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { describeAttachment } from '@offgrid/sync'
import type { IncomingSharedFile } from '@renderer/lib/sync-hooks'
import { captureUrlForPath } from '../../../../../shared/ogcapture-url'
import { Button } from '../../ui/button'
import { LoadingDots } from '../../ui/loading-dots'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { ChatImagePreview } from './ChatImagePreview'
import type { OpenImage, StoredMessageAttachment } from '../types'

function IncomingFileRowsComponent({
  files
}: Readonly<{ files: readonly IncomingSharedFile[] }>): React.JSX.Element {
  return (
    <AnimatePresence initial={false}>
      {files.map((incoming) => (
        <motion.div
          key={`incoming-${incoming.syncId}`}
          layout
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          data-testid="incoming-shared-file"
          className="mb-2 flex w-fit items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-2 py-1"
        >
          <LoadingDots size="small" />
          <span className="max-w-[16rem] truncate text-[10px] text-neutral-400">
            {incoming.name}
          </span>
        </motion.div>
      ))}
    </AnimatePresence>
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
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {attachments.map((attachment, index) => {
        if (attachment.kind === 'image' && attachment.path) {
          const source = captureUrlForPath(attachment.path)
          return (
            <ChatImagePreview
              key={`${attachment.path}-${index}`}
              src={source}
              path={attachment.path}
              alt={attachment.name || 'Shared image'}
              // Thumbnails in a row, the way a chat shows shared screenshots: a few files stay one
              // line high, and the whole picture is one click away.
              className="size-24 cursor-zoom-in rounded-md border border-neutral-800 object-cover object-top transition-opacity hover:opacity-90"
              onOpen={(image) =>
                onOpenImage({ ...image, title: attachment.name || 'Shared image' })
              }
            />
          )
        }
        // The UI holds no opinion about what a PDF is: sync answers, this draws.
        const view = describeAttachment({
          fileName: attachment.name,
          mimeType: (attachment as { mimeType?: string }).mimeType,
          path: attachment.path,
          text: attachment.text,
          // A recorded voice note is saved as .webm; its stored kind keeps it audio.
          recordedKind: attachment.kind
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
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onSave(messageId, text)}
          className="rounded-md bg-green-600 px-3 py-1 text-xs text-white transition-colors hover:bg-green-500"
        >
          Save & submit
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Cancel"
              onClick={onCancel}
              className="border-neutral-700 text-neutral-400 hover:text-neutral-200"
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Cancel</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export const IncomingFileRows = memo(IncomingFileRowsComponent)
export const MessageAttachments = memo(MessageAttachmentsComponent)
export const MessageEditor = memo(MessageEditorComponent)
