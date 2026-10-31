import { createContext, useContext } from 'react'

interface ToastRequest {
  message: string
  tone?: 'success' | 'error' | 'neutral'
  /** An error toast's fixed code (`[a-z0-9_]`), for opt-in usage counts. Never its message. */
  code?: string
  actionLabel?: string
  onAction?: () => void
  durationMs?: number
}

export interface ToastContextType {
  showToast: (toast: ToastRequest) => void
}

export const ToastContext = createContext<ToastContextType | undefined>(undefined)

export function useToast(): ToastContextType {
  const context = useContext(ToastContext)
  if (context === undefined) throw new Error('useToast must be used within a ToastProvider')
  return context
}
