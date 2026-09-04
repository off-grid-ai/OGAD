/**
 * What a turn carries besides text: generated-image previews and their metadata, attached files,
 * the files a peer has announced but not yet sent, and the document/audio panes one opens into.
 */
import { describeAttachment } from '@offgrid/application'
import { type IncomingSharedFile } from '@renderer/lib/sync-hooks'
import { LoadingDots } from './ui/loading-dots'
import { type ImageGenerationMetadata } from '@renderer/lib/chat-transcript-types'
import { captureUrlForPath } from '../../../shared/ogcapture-url'
import { Paperclip } from '@phosphor-icons/react'
import { type OpenImage, type StoredMessageAttachment } from './chat-message-projection'

function ImageMetadata({
  metadata
}: Readonly<{
  metadata?: ImageGenerationMetadata
}>): React.JSX.Element | null {
  if (!metadata) return null
  return (
    <p aria-label="Image generation metadata" className="mt-1.5 text-[10px] text-neutral-600">
      {metadata.width} × {metadata.height} · {metadata.steps} steps · CFG {metadata.cfgScale} · seed{' '}
      {metadata.seed}
      {metadata.model ? ` · ${metadata.model}` : ''}
    </p>
  )
}

export function ChatImagePreview({
  src,
  path,
  alt = 'Generated',
  metadata,
  className,
  fill = false,
  onOpen
}: Readonly<{
  src: string
  path?: string
  alt?: string
  metadata?: ImageGenerationMetadata
  className: string
  /** Widen the box to its container, for a picture whose own width is meant to fill it. Off by
   *  default: a preview with its own max-width would otherwise get a click target spanning the
   *  whole bubble, so clicking the empty space beside it would open the viewer. */
  fill?: boolean
  onOpen: (image: { url: string; path?: string }) => void
}>): React.JSX.Element {
  return (
    <div className={fill ? 'w-full' : undefined}>
      <button
        type="button"
        aria-label={`Open ${alt}`}
        onClick={() => onOpen({ url: src, path })}
        className={fill ? 'block w-full max-w-full' : 'block max-w-full'}
      >
        <img src={src} alt={alt} className={className} />
      </button>
      <ImageMetadata metadata={metadata} />
    </div>
  )
}

export function IncomingFileRows({
  files
}: Readonly<{ files: readonly IncomingSharedFile[] }>): React.JSX.Element {
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

export function MessageAttachments({
  attachments,
  onOpenAttachment,
  onOpenImage
}: Readonly<{
  attachments: readonly StoredMessageAttachment[]
  onOpenAttachment: (attachment: StoredMessageAttachment) => void
  onOpenImage: (image: OpenImage) => void
}>): React.JSX.Element {
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
export function DocumentPane({ path, title }: { path: string; title: string }): React.JSX.Element {
  // The SAME transport images use. The loopback media server already serves `uploads` (see
  // media-roots.ts) with canonicalisation and root admission, and captureUrlForPath is how every
  // other local file reaches the renderer.
  //
  // The first attempt used a data: URL from files:data-url and drew a blank page: frame-src did not
  // allow data:, so Chromium blocked the frame silently. Reusing the media origin keeps one file
  // path for all local media instead of adding a second, weaker one to the CSP.
  const src = captureUrlForPath(path)
  if (!src) {
    return (
      <div className="w-full max-w-3xl rounded-md border border-neutral-800 bg-neutral-950 p-5 text-sm text-neutral-400">
        This file could not be opened. Its bytes are not on this device.
      </div>
    )
  }
  return (
    <iframe
      src={src}
      title={title}
      className="h-full max-h-full w-full max-w-3xl rounded-md border border-neutral-800 bg-neutral-950"
    />
  )
}

/**
 * A voice note, played rather than looked at.
 *
 * attachment-kind already answers `renderer: 'audio'`; the viewer simply had no branch for it, so a
 * .wav fell through to the text pane and drew an empty page - a note that HAD synced looked like a
 * note that had not. Same media-origin transport as images and documents, so there is one way local
 * bytes reach the renderer.
 */
export function AudioPane({ path, title }: { path: string; title: string }): React.JSX.Element {
  const src = captureUrlForPath(path)
  if (!src) {
    return (
      <div className="w-full max-w-3xl rounded-md border border-neutral-800 bg-neutral-950 p-5 text-sm text-neutral-400">
        This voice note could not be played. Its bytes are not on this device.
      </div>
    )
  }
  return (
    <div className="w-full max-w-3xl rounded-md border border-neutral-800 bg-neutral-950 p-5">
      <div className="mb-3 truncate text-xs text-neutral-400">{title}</div>
      <audio src={src} controls autoPlay className="w-full" />
    </div>
  )
}

