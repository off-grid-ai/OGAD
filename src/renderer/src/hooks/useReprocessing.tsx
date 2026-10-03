import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'

interface ReprocessProgress {
  phase: string
  processed: number
  total: number
}

interface ReprocessResult {
  processed: number
  total: number
}

interface ReprocessingContextType {
  reprocessing: boolean
  progress: ReprocessProgress | null
  result: ReprocessResult | null
  startReprocess: (clean: boolean) => void
  clearResult: () => void
}

const ReprocessingContext = createContext<ReprocessingContextType | undefined>(undefined)

export function ReprocessingProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [reprocessing, setReprocessing] = useState(false)
  const [progress, setProgress] = useState<ReprocessProgress | null>(null)
  const [result, setResult] = useState<ReprocessResult | null>(null)

  // Listen for progress events from the main process
  useEffect(() => {
    const unsub = window.api.onReprocessProgress((data) => {
      setProgress(data)
    })
    return unsub
  }, [])

  const clearResult = useCallback(() => setResult(null), [])

  const startReprocess = useCallback(
    async (clean: boolean) => {
      if (reprocessing) return
      setReprocessing(true)
      setResult(null)
      setProgress(null)
      try {
        const res = await window.api.reprocessAllSessions(clean)
        setResult(res)
      } catch (e) {
        console.error('Reprocess failed:', e)
      } finally {
        setReprocessing(false)
        setProgress(null)
      }
    },
    [reprocessing]
  )

  return (
    <ReprocessingContext.Provider
      value={{ reprocessing, progress, result, startReprocess, clearResult }}
    >
      {children}
    </ReprocessingContext.Provider>
  )
}

export function useReprocessing(): ReprocessingContextType {
  const context = useContext(ReprocessingContext)
  if (!context) {
    throw new Error('useReprocessing must be used within a ReprocessingProvider')
  }
  return context
}
