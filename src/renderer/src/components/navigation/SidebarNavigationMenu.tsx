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
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(
    () => new Set(activeGroup ? [activeGroup] : [])
  )

  useEffect(() => {
    if (!activeGroup) return
    setOpenGroups((current) => {
      if (current.has(activeGroup)) return current
      return new Set([...current, activeGroup])
    })
  }, [activeGroup])

  if (!expanded) {
    return (
      <div className="flex flex-col" aria-label="Menu sections">
        {groups.map((group, index) => (
          <div
            key={group.label}
            role="group"
            aria-label={group.label}
            className={`flex flex-col gap-1 ${index > 0 ? 'mt-2 border-t border-neutral-800 pt-2' : ''}`}
          >
            {group.items.map(renderItem)}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1" aria-label="Menu sections">
      {groups.map((group) => {
        const open = openGroups.has(group.label)
        const activeItem = group.items.find((item) => item.view === activeView)
        return (
          <Collapsible
            key={group.label}
            open={open}
            onOpenChange={(nextOpen) =>
              setOpenGroups((current) => {
                const next = new Set(current)
                if (nextOpen) next.add(group.label)
                else next.delete(group.label)
                return next
              })
            }
          >
            <CollapsibleTrigger asChild>
              <button
                type="button"
                aria-label={
                  !open && activeItem ? `${group.label}, current: ${activeItem.label}` : group.label
                }
                className="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[10px] uppercase tracking-[0.14em] text-neutral-500 transition-colors hover:bg-neutral-500/10 hover:text-white"
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
            <CollapsibleContent className="offgrid-sidebar-section flex flex-col gap-1 overflow-hidden pb-1">
              {group.items.map(renderItem)}
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}
