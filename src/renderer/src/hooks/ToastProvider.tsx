import { useCallback, useRef, useState, type ReactNode } from 'react'
import { CheckIcon, InfoIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react'
import { ToastContext, type ToastContextType } from './useToast'
import { track } from '../lib/analytics'

// Transient top-right toast with an optional action (e.g. Undo). Distinct from
// the persistent notification center (useNotifications): a toast auto-dismisses
// and is for momentary confirmations. Generic shell infrastructure, usable from
// core and Pro screens alike.

interface Toast {
  id: string
  message: string
  tone: 'success' | 'error' | 'neutral'
  code: string
  actionLabel?: string
  onAction?: () => void
}

const DEFAULT_DURATION = 6000
const ERROR_CODE = /^[a-z0-9_]{1,40}$/

/** An error toast's response, counted by its fixed code only. */
function reportResponse(toast: Toast, response: 'action' | 'dismiss'): void {
  if (toast.tone === 'error') track('error_response', { error_code: toast.code, response })
}

export function ToastProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const dismiss = useCallback((id: string) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id))
    const timer = timers.current[id]
    if (timer) {
      clearTimeout(timer)
      delete timers.current[id]
    }
  }, [])

  const showToast = useCallback<ToastContextType['showToast']>(
    ({ message, tone = 'success', code, actionLabel, onAction, durationMs }) => {
      const id = crypto.randomUUID()
      const fixedCode = code && ERROR_CODE.test(code) ? code : 'toast'
      if (tone === 'error') track('error_shown', { error_code: fixedCode })
      setToasts((previous) =>
        [{ id, message, tone, code: fixedCode, actionLabel, onAction }, ...previous].slice(0, 4)
      )
      timers.current[id] = setTimeout(() => dismiss(id), durationMs ?? DEFAULT_DURATION)
    },
    [dismiss]
  )

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[60] flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            data-tone={toast.tone}
            className="pointer-events-auto flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/95 px-3.5 py-2 font-mono text-xs text-neutral-200 shadow-xl backdrop-blur"
          >
            {toast.tone === 'error' ? (
              <WarningCircleIcon className="h-4 w-4 shrink-0 text-red-400" />
            ) : toast.tone === 'neutral' ? (
              <InfoIcon className="h-4 w-4 shrink-0 text-neutral-400" />
            ) : (
              <CheckIcon className="h-4 w-4 shrink-0 text-green-500" />
            )}
            <span className="max-w-[22rem] truncate">{toast.message}</span>
            {toast.actionLabel && toast.onAction && (
              <button
                onClick={() => {
                  reportResponse(toast, 'action')
                  toast.onAction?.()
                  dismiss(toast.id)
                }}
                className="shrink-0 rounded-sm border border-green-500/50 bg-green-500/10 px-2 py-0.5 text-emerald-400 hover:bg-green-500/20"
              >
                {toast.actionLabel}
              </button>
            )}
            <button
              onClick={() => {
                reportResponse(toast, 'dismiss')
                dismiss(toast.id)
              }}
              aria-label="Dismiss"
              className="shrink-0 text-neutral-600 hover:text-neutral-300"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
