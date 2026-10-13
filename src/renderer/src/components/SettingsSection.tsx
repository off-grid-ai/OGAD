// A group of settings that opens and closes: a clear header, one line saying what is set inside
// while it is closed, and the rows when it is open. Every settings screen groups its rows with it
// (Chat's tabs, Tasks, God), so they all disclose the same way. Opening animates
// (.offgrid-smooth-collapsible); which sections are open is remembered per section, on this device.

import { useState, type ReactNode } from 'react'
import { CaretDownIcon } from '@phosphor-icons/react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'

const OPEN_KEY = 'offgrid:settings-sections-open'

function rememberedOpen(id: string): boolean | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, unknown>
    return typeof saved[id] === 'boolean' ? saved[id] : undefined
  } catch {
    return undefined
  }
}

function rememberOpen(id: string, open: boolean): void {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, unknown>
    localStorage.setItem(OPEN_KEY, JSON.stringify({ ...saved, [id]: open }))
  } catch {
    // Storage unavailable (a private window): the section still opens and closes.
  }
}

export function SettingsSection(props: {
  /** Stable id: which sections are open is remembered by it. */
  readonly id: string
  readonly title: string
  /** What the section holds, or what is set in it now, shown under the title. */
  readonly summary?: ReactNode
  /** Open the first time it is seen. Most-used sections open; the rest wait to be asked for. */
  readonly defaultOpen?: boolean
  readonly children: ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(() => rememberedOpen(props.id) ?? props.defaultOpen === true)
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        rememberOpen(props.id, next)
      }}
      className="group mb-3 rounded-md border border-neutral-800 bg-neutral-950/40"
    >
      <CollapsibleTrigger className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-neutral-900/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-green-500/60">
        <span className="min-w-0">
          <span className="block text-xs font-medium text-neutral-200">{props.title}</span>
          {props.summary ? (
            <span className="mt-0.5 block truncate text-[11px] text-neutral-500">
              {props.summary}
            </span>
          ) : null}
        </span>
        <CaretDownIcon
          aria-hidden="true"
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-500 transition-transform duration-200 group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="offgrid-smooth-collapsible overflow-hidden">
        <div className="border-t border-neutral-800 px-3 pb-1 pt-3">{props.children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
