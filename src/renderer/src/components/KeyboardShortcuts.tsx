import React from 'react'
import { Kbd, KbdGroup } from '@offgrid/operator-ui/operator/coss/kbd'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'
import { ListRow } from '@offgrid/operator-ui/operator/list-row'
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
    keys: [isMac() ? '⌥' : 'Alt', 'Space'],
    action: 'Dictation — hold or toggle',
    pro: true,
    note: 'Customizable in Voice'
  } // pro/main/dictation/controller.ts
]

export function KeyboardShortcuts(): React.ReactElement {
  const { isPro } = useRendererEntitlement()
  const rows = SHORTCUTS.filter((s) => !s.pro || isPro)
  return (
    <div className="space-y-3">
      {/* Rows sit inside a SettingsCard: quiet list rows, no nested borders. */}
      <AnimatedGroup as="ul" asChild="li" preset="slide" className="-mx-1 space-y-0.5">
        {rows.map((s) => (
          <ListRow
            key={s.action}
            title={s.action}
            description={s.note}
            meta={
              <KbdGroup>
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </KbdGroup>
            }
          />
        ))}
      </AnimatedGroup>
      {!isPro ? (
        <p className="text-xs text-neutral-500">
          Clipboard and dictation shortcuts unlock with Pro.
        </p>
      ) : null}
    </div>
  )
}
