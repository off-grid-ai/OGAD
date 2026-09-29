import { useEffect, useState } from 'react'
import { GridBackdrop } from '../ui/grid-backdrop'
import { PerformancePackPanel } from './PerformancePackPanel'
import type { PerformancePackStatus } from '../../../../shared/performance-pack'

const SKIPPED_KEY = 'performance_pack_intro_complete'

export function PerformancePackGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const [status, setStatus] = useState<PerformancePackStatus | null>(null)
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(SKIPPED_KEY) === 'true')

  useEffect(() => {
    const pack = window.api.performancePack
    if (typeof pack?.status !== 'function') return
    void pack.status().then(setStatus).catch(() => setStatus({
      phase: 'unavailable', bytes: 0, downloadedBytes: 0
    }))
  }, [])

  if (!status) return <>{children}</>
  if (dismissed || !['available', 'paused', 'downloading', 'failed'].includes(status.phase)) {
    return <>{children}</>
  }

  const dismiss = (): void => {
    localStorage.setItem(SKIPPED_KEY, 'true')
    setDismissed(true)
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-neutral-950 p-6">
      <GridBackdrop className="z-0" />
      <div className="relative z-10 w-full max-w-xl">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-green-500">Optional setup</p>
        <PerformancePackPanel onSkip={dismiss} />
      </div>
    </div>
  )
}
