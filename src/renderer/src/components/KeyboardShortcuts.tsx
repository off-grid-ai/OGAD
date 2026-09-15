import React from 'react'
import { useRendererEntitlement } from '@renderer/bootstrap/useRendererEntitlement'
import { isMac } from '@renderer/lib/device'

// One reference catalog for every keyboard shortcut in the app. Each row notes where
// the shortcut is actually registered — keep this in sync with that site. Pro rows
// render only in Pro builds (the shortcuts don't exist without the pro package).
interface Shortcut {
  keys: string[]
  action: string
  pro?: boolean
  note?: string
}

const PRIMARY_MODIFIER_KEY = isMac() ? '⌘' : 'Ctrl'

const SHORTCUTS: Shortcut[] = [
  { keys: [PRIMARY_MODIFIER_KEY, 'K'], action: 'Open command palette' }, // CommandPalette.tsx
  { keys: [PRIMARY_MODIFIER_KEY, '['], action: 'Back' }, // App.tsx
  { keys: [PRIMARY_MODIFIER_KEY, ']'], action: 'Forward' }, // App.tsx
  { keys: [PRIMARY_MODIFIER_KEY, '+ / - / 0'], action: 'Window zoom' }, // main/index.ts
  {
    keys: [PRIMARY_MODIFIER_KEY, '⇧', 'C'],
    action: 'Clipboard quick-paste popup',
    pro: true
  }, // pro/main/clipboard.ts
  {
    keys: ['⌥', 'Space'],
    action: 'Dictation — hold or toggle',
    pro: true,
    note: 'Customizable in Voice'
  } // pro/main/dictation/controller.ts
]

export function KeyboardShortcuts(): React.ReactElement {
  const { isPro } = useRendererEntitlement()
  const rows = SHORTCUTS.filter((s) => !s.pro || isPro)
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((s) => (
        <div
          key={s.action}
          className="flex items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
        >
          <span className="text-xs text-neutral-300">
            {s.action}
            {s.note ? <span className="ml-2 text-[10px] text-neutral-600">· {s.note}</span> : null}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {s.keys.map((k) => (
              <kbd
                key={k}
                className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[11px] leading-none text-neutral-300"
              >
                {k}
              </kbd>
            ))}
          </span>
        </div>
      ))}
      {!isPro ? (
        <p className="px-1 pt-1 text-[10px] text-neutral-600">
          Clipboard and dictation shortcuts unlock with Pro.
        </p>
      ) : null}
    </div>
  )
}
