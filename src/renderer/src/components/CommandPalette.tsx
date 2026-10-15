import { useEffect, useRef, useState } from 'react'
import {
  IconPhoto,
  IconUser,
  IconVideo,
  IconSearch,
  IconCornerDownLeft,
  IconLayoutSidebar,
  IconLock
} from '@tabler/icons-react'
import { Badge } from '@offgrid/operator-ui/operator/coss/badge'
import { Kbd, KbdGroup } from '@offgrid/operator-ui/operator/coss/kbd'
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogPrimitive,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel
} from '@offgrid/operator-ui/operator/coss/command'
import { Highlight } from '@offgrid/operator-ui/operator/presence'
import { acquireNativeSurfaceOcclusion } from '@renderer/lib/native-surface-occlusion'
import type { SearchHit } from '@/types'
import { paletteScreenMatches, type PaletteScreen } from '../lib/paletteScreens'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api

const KIND_ICON = {
  screen: IconPhoto,
  meeting: IconVideo,
  entity: IconUser
} as const

interface CommandPaletteProps {
  onOpenHit: (hit: SearchHit) => void
  onSeeAll: (query: string) => void
  /** Every navigable screen, in sidebar order. */
  screens?: PaletteScreen[]
  onGoTo?: (view: string, subroute?: string) => void
}

const SEE_ALL = '__see_all__'
const screenId = (screen: PaletteScreen): string =>
  `__screen_${screen.view}_${screen.subroute ?? ''}`

// ⌘K universal search launcher. Fast (keyword-only) results; Enter opens, or jump
// to the full Search screen for the semantic pass. Pre-ranked server-side, so the
// command bar's own filtering is off (mode="none"): it shows exactly the groups built here.
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
    // Every query change bumps the sequence, so a reply for an older query never lands - including
    // one that arrives after the box was cleared (onChange clears the hits themselves).
    const id = ++seq.current
    if (!query.trim()) return undefined
    const t = setTimeout(async () => {
      let nextHits: SearchHit[] = []
      try {
        const result = await api.universalSearch(query, { limit: 8, semantic: false })
        if (Array.isArray(result)) nextHits = result as SearchHit[]
      } catch {
        // A failed search shows no hits rather than the previous query's hits.
      }
      if (id === seq.current) setHits(nextHits)
    }, 140)
    return () => clearTimeout(t)
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

  const screenById = new Map(screenMatches.map((screen) => [screenId(screen), screen]))
  const hitById = new Map(hits.map((hit) => [hit.key, hit]))
  const groups = [
    ...(screenMatches.length > 0
      ? [{ value: needle ? 'Screens' : 'Go to', items: screenMatches.map(screenId) }]
      : []),
    ...(hits.length > 0 ? [{ value: 'Results', items: hits.map((hit) => hit.key) }] : []),
    ...(query.trim() ? [{ value: '', items: [SEE_ALL] }] : [])
  ]

  const renderItem = (id: string): React.ReactElement | null => {
    if (id === SEE_ALL) {
      return (
        <CommandItem key={id} value={id} onClick={seeAll} className="gap-2 text-green-500">
          <IconCornerDownLeft className="h-4 w-4 shrink-0" aria-hidden />
          See all results for “{query}”
        </CommandItem>
      )
    }
    const screen = screenById.get(id)
    if (screen) {
      return (
        <CommandItem
          key={id}
          value={id}
          onClick={() => goTo(screen.view, screen.subroute)}
          className="gap-3"
          data-testid={`palette-screen-${screen.view}-${screen.subroute ?? 'root'}`}
        >
          <IconLayoutSidebar className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm text-white">
            <Highlight text={screen.label} query={query.trim()} />
          </span>
          {screen.locked && (
            <IconLock className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden />
          )}
        </CommandItem>
      )
    }
    const hit = hitById.get(id)
    if (!hit) return null
    const Icon = KIND_ICON[hit.kind] ?? IconSearch
    return (
      <CommandItem key={id} value={id} onClick={() => open_(hit)} className="gap-3">
        <Icon className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-white">
            <Highlight text={hit.title} query={query.trim()} />
          </div>
          <div className="truncate text-xs text-neutral-500">
            <Highlight text={hit.snippet} query={query.trim()} />
          </div>
        </div>
        <Badge variant="outline" size="sm" className="shrink-0">
          {hit.kind}
        </Badge>
      </CommandItem>
    )
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      {/* Native child views stay below the bar from the moment it opens until its exit ends. */}
      <CommandDialogPopup className="border-border/60" occlusion={acquireNativeSurfaceOcclusion}>
        <CommandDialogPrimitive.Title className="sr-only">
          Search Off Grid AI
        </CommandDialogPrimitive.Title>
        <Command
          items={groups}
          mode="none"
          value={query}
          onValueChange={(value, details) => {
            // Choosing an item runs its action; it must not write the item's id into the box.
            if (details.reason === 'item-press') return
            setQuery(value)
            if (!value.trim()) setHits([])
          }}
        >
          <CommandInput
            aria-label="Search everything"
            placeholder="Search everything, or jump to a screen…"
            className="font-mono"
          />
          <CommandPanel>
            <CommandEmpty>
              {query.trim() ? 'No matches — press Enter for a deep search.' : null}
            </CommandEmpty>
            <CommandList>
              {(group: { value: string; items: string[] }) => (
                <CommandGroup key={group.value || 'actions'} items={group.items}>
                  {group.value ? <CommandGroupLabel>{group.value}</CommandGroupLabel> : null}
                  <CommandCollection>{(id: string) => renderItem(id)}</CommandCollection>
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
        </Command>
        {/* Keyboard hints, as the library's command bar shows them. */}
        <CommandFooter>
          <span className="flex items-center gap-2">
            <KbdGroup>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </KbdGroup>
            to move
            <Kbd className="ms-2">↵</Kbd>
            to open
          </span>
          <span className="flex items-center gap-2">
            <Kbd>Esc</Kbd>
            to close
          </span>
        </CommandFooter>
      </CommandDialogPopup>
    </CommandDialog>
  )
}
