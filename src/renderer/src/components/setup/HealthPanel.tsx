import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CheckCircle,
  CircleNotch,
  WarningCircle,
  Circle,
  ArrowsClockwise
} from '@phosphor-icons/react'
import { cn } from '@renderer/lib/utils'
import {
  SYSTEM_HEALTH_STATUS_LABELS,
  type SystemHealthComponentStatusContract,
  type SystemHealthContract
} from '../../../../shared/ipc-contracts'

// Emerald is the only accent (DESIGN): healthy = emerald, everything else reads
// through opacity tiers + icon shape, never a status color palette.
const STATUS_TEXT: Record<SystemHealthComponentStatusContract, string> = {
  ready: 'text-green-500',
  starting: 'text-neutral-400',
  down: 'text-neutral-300',
  not_installed: 'text-neutral-500',
  installed: 'text-neutral-300',
  granted: 'text-green-500',
  denied: 'text-neutral-300'
}

function StatusIcon({
  status
}: {
  status: SystemHealthComponentStatusContract
}): React.ReactElement {
  if (status === 'ready' || status === 'granted')
    return <CheckCircle weight="fill" className="h-4 w-4 text-green-500" />
  if (status === 'starting')
    return <CircleNotch className="h-4 w-4 animate-spin text-neutral-400" />
  if (status === 'down' || status === 'denied')
    return <WarningCircle weight="fill" className="h-4 w-4 text-neutral-300" />
  return <Circle className="h-4 w-4 text-neutral-600" />
}

/**
 * Live status of every local component.
 *
 * Full health reads inspect native permissions and local services. They are therefore demand-driven:
 * opening or returning to this panel reads once, lifecycle events invalidate it, and user actions
 * refresh it after they finish. A timer here made an idle app repeat the full native probe forever.
 */
export function HealthPanel(): React.ReactElement {
  const api = window.api
  const [health, setHealth] = useState<SystemHealthContract | null>(null)
  const [restarting, setRestarting] = useState<string | null>(null)
  const [freeing, setFreeing] = useState(false)
  const [freeMsg, setFreeMsg] = useState<string | null>(null)
  const activeRefresh = useRef<Promise<void> | null>(null)

  const refresh = useCallback((): Promise<void> => {
    if (activeRefresh.current) return activeRefresh.current
    const request = api
      .systemHealth()
      .then(setHealth)
      .catch(() => {
        /* ignore — keep last snapshot */
      })
      .finally(() => {
        if (activeRefresh.current === request) activeRefresh.current = null
      })
    activeRefresh.current = request
    return request
  }, [api])

  useEffect(() => {
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    void refresh()
    const stopChatHealth = api.onChatHealthChanged(() => void refresh())
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      if (typeof stopChatHealth === 'function') stopChatHealth()
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [refresh])

  const restart = async (id: string): Promise<void> => {
    setRestarting(id)
    try {
      await api.restartComponent(id)
      await refresh()
    } finally {
      setRestarting(null)
    }
  }

  // Stop the chat engine and free its port (for LM Studio / another tool) without quitting the app.
  const freeEngine = async (): Promise<void> => {
    setFreeing(true)
    setFreeMsg(null)
    try {
      const r = await api.unloadLlmEngine()
      setFreeMsg(
        r.portFree
          ? 'Chat engine stopped - port freed.'
          : "Chat engine stopped, but the port is still held (another app may own it, or it's wedged)."
      )
      await refresh()
    } catch {
      setFreeMsg('Could not stop the engine.')
    } finally {
      setFreeing(false)
    }
  }

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 font-mono">
      <div className="flex items-center justify-between border-b border-neutral-800/60 px-4 py-3">
        <div className="text-[10px] font-medium uppercase tracking-widest text-neutral-500">
          System health
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void freeEngine()}
            disabled={freeing}
            title="Stop the chat engine and free its model port (for LM Studio or another tool) without quitting the app"
            className="text-[11px] text-neutral-500 transition-colors hover:text-white active:scale-95 disabled:opacity-50"
          >
            {freeing ? 'Freeing...' : 'Free engine'}
          </button>
          <button
            onClick={refresh}
            className="flex items-center gap-1.5 text-[11px] text-neutral-500 transition-colors hover:text-white"
          >
            <ArrowsClockwise className="h-3 w-3" />
            Refresh
          </button>
        </div>
      </div>

      {!health ? (
        <div className="px-4 py-6 text-center text-xs text-neutral-600">Checking components…</div>
      ) : (
        <div className="grid grid-cols-1 gap-1.5 p-3 sm:grid-cols-2 lg:grid-cols-3">
          {health.components.map((c) => {
            const canRestart = c.canRestart && (c.status === 'down' || c.status === 'ready')
            return (
              <div
                key={c.id}
                role="status"
                aria-label={c.label}
                className="group flex items-center gap-2.5 rounded border border-neutral-800/60 bg-neutral-900/30 px-2.5 py-2 transition-colors duration-150 hover:border-neutral-700"
              >
                <StatusIcon status={c.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[11px] text-neutral-200">{c.label}</div>
                  {c.detail && (
                    <div className="truncate text-[10px] text-neutral-600">{c.detail}</div>
                  )}
                </div>
                {c.port && (
                  <span className="shrink-0 font-mono text-[9px] text-neutral-600">:{c.port}</span>
                )}
                <span className={cn('shrink-0 text-[10px]', STATUS_TEXT[c.status])}>
                  {SYSTEM_HEALTH_STATUS_LABELS[c.status]}
                </span>
                {canRestart && (
                  <button
                    onClick={() => restart(c.id)}
                    disabled={restarting === c.id}
                    className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-[9px] leading-4 text-neutral-300 transition-all duration-150 hover:border-green-500/60 hover:text-white active:scale-95 disabled:opacity-50"
                  >
                    {restarting === c.id ? '…' : 'Restart'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {freeMsg && (
        <div
          role="status"
          className="border-t border-neutral-800/60 px-4 py-2 text-[10px] text-neutral-400"
        >
          {freeMsg}
        </div>
      )}

      {health && (
        <div className="border-t border-neutral-800/60 px-4 py-2 text-[10px] text-neutral-600">
          {health.ramGb} GB RAM{health.activeModel ? ` · active: ${health.activeModel}` : ''}
        </div>
      )}
    </div>
  )
}
