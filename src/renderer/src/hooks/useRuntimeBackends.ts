import { useEffect, useState } from 'react'
import type { RuntimeBackend, RuntimeId } from '../../../shared/runtime-backends'

const unavailable = (): RuntimeBackend[] =>
  (
    [
      'chat',
      'image',
      'speech',
      'transcription',
      'embeddings',
      'grounding',
      'decision'
    ] as RuntimeId[]
  ).map((id) => ({ id, state: 'unavailable' }))

/** Only reads process-owned memory. Never starts a model or probes permissions. */
export function useRuntimeBackends(): RuntimeBackend[] {
  const [backends, setBackends] = useState<RuntimeBackend[]>(unavailable)
  useEffect(() => {
    let disposed = false
    let pending = false
    const refresh = async (): Promise<void> => {
      if (pending || disposed || document.visibilityState === 'hidden') return
      pending = true
      try {
        const snapshot = await (window.api as Partial<typeof window.api>).runtimeBackends?.()
        if (!(disposed as boolean)) setBackends(snapshot ?? unavailable())
      } catch {
        // Do not display a stale GPU claim when the main process cannot answer.
        if (!(disposed as boolean)) setBackends(unavailable())
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    const visible = (): void => {
      void refresh()
    }
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    return () => {
      disposed = true
      clearInterval(timer)
      window.removeEventListener('focus', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
  return backends
}
