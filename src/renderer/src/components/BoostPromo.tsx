import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { CloudIcon, XIcon } from '@phosphor-icons/react'
import {
  BOOST_PROMO,
  boostPromoCopy,
  boostPromoLink,
  boostPromoVisible,
  type BoostPromoSurface
} from '@offgrid/models'
import { Button } from './ui/button'
import { IconTip } from './IconTip'
import { openExternal } from '../constants/links'
import { track } from '../lib/analytics'

const COPY = boostPromoCopy('computer')
/** The setting that holds the promo version the person closed. */
export const BOOST_PROMO_SETTING = 'boostPromoClosedVersion'
/** Sent when one promo is closed, so every other promo on screen closes with it. */
const CLOSED_EVENT = 'offgrid:boost-promo-closed'

/**
 * Models too big for this computer, on our private servers. Free and Pro both see it. Closing it
 * keeps it closed until the promo's version changes. The button opens the offer page in the
 * browser: the website owns the price.
 */
export function BoostPromo({
  surface,
  className
}: {
  surface: BoostPromoSurface
  className?: string
}): React.JSX.Element | null {
  const reduceMotion = useReducedMotion()
  // Unknown until settings load, so a closed promo never flashes in.
  const [closedVersion, setClosedVersion] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    // Where the settings bridge is absent (isolated surfaces), it shows as never closed.
    Promise.resolve()
      .then(() => window.api.getSettings())
      .then((settings) => {
        if (!live) return
        const value = settings[BOOST_PROMO_SETTING]
        setClosedVersion(typeof value === 'string' ? value : null)
      })
      .catch(() => live && setClosedVersion(null))
    const closedElsewhere = (event: Event): void => setClosedVersion((event as CustomEvent<string>).detail)
    window.addEventListener(CLOSED_EVENT, closedElsewhere)
    return () => {
      live = false
      window.removeEventListener(CLOSED_EVENT, closedElsewhere)
    }
  }, [])

  const visible = closedVersion !== undefined && boostPromoVisible(closedVersion)

  useEffect(() => {
    if (visible) track('boost_promo_shown', { surface })
  }, [visible, surface])

  if (!visible) return null

  const claim = (): void => {
    track('boost_promo_clicked', { surface })
    openExternal(boostPromoLink('desktop', surface))
  }
  const close = (): void => {
    track('boost_promo_dismissed', { surface })
    setClosedVersion(BOOST_PROMO.version)
    window.dispatchEvent(new CustomEvent(CLOSED_EVENT, { detail: BOOST_PROMO.version }))
    Promise.resolve()
      .then(() => window.api.saveSetting(BOOST_PROMO_SETTING, BOOST_PROMO.version))
      .catch(() => undefined)
  }

  return (
    <motion.section
      data-testid="boost-promo"
      aria-label={COPY.title}
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.16, 1, 0.3, 1] }}
      className={`flex items-center gap-3 rounded-xl border border-border/60 bg-card/50 py-2.5 pl-4 pr-2 backdrop-blur-xl ${className ?? ''}`}
    >
      <CloudIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1 truncate text-sm text-foreground">
        {COPY.title} <span className="text-muted-foreground">{COPY.line}</span>
      </p>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={claim}
        data-testid="boost-promo-claim"
        className="shrink-0 whitespace-nowrap text-primary"
      >
        {COPY.action}
      </Button>
      <IconTip label={COPY.close}>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={close}
          aria-label={COPY.close}
          data-testid="boost-promo-close"
          className="shrink-0 text-muted-foreground"
        >
          <XIcon className="h-3.5 w-3.5" />
        </Button>
      </IconTip>
    </motion.section>
  )
}

/**
 * The offer as one quiet line in a step of onboarding: what it is and a link to the page. Nothing to
 * close: the step itself moves on. It fades in after `delay` seconds and counts as shown only then,
 * so moving on before it appears is not an impression.
 */
export function BoostPromoLine({
  className,
  delay = 0
}: {
  className?: string
  delay?: number
}): React.JSX.Element {
  useEffect(() => {
    const shown = window.setTimeout(() => track('boost_promo_shown', { surface: 'onboarding' }), delay * 1000)
    return () => window.clearTimeout(shown)
  }, [delay])
  const claim = (): void => {
    track('boost_promo_clicked', { surface: 'onboarding' })
    openExternal(boostPromoLink('desktop', 'onboarding'))
  }
  return (
    <motion.p
      data-testid="boost-promo-line"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay }}
      className={`text-sm text-neutral-400 ${className ?? ''}`}
    >
      {COPY.title} {COPY.line}{' '}
      <button
        type="button"
        onClick={claim}
        data-testid="boost-promo-line-claim"
        className="text-emerald-600 underline-offset-4 transition-colors duration-150 hover:underline active:scale-[0.98] dark:text-emerald-400"
      >
        {COPY.action}
      </button>
    </motion.p>
  )
}
