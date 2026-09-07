import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { IconActivityHeartbeat } from '@tabler/icons-react'
import { useReprocessing } from '../hooks/reprocessing-context'
import { cn } from '../lib/utils'

export function ReprocessingBanner(): React.ReactElement | null {
  const { reprocessing, progress } = useReprocessing()
  if (!reprocessing) return null
  const pct =
    progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="bg-neutral-900/90 backdrop-blur-sm border-b border-neutral-800 px-4 py-2 flex items-center gap-3"
    >
      <motion.div
        className="w-3.5 h-3.5 border-2 border-neutral-400 border-t-transparent rounded-full shrink-0"
        animate={{ rotate: 360 }}
        transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
      />
      <span className="text-sm text-neutral-400 flex-1 min-w-0 truncate">
        {progress?.phase === 'cleared'
          ? 'Data cleared. Rebuilding memories and entities...'
          : progress
            ? `Reprocessing session ${progress.processed} of ${progress.total}...`
            : 'Reprocessing sessions...'}
      </span>
      {progress && progress.total > 0 ? (
        <div className="w-24 h-1.5 bg-neutral-800 rounded-full overflow-hidden shrink-0">
          <motion.div
            className="h-full bg-neutral-500 rounded-full"
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
      ) : null}
      {progress && progress.total > 0 ? (
        <span className="text-xs text-neutral-600 shrink-0">{pct}%</span>
      ) : null}
    </motion.div>
  )
}

const navRowClass = (expanded: boolean): string =>
  cn(
    'group/nav relative flex items-center gap-3 rounded-lg py-2 text-sm transition-colors',
    expanded ? 'px-3' : 'justify-center px-0',
    'text-neutral-400 hover:bg-neutral-500/10 hover:text-white'
  )

type ChatHealth = 'ready' | 'starting' | 'down' | null

export function ModelStatusDot({
  open,
  onClick
}: {
  open: boolean
  onClick: () => void
}): React.ReactElement {
  const [status, setStatus] = useState<ChatHealth>(null)
  useEffect(() => {
    let live = true
    let refreshInFlight: Promise<void> | null = null
    const api = window.api
    const applyHealth = (chat: { status?: string } | null | undefined): void => {
      const next: ChatHealth =
        chat?.status === 'ready' ? 'ready' : chat?.status === 'starting' ? 'starting' : 'down'
      if (live) setStatus(next)
    }
    const refresh = (): void => {
      if (refreshInFlight !== null) return
      refreshInFlight = Promise.resolve(api.chatHealth())
        .then(applyHealth)
        .catch(() => {
          if (live) setStatus('down')
        })
        .finally(() => {
          refreshInFlight = null
        })
    }
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    const offChanged = api.onChatHealthChanged(applyHealth)
    refresh()
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const id = setInterval(refreshWhenVisible, 60_000)
    return () => {
      live = false
      clearInterval(id)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      try {
        offChanged()
      } catch {
        // The preload subscription is already closed.
      }
    }
  }, [])
  const color =
    status == null
      ? 'text-neutral-500'
      : status === 'ready'
        ? 'text-green-500'
        : status === 'starting'
          ? 'text-amber-500'
          : 'text-red-500'
  const text =
    status == null
      ? 'Checking…'
      : status === 'ready'
        ? 'Model running'
        : status === 'starting'
          ? 'Model starting'
          : 'Model stopped'
  const label =
    status === 'down'
      ? 'Model server stopped. Open Setup and health.'
      : `Model server: ${text.toLowerCase()}. Open Setup and health.`
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={navRowClass(open)}
    >
      <IconActivityHeartbeat className={cn('h-5 w-5 shrink-0', color)} />
      {open ? <span className="flex-1 text-left text-xs">{text}</span> : null}
    </button>
  )
}
