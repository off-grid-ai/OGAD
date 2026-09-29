import { useEffect, useRef, useState } from 'react'
import {
  Play,
  Pause,
  PictureInPicture,
  CornersOut,
  CornersIn,
  SpeakerHigh,
  SpeakerSlash
} from '@phosphor-icons/react'
import {
  MediaController,
  MediaControlBar,
  MediaPlayButton,
  MediaTimeRange,
  MediaTimeDisplay,
  MediaMuteButton,
  MediaPipButton,
  MediaFullscreenButton,
  MediaPlaybackRateButton
} from 'media-chrome/react'
import * as MediaChromeElements from 'media-chrome'
import './ChatVideoPreview.css'

// Media Chrome creates shadow styles from trusted package templates. Give those
// styles Vite's nonce, as required by the same CSP that protects the renderer.
const styleNonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce
if (styleNonce) {
  for (const exported of Object.values(MediaChromeElements)) {
    const element = exported as { getTemplateHTML?: (...args: unknown[]) => string }
    if (typeof element?.getTemplateHTML !== 'function') continue
    const template = element.getTemplateHTML
    element.getTemplateHTML = function (...args) {
      return template.apply(this, args).replace(/<style>/g, `<style nonce="${styleNonce}">`)
    }
  }
}

let sessionVideo: HTMLVideoElement | null = null

export function ChatVideoPreview({
  path,
  className = ''
}: Readonly<{ path: string; className?: string }>): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    setUrl('')
    setFailed(false)
    void window.api
      .getMediaUrl(path)
      .then((next) => {
        if (active) {
          setUrl(typeof next === 'string' ? next : '')
          setFailed(typeof next !== 'string' || !next)
        }
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [path])
  useEffect(() => {
    const video = videoRef.current
    if (!video || !('mediaSession' in navigator)) return
    const session = navigator.mediaSession
    const update = (): void => {
      if (sessionVideo !== video) return
      session.playbackState = video.paused ? 'paused' : 'playing'
      if (Number.isFinite(video.duration) && video.duration > 0) {
        session.setPositionState({
          duration: video.duration,
          playbackRate: video.playbackRate,
          position: Math.min(video.currentTime, video.duration)
        })
      }
    }
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => {
        void video.play().catch(() => {})
      },
      pause: () => video.pause(),
      seekto: ({ seekTime }) => {
        if (seekTime !== undefined)
          video.currentTime = Math.max(0, Math.min(seekTime, video.duration))
        update()
      },
      seekbackward: ({ seekOffset }) => {
        video.currentTime = Math.max(0, video.currentTime - (seekOffset ?? 5))
        update()
      },
      seekforward: ({ seekOffset }) => {
        video.currentTime = Math.min(video.duration, video.currentTime + (seekOffset ?? 5))
        update()
      }
    }
    const claim = (): void => {
      // The playing/PiP video owns native controls; mounted history rows do not.
      sessionVideo = video
      for (const [action, handler] of Object.entries(handlers)) {
        try {
          session.setActionHandler(action as MediaSessionAction, handler)
        } catch {
          /* Unsupported OS action. */
        }
      }
      update()
    }
    const updates = ['pause', 'ended', 'timeupdate', 'ratechange', 'loadedmetadata']
    video.addEventListener('play', claim)
    video.addEventListener('enterpictureinpicture', claim)
    for (const event of updates) video.addEventListener(event, update)
    return () => {
      video.removeEventListener('play', claim)
      video.removeEventListener('enterpictureinpicture', claim)
      for (const event of updates) video.removeEventListener(event, update)
      if (sessionVideo === video) {
        sessionVideo = null
        for (const action of Object.keys(handlers)) {
          try {
            session.setActionHandler(action as MediaSessionAction, null)
          } catch {
            /* Unsupported OS action. */
          }
        }
        session.playbackState = 'none'
        session.setPositionState()
      }
    }
  }, [url, failed])
  return url && !failed ? (
    <MediaController
      key={url}
      className={`chat-video-player w-full overflow-hidden rounded-md border border-neutral-800 ${className}`}
    >
      <video
        ref={videoRef}
        slot="media"
        className="block h-auto w-full object-contain"
        playsInline
        preload="metadata"
        src={url}
        onError={() => setFailed(true)}
      />
      <MediaControlBar>
        <MediaPlayButton>
          <Play slot="play" />
          <Pause slot="pause" />
        </MediaPlayButton>
        <MediaTimeRange className="min-w-0 flex-1" />
        <MediaTimeDisplay showDuration />
        <MediaMuteButton>
          <SpeakerSlash slot="off" />
          <SpeakerHigh slot="low" />
          <SpeakerHigh slot="medium" />
          <SpeakerHigh slot="high" />
        </MediaMuteButton>
        <MediaPlaybackRateButton />
        <MediaPipButton>
          <PictureInPicture slot="icon" />
        </MediaPipButton>
        <MediaFullscreenButton>
          <CornersOut slot="enter" />
          <CornersIn slot="exit" />
        </MediaFullscreenButton>
      </MediaControlBar>
    </MediaController>
  ) : (
    <div
      className={`flex aspect-video items-center justify-center rounded-md border border-neutral-800 bg-black text-xs text-neutral-500 ${className}`}
    >
      {failed ? 'Video is not available on this device.' : 'Loading video…'}
    </div>
  )
}
