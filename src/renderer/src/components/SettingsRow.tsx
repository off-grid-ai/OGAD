import type { ReactNode } from 'react'

export function SettingsRow({
  label,
  hint,
  value,
  controlId,
  children
}: {
  label: string
  hint?: string
  value?: string
  controlId?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center justify-between">
        <label htmlFor={controlId} className="text-[11px] uppercase tracking-wide text-neutral-400">
          {label}
        </label>
        {value !== undefined ? <span className="text-xs text-green-500">{value}</span> : null}
      </div>
      {children}
      {hint ? <p className="mt-1 text-[10px] text-neutral-600">{hint}</p> : null}
    </div>
  )
}
