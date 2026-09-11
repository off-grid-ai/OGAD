import { useEffect, useState } from 'react'
import { persistToggle } from '@renderer/lib/persist-toggle'

export function GodTwinSettings(): React.ReactElement {
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    void window.api.godTwin?.getEnabled().then(setEnabled)
  }, [])

  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="text-xs text-neutral-600">
          {enabled ? 'Ares is shown above your applications.' : 'Ares is hidden.'}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Show Ares on desktop"
        onClick={() => {
          const next = !enabled
          void persistToggle(next, enabled, setEnabled, () =>
            window.api.godTwin?.setEnabled(next) ?? Promise.resolve(next)
          )
        }}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-all duration-150 active:scale-95 ${enabled ? 'bg-emerald-500' : 'bg-neutral-700'}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
        />
      </button>
    </div>
  )
}
