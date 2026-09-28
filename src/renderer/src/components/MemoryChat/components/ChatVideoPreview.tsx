import { useEffect, useState } from 'react'

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
  return url ? (
    <video className={`aspect-video w-full rounded-md border border-neutral-800 bg-black ${className}`} controls preload="metadata" src={url} />
  ) : (
    <div className={`flex aspect-video items-center justify-center rounded-md border border-neutral-800 bg-black text-xs text-neutral-500 ${className}`}>{failed ? 'Video is not available on this device.' : 'Loading video…'}</div>
  )
}
