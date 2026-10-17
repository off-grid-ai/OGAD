// One model slot, drawn the same way everywhere a model is picked for a job: Text & Vision, Image,
// Voice, Transcription, and each Task role (grounding specialist, decision model). The active model
// is a card; Unload frees it from memory (it reloads on next use); a dropdown switches to another
// installed model. Callers own the data and the actions; this only draws and asks.

import type { ReactNode } from 'react'
import { CircleNotch, Power } from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Badge } from '@offgrid/operator-ui/operator/coss/badge'
import { Card } from '@offgrid/operator-ui/operator/coss/card'
import { Section } from '@offgrid/operator-ui/operator/experience'
import { Button } from './ui/button'
import { GlyphSwap, IconTip } from './IconTip'
import { SettingsSelect, type SettingsSelectOption } from './SettingsSelect'

/** Per-slot unload state. Absent = loaded or idle. */
export type UnloadStatus = 'unloading' | 'unloaded' | 'error'

const EASE = [0.16, 1, 0.3, 1] as const

export function UnloadButton(props: {
  readonly status?: UnloadStatus
  readonly onUnload: () => void
}): React.JSX.Element {
  const { status } = props
  return (
    <IconTip
      label={
        <>
          {status === 'error' ? 'Restart to unload' : 'Unload'}
          <span className="block text-muted-foreground">
            {status === 'error'
              ? 'Unload unavailable — restart the app'
              : status === 'unloaded'
                ? 'Already unloaded — reloads on next use'
                : 'Unload from memory now — frees RAM; reloads on next use'}
          </span>
        </>
      }
    >
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={status === 'error' ? 'Restart to unload' : 'Unload'}
        aria-busy={status === 'unloading' || undefined}
        onClick={props.onUnload}
        disabled={status === 'unloading' || status === 'unloaded'}
        className={status === 'error' ? 'text-amber-400' : 'text-neutral-500 hover:text-red-400'}
      >
        <GlyphSwap glyphKey={status === 'unloading' ? 'busy' : 'idle'}>
          {status === 'unloading' ? (
            <CircleNotch className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Power className="h-3.5 w-3.5" />
          )}
        </GlyphSwap>
      </Button>
    </IconTip>
  )
}

export function ActiveModelSlot(props: {
  /** Names the slot's region for assistive technology and tests. */
  readonly ariaLabel: string
  readonly label: ReactNode
  /** What the slot's model does (Task roles). */
  readonly does?: ReactNode
  /** The active model, or null when nothing is picked yet. */
  readonly active: {
    readonly name: string
    readonly detail?: ReactNode
    readonly remote?: boolean
  } | null
  /** Shown instead of the card and dropdown when no model of this kind is on the device. */
  readonly empty?: ReactNode
  readonly busy?: boolean
  /** Omitted: nothing here can be unloaded (a remote model, or a role that uses another slot). */
  readonly unload?: { readonly status?: UnloadStatus; readonly onUnload: () => void }
  /** Omitted: the slot follows another choice and cannot be switched here. */
  readonly select?: {
    readonly id: string
    readonly label: string
    readonly value: string
    readonly options: readonly SettingsSelectOption<string>[]
    readonly disabled?: boolean
    readonly onValueChange: (value: string) => void
  }
  /** Section actions besides Unload (for example a task's strategy). */
  readonly actions?: ReactNode
}): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  const markMotion = reduceMotion
    ? { initial: false as const, transition: { duration: 0 } }
    : {
        initial: { opacity: 0, scale: 0.5 },
        animate: { opacity: 1, scale: 1 },
        exit: { opacity: 0, scale: 0.5 },
        transition: { type: 'spring' as const, stiffness: 500, damping: 28 }
      }
  const { active, unload, select } = props
  const unloaded = unload?.status === 'unloaded'
  // The dropdown offers the OTHER models: the active one is the card above it.
  const others = select ? select.options.filter((option) => option.value !== select.value) : []
  return (
    <section aria-label={props.ariaLabel}>
      <Section
        label={props.label}
        actions={
          props.actions || (active && unload) ? (
            <span className="flex items-center gap-2">
              {props.actions}
              {active && unload ? (
                <UnloadButton status={unload.status} onUnload={unload.onUnload} />
              ) : null}
            </span>
          ) : null
        }
      >
        {props.does ? (
          <p className="mb-2 text-xs leading-snug text-neutral-500">{props.does}</p>
        ) : null}
        {props.empty && !active && others.length === 0 ? (
          <p className="text-xs text-neutral-500">{props.empty}</p>
        ) : (
          <div className="space-y-2">
            <motion.div layout={!reduceMotion} transition={{ duration: 0.4, ease: EASE }}>
              <Card
                aria-label={`${props.ariaLabel} active model`}
                className={`flex w-full min-w-0 flex-row items-center justify-between gap-3 border-l-2 px-3 py-2 text-xs ${
                  active && !unloaded ? 'border-l-green-500 bg-green-500/5' : 'border-l-neutral-700'
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="block truncate text-[13px] text-neutral-100">
                    {active ? active.name : 'None selected'}
                  </span>
                  {active?.remote ? (
                    <Badge variant="success" size="sm" className="shrink-0">
                      Remote
                    </Badge>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-neutral-500">
                  {active?.detail}
                  <AnimatePresence mode="popLayout" initial={false}>
                    {props.busy ? (
                      <motion.span key="busy" className="flex" {...markMotion}>
                        <CircleNotch className="h-3.5 w-3.5 animate-spin text-neutral-500" />
                      </motion.span>
                    ) : active && unloaded ? (
                      <motion.span key="unloaded" className="flex" {...markMotion}>
                        <Badge variant="outline" size="sm">
                          <Power className="h-3 w-3" /> Unloaded
                        </Badge>
                      </motion.span>
                    ) : null}
                  </AnimatePresence>
                </span>
              </Card>
            </motion.div>
            {/* Every model slot picks the same way, a list you can type into, however short. With
                nothing else to switch to it stays, disabled and saying so, rather than vanishing. */}
            {select ? (
              <SettingsSelect<string>
                id={select.id}
                label={select.label}
                value=""
                placeholder={
                  others.length === 0
                    ? 'No other model on this device'
                    : active
                      ? 'Switch to another model'
                      : 'Choose a model'
                }
                searchable
                disabled={others.length === 0 || select.disabled || props.busy}
                onValueChange={select.onValueChange}
                options={others}
              />
            ) : null}
          </div>
        )}
      </Section>
    </section>
  )
}
