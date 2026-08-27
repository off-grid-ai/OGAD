import { useEffect, useMemo, useState } from 'react'
import { IconChevronDown } from '@tabler/icons-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'

export interface SidebarNavigationGroup<Item extends { view: string; label: string }> {
  label: string
  items: readonly Item[]
}

interface SidebarNavigationMenuProps<Item extends { view: string; label: string }> {
  activeView: Item['view']
  expanded: boolean
  groups: readonly SidebarNavigationGroup<Item>[]
  renderItem: (item: Item) => React.ReactElement
}

/** Thin navigation adapter over the shared Collapsible primitive. The active
 * route opens its section, while every section keeps an independent state. */
export function SidebarNavigationMenu<Item extends { view: string; label: string }>({
  activeView,
  expanded,
  groups,
  renderItem
}: SidebarNavigationMenuProps<Item>): React.ReactElement {
  const activeGroup = useMemo(
    () =>
      groups.find((group) => group.items.some((item) => item.view === activeView))?.label ?? null,
    [activeView, groups]
  )
  // Every group starts OPEN, so the expanded sidebar shows exactly what the collapsed rail shows.
  // Seeding only the active group meant an icon you could see and hover in the rail vanished the
  // moment the sidebar expanded, because the rail has no group headers and therefore always
  // renders every item. Collapsing a group is now something the user chose, not a default that
  // silently hides navigation.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(
    () => new Set(groups.map((group) => group.label))
  )

  useEffect(() => {
    if (!activeGroup) return
    setOpenGroups((current) => {
      if (current.has(activeGroup)) return current
      return new Set([...current, activeGroup])
    })
  }, [activeGroup])

  return (
    <div className={expanded ? 'flex flex-col gap-1' : 'flex flex-col'} aria-label="Menu sections">
      {groups.map((group, index) => {
        const open = expanded ? openGroups.has(group.label) : true
        const activeItem = group.items.find((item) => item.view === activeView)
        return (
          <Collapsible
            key={group.label}
            open={open}
            role="group"
            aria-label={group.label}
            className={!expanded && index > 0 ? 'mt-2 border-t border-neutral-800 pt-2' : undefined}
            onOpenChange={(nextOpen) => {
              if (!expanded) return
              setOpenGroups((current) => {
                const next = new Set(current)
                if (nextOpen) next.add(group.label)
                else next.delete(group.label)
                return next
              })
            }}
          >
            <CollapsibleTrigger asChild>
              <button
                type="button"
                tabIndex={expanded ? 0 : -1}
                aria-hidden={!expanded}
                aria-label={
                  !open && activeItem ? `${group.label}, current: ${activeItem.label}` : group.label
                }
                className={
                  expanded
                    ? 'group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[10px] uppercase tracking-[0.14em] text-neutral-500 transition-colors hover:bg-neutral-500/10 hover:text-white'
                    : 'hidden'
                }
              >
                <span className="min-w-0 flex-1 truncate">{group.label}</span>
                {!open && activeItem ? (
                  <span className="max-w-[7rem] truncate text-[9px] tracking-[0.08em] text-emerald-400">
                    {activeItem.label}
                  </span>
                ) : null}
                <IconChevronDown
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="offgrid-smooth-collapsible flex flex-col gap-1 overflow-hidden pb-1">
              {group.items.map(renderItem)}
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}
