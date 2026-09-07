import { useEffect, useRef, useState } from 'react'
import {
  IconPhoto,
  IconUser,
  IconHash,
  IconVideo,
  IconBulb,
  IconSearch,
  IconCornerDownLeft,
  IconLayoutSidebar,
  IconLock
} from '@tabler/icons-react'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandGroup,
  CommandEmpty
} from './ui/command'
import type { SearchHit } from '@/types'
import { paletteScreenMatches, type PaletteScreen } from '../lib/paletteScreens'

const KIND_ICON = {
  screen: IconPhoto,
  meeting: IconVideo,
  memory: IconBulb,
  entity: IconUser,
  fact: IconHash
} as const

interface CommandPaletteProps {
  onOpenHit: (hit: SearchHit) => void
  onSeeAll: (query: string) => void
  /** Every navigable screen, in sidebar order. */
  screens?: PaletteScreen[]
  onGoTo?: (view: string, subroute?: string) => void
}

// ⌘K universal search launcher. Fast (keyword-only) results; Enter opens, or jump
// to the full Search screen for the semantic pass. Pre-ranked server-side, so
// cmdk's own filtering is disabled (shouldFilter={false}).
export function CommandPalette({
  onOpenHit,
  onSeeAll,
  screens = [],
  onGoTo
}: CommandPaletteProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const seq = useRef(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Debounced fast search (keyword only for instant feel).
  useEffect(() => {
    if (!query.trim()) {
      const id = ++seq.current
      const clearTimer = window.setTimeout(() => {
        if (id === seq.current) setHits([])
      }, 0)
      return () => window.clearTimeout(clearTimer)
    }
    const id = ++seq.current
    const searchTimer = window.setTimeout(() => {
      void window.api
        .universalSearch(query, { limit: 8, semantic: false })
        .then((result) => {
          const nextHits = Array.isArray(result) ? result : []
          if (id === seq.current) setHits(nextHits)
        })
        .catch((error: unknown) => console.error('Command palette search failed:', error))
    }, 140)
    return () => window.clearTimeout(searchTimer)
  }, [query])

  const open_ = (hit: SearchHit): void => {
    setOpen(false)
    onOpenHit(hit)
  }
  const seeAll = (): void => {
    if (query.trim()) {
      setOpen(false)
      onSeeAll(query)
    }
  }
  const goTo = (view: string, subroute?: string): void => {
    setOpen(false)
    setQuery('')
    onGoTo?.(view, subroute)
  }

  // Screens are known locally, so they resolve as you type rather than waiting on a search round
  // trip. With nothing typed the palette is a jump list: ⌘K then a screen name, never a hunt.
  const needle = query.trim().toLowerCase()
  // Screens never crowd out content: a handful at most once something is typed, everything when not.
  const screenMatches = onGoTo ? paletteScreenMatches(screens, needle, hits.length > 0 ? 3 : 6) : []

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} className="overflow-hidden p-0">
        <DialogTitle className="sr-only">Search Off Grid AI</DialogTitle>
        <Command shouldFilter={false} className="font-mono">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search everything, or jump to a screen…"
          />
          <CommandList>
            {query.trim() && hits.length === 0 && screenMatches.length === 0 && (
              <CommandEmpty>No matches — press Enter for a deep search.</CommandEmpty>
            )}
            {screenMatches.length > 0 && (
              <CommandGroup heading={needle ? 'Screens' : 'Go to'}>
                {screenMatches.map((screen) => (
                  <CommandItem
                    key={`${screen.view}:${screen.subroute ?? ''}`}
                    value={`__screen_${screen.view}_${screen.subroute ?? ''}`}
                    onSelect={() => goTo(screen.view, screen.subroute)}
                    className="gap-3"
                    data-testid={`palette-screen-${screen.view}-${screen.subroute ?? 'root'}`}
                  >
                    <IconLayoutSidebar className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm text-white">
                      {screen.label}
                    </span>
                    {screen.locked && (
                      <IconLock className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {hits.length > 0 && (
              <CommandGroup heading="Results">
                {hits.map((h) => {
                  const Icon = KIND_ICON[h.kind] ?? IconSearch
                  return (
                    <CommandItem
                      key={h.key}
                      value={h.key}
                      onSelect={() => open_(h)}
                      className="gap-3"
                    >
                      <Icon className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-white">{h.title}</div>
                        <div className="truncate text-xs text-neutral-500">{h.snippet}</div>
                      </div>
                      <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">
                        {h.kind}
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}
            {query.trim() && (
              <CommandGroup>
                <CommandItem value="__see_all__" onSelect={seeAll} className="gap-2 text-green-500">
                  <IconCornerDownLeft className="h-4 w-4 shrink-0" aria-hidden />
                  See all results for “{query}”
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
