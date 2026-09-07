import { createContext, useContext } from 'react'

export interface ReprocessProgress {
  phase: string
  processed: number
  total: number
}

export interface ReprocessResult {
  processed: number
  total: number
}

export interface ReprocessingContextValue {
  reprocessing: boolean
  progress: ReprocessProgress | null
  result: ReprocessResult | null
  startReprocess: (clean: boolean) => void
  clearResult: () => void
}

export const ReprocessingContext = createContext<ReprocessingContextValue | undefined>(undefined)

export function useReprocessing(): ReprocessingContextValue {
  const context = useContext(ReprocessingContext)
  if (!context) {
    throw new Error('useReprocessing must be used within a ReprocessingProvider')
  }
  return context
}
