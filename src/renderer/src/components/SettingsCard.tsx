import { createContext, useContext, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { LockKey, CaretDown, CaretLeft, Clock } from '@phosphor-icons/react'
import { cn } from '@renderer/lib/utils'

// Reusable Settings chrome, extracted from the Settings screen so both core and the
// pro package (pro/renderer/settings-sections.tsx) can render sections with the same
// card without importing the 2,600-line Settings.tsx (which drags SetupPanel/etc. and
// their window.api typings into the pro typecheck). Light deps only.

// Optional accordion-group context. When a <SettingsCardsGroup> wraps the cards, they
// behave as one grid that drills into a detail: only ONE card is open at a time, the
// open card takes over the full grid width (the L2 detail), and every other card (and
// Pro placeholder) hides. Without a provider each card keeps its own local open state,
// so any other usage is unchanged. ONE seam → core and pro sections both get this for
// free, since both render through SettingsCard.
interface AccordionGroup {
  openId: string | null
  setOpenId: (id: string | null) => void
}
const GroupContext = createContext<AccordionGroup | null>(null)

export function SettingsCardsGroup({
  children,
  initialOpenId = null,
  openId: controlledOpenId,
  onOpenIdChange
}: {
  children: React.ReactNode
  initialOpenId?: string | null
  openId?: string | null
  onOpenIdChange?: (id: string | null) => void
}): React.ReactElement {
  const [localOpenId, setLocalOpenId] = useState<string | null>(initialOpenId)
  const openId = controlledOpenId === undefined ? localOpenId : controlledOpenId
  const setOpenId = (id: string | null): void => {
    if (controlledOpenId === undefined) setLocalOpenId(id)
    onOpenIdChange?.(id)
  }
  return <GroupContext.Provider value={{ openId, setOpenId }}>{children}</GroupContext.Provider>
}

// Collapsed by default: a grid card showing the title + one-line summary. Click to
// open — in a group it becomes the full-width L2 detail and the others hide.
export function SettingsCard({
  title,
  summary,
  defaultOpen = false,
  children,
  delay = 0.13
}: {
  title: string
  summary: string
  defaultOpen?: boolean
  children: React.ReactNode
  delay?: number
}): React.ReactElement | null {
  const group = useContext(GroupContext)
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const open = group ? group.openId === title : localOpen
  const toggle = (): void => {
    if (group) {
      group.setOpenId(open ? null : title)
    } else {
      setLocalOpen((o) => !o)
    }
  }
  // In a group, a different card is the open detail — hide this one. Instead of
  // unmounting instantly (which pops the sibling out with no transition), we keep it
  // in AnimatePresence and let it exit-animate out of the grid while the opening card
  // morphs to full width — the two happen together, so drilling in feels finished.
  const hidden = !!group && group.openId !== null && !open
  return (
    <AnimatePresence mode="popLayout">
      {!hidden && (
        <motion.div
          key={title}
          // layout="position" (not full `layout`): animate only the card's POSITION as
          // siblings reflow. Full `layout` animates SIZE via a transform: scale(), which
          // visibly zoomed/stretched the text while a section opened (width -> col-span-full
          // and the body height 0->auto happening together). Position-only keeps content
          // crisp; the body's own height animation below does the smooth vertical growth.
          layout="position"
          className={cn(
            'overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/60 backdrop-blur-sm',
            open && group && 'col-span-full' // take over the grid width as the L2 detail
          )}
          initial={{ opacity: 0, filter: 'blur(10px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          // popLayout pulls the exiting card out of flow so the rest reflow smoothly;
          // it fades + blurs + eases back rather than vanishing.
          exit={{
            opacity: 0,
            filter: 'blur(8px)',
            scale: 0.97,
            transition: { duration: 0.22, ease: [0.4, 0, 0.2, 1] }
          }}
          transition={{
            duration: 0.6,
            delay,
            // The expand-into-detail / collapse-back morph — spring so it feels physical.
            layout: { type: 'spring', stiffness: 420, damping: 36 }
          }}
        >
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="flex w-full items-center gap-3 p-6 text-left"
          >
            <div className="min-w-0 flex-1">
              {open && group ? (
                <span className="mb-1 flex items-center gap-1 text-[11px] uppercase tracking-wide text-neutral-500">
                  <CaretLeft className="h-3 w-3" /> All settings
                </span>
              ) : null}
              <h3 className="text-base font-medium text-white">{title}</h3>
              {!open && <p className="mt-1 text-sm text-neutral-500">{summary}</p>}
            </div>
            <CaretDown
              className={cn(
                'h-4 w-4 shrink-0 text-neutral-500 transition-transform',
                open && 'rotate-180'
              )}
            />
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div
                key="body"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
                className="overflow-hidden"
              >
                <div className="px-6 pb-6">{children}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// A Pro section shown (disabled) in the free build: title + description + a "Pro"
// badge, dimmed and non-interactive. Hidden while another card is the open detail.
export function ProPlaceholder({
  title,
  description,
  delay = 0.18,
  variant = 'pro'
}: {
  title: string
  description: string
  delay?: number
  variant?: 'pro' | 'coming-soon'
}): React.ReactElement | null {
  const group = useContext(GroupContext)
  // Hidden while another card is the open detail — exit-animate out with the siblings
  // (same treatment as SettingsCard) instead of popping.
  const hidden = !!group && group.openId !== null
  return (
    <AnimatePresence mode="popLayout">
      {!hidden && (
        <motion.div
          // position-only, matching SettingsCard: reflow smoothly without scale-distorting
          // the placeholder's text when sibling cards open/close.
          layout="position"
          className="relative rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6"
          initial={{ opacity: 0, filter: 'blur(10px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          exit={{
            opacity: 0,
            filter: 'blur(8px)',
            scale: 0.97,
            transition: { duration: 0.22, ease: [0.4, 0, 0.2, 1] }
          }}
          transition={{ duration: 0.6, delay }}
        >
          {variant === 'coming-soon' ? (
            <span className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full border border-neutral-700 bg-neutral-800/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-300">
              <Clock weight="bold" className="h-3 w-3" /> Coming soon
            </span>
          ) : (
            <span className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
              <LockKey weight="bold" className="h-3 w-3" /> Pro
            </span>
          )}
          <h3 className="mb-1 pr-28 text-base font-medium text-neutral-300">{title}</h3>
          <p className="text-sm text-neutral-600">{description}</p>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
