import { memo } from 'react'
import { captureUrlForPath } from '../../../../../shared/ogcapture-url'

function DocumentPaneComponent({ path, title }: { path: string; title: string }): React.JSX.Element {
  console.log('MemoryChat DocumentPane rendered')
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
function AudioPaneComponent({ path, title }: { path: string; title: string }): React.JSX.Element {
  console.log('MemoryChat AudioPane rendered')
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

export const DocumentPane = memo(DocumentPaneComponent)
export const AudioPane = memo(AudioPaneComponent)
