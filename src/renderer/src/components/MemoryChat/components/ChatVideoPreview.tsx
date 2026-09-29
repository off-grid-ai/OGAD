import { useEffect, useState } from 'react'
import { Play, Pause, PictureInPicture, CornersOut, CornersIn, SpeakerHigh, SpeakerSlash } from '@phosphor-icons/react'
import { MediaController, MediaControlBar, MediaPlayButton, MediaTimeRange, MediaTimeDisplay, MediaMuteButton, MediaPipButton, MediaFullscreenButton, MediaPlaybackRateButton } from 'media-chrome/react'
import './ChatVideoPreview.css'

export function ChatVideoPreview({ path, className = '' }: Readonly<{ path: string; className?: string }>): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    setUrl('')
    setFailed(false)
    void window.api.getMediaUrl(path).then((next) => {
      if (active) {
        setUrl(typeof next === 'string' ? next : '')
        setFailed(typeof next !== 'string' || !next)
      }
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [path])
  return url && !failed ? (
    <MediaController key={url} className={`chat-video-player w-full overflow-hidden rounded-md border border-neutral-800 ${className}`}>
      <video slot="media" className="block h-auto w-full object-contain" playsInline preload="metadata" src={url} onError={() => setFailed(true)} />
      <MediaControlBar>
        <MediaPlayButton><Play slot="play" /><Pause slot="pause" /></MediaPlayButton>
        <MediaTimeRange className="min-w-0 flex-1" />
        <MediaTimeDisplay showDuration />
        <MediaMuteButton><SpeakerSlash slot="off" /><SpeakerHigh slot="low" /><SpeakerHigh slot="medium" /><SpeakerHigh slot="high" /></MediaMuteButton>
        <MediaPlaybackRateButton />
        <MediaPipButton><PictureInPicture slot="icon" /></MediaPipButton>
        <MediaFullscreenButton><CornersOut slot="enter" /><CornersIn slot="exit" /></MediaFullscreenButton>
      </MediaControlBar>
    </MediaController>
  ) : (
    <div className={`flex aspect-video items-center justify-center rounded-md border border-neutral-800 bg-black text-xs text-neutral-500 ${className}`}>{failed ? 'Video is not available on this device.' : 'Loading video…'}</div>
  )
}
