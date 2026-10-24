import { useState, type ReactNode } from 'react'
import { IconChevronDown } from '@tabler/icons-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'

interface SidebarNavigationGroup<Item extends { view: string; label: string }> {
  label: string
  icon: ReactNode
  items: readonly Item[]
}

interface SidebarNavigationMenuProps<Item extends { view: string; label: string }> {
  activeView: Item['view']
  expanded: boolean
  groups: readonly SidebarNavigationGroup<Item>[]
  renderItem: (item: Item) => React.ReactElement
}

/** Thin navigation adapter over the shared Collapsible primitive. Every section
 * keeps one user-owned state across both sidebar widths. */
export function SidebarNavigationMenu<Item extends { view: string; label: string }>({
  activeView,
  expanded,
  groups,
  renderItem
}: SidebarNavigationMenuProps<Item>): React.ReactElement {
  // One section state owns both widths. Hover changes the sidebar's width, never this set, so a
  // destination cannot appear, disappear or move only because its label became visible.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(
    () => new Set(groups.map((group) => group.label))
  )

  return (
    <div className="flex flex-col gap-1" aria-label="Menu sections">
      {groups.map((group, index) => {
        const open = openGroups.has(group.label)
        const activeItem = group.items.find((item) => item.view === activeView)
        return (
          <Collapsible
            key={group.label}
            open={open}
            role="group"
            aria-label={group.label}
            className={index > 0 ? 'mt-2 border-t border-neutral-800 pt-2' : undefined}
            onOpenChange={(nextOpen) => {
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
                title={!expanded ? group.label : undefined}
                data-slot="button"
                aria-label={
                  !open && activeItem ? `${group.label}, current: ${activeItem.label}` : group.label
                }
                className={`group relative flex h-9 w-full items-center rounded-lg py-2 text-neutral-500 hover:bg-neutral-500/10 hover:text-white ${
                  expanded
                    ? 'gap-2 px-3 text-left text-[10px] uppercase tracking-[0.14em]'
                    : `justify-center px-0 ${activeItem && !open ? 'text-emerald-400' : ''}`
                }`}
              >
                {expanded ? (
                  <>
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
                  </>
                ) : (
                  <span aria-hidden="true" className="[&_svg]:h-5 [&_svg]:w-5">
                    {group.icon}
                  </span>
                )}
              </button>
            </CollapsibleTrigger>
            {/* The panel clips while its height animates. Inner padding, offset by an equal
                negative margin, leaves room for the selected row's glow without moving rows; the
                overlap above the heading passes clicks through to it. */}
            <CollapsibleContent className="offgrid-smooth-collapsible pointer-events-none -mx-4 -mt-3 -mb-3 flex flex-col gap-1 overflow-hidden px-4 pt-3 pb-4 [&>*]:pointer-events-auto">
              {group.items.map(renderItem)}
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}
