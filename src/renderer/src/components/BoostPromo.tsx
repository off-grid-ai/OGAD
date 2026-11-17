import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { XIcon } from '@phosphor-icons/react'
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
    window.api
      .getSettings()
      .then((settings) => {
        if (!live) return
        const value = settings[BOOST_PROMO_SETTING]
        setClosedVersion(typeof value === 'string' ? value : null)
      })
      .catch(() => live && setClosedVersion(null))
    return () => {
      live = false
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
    void window.api.saveSetting(BOOST_PROMO_SETTING, BOOST_PROMO.version)
  }

  return (
    <motion.section
      data-testid="boost-promo"
      aria-label={COPY.title}
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.16, 1, 0.3, 1] }}
      className={`flex items-center gap-6 rounded-xl border border-border/60 bg-card/50 px-5 py-4 backdrop-blur-xl ${className ?? ''}`}
    >
      <div className="min-w-0 flex-1">
        <h3 className="text-lg font-light tracking-tight text-foreground">{COPY.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{COPY.body}</p>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={claim}
        data-testid="boost-promo-claim"
        className="shrink-0 whitespace-nowrap"
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
          className="shrink-0 self-start text-muted-foreground"
        >
          <XIcon className="h-3.5 w-3.5" />
        </Button>
      </IconTip>
    </motion.section>
  )
}
