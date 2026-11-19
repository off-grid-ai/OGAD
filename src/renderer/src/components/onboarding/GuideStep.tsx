/**
 * Onboarding's third step: how the picks work. It is the guide itself, filtered to the picks, so
 * the pictures, steps and Ask box are the ones the app shows later. Under a Pro feature: the
 * price, Get Pro and Enter license key. Under Integrations: the connections, inline.
 */
import { useState, type JSX } from 'react'
import { guideTopicsFor } from '@offgrid/features'
import { CpuIcon, GlobeIcon } from '@phosphor-icons/react'
import { Checkbox } from '@offgrid/operator-ui/operator/coss/checkbox'
import { deviceNoun } from '@renderer/lib/device'
import { OFF_GRID_WEBSITE_URL, openExternal } from '@renderer/constants/links'
import { withUtm } from '@offgrid/core/shared/utm'
import type { ViewMode } from '@renderer/lib/view-modes'
import { FeatureGuide } from '../FeatureGuide'
import { QuickConnections } from '../QuickConnections'
import { LicenseActivation } from '../pro/UpgradeScreen'
import { WhatWeShareDialog } from '../analytics/WhatWeShareDialog'
import { Button } from '../ui/button'
import type { GuideTopic } from '../guide/guideKnowledge'
import type { Picks } from './picks'

/** The guide topic that holds the connections. */
const CONNECTIONS_TOPIC = 'connectors'

function ProOffer(): JSX.Element {
  const [keyOpen, setKeyOpen] = useState(false)
  return (
    <div
      className="grid gap-3 rounded-xl border border-border bg-card/60 p-4"
      data-testid="onboarding-pro-offer"
    >
      <p className="text-sm text-foreground">
        Pro: $119 once or $7.99 a month. One license covers up to 5 devices.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => openExternal(withUtm(OFF_GRID_WEBSITE_URL, 'onboarding-guide'))}>
          Get Pro
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-expanded={keyOpen}
          onClick={() => setKeyOpen((v) => !v)}
        >
          Enter license key
        </Button>
      </div>
      {keyOpen ? <LicenseActivation /> : null}
    </div>
  )
}

export function GuideStep({
  picks,
  shareAnalytics,
  onShareAnalytics,
  onConnectionBusy,
  onOpen
}: Readonly<{
  picks: Picks
  shareAnalytics: boolean
  onShareAnalytics: (on: boolean) => void
  onConnectionBusy: (busy: boolean) => void
  /** A way into a feature ("Open Scribe"): finish setup, then land there. */
  onOpen: (view: ViewMode) => void
}>): JSX.Element {
  const [sharingOpen, setSharingOpen] = useState(false)
  const ids = guideTopicsFor(picks.parts.length ? picks.parts : ['chat'], 'desktop')
  const footer = (topic: GuideTopic): JSX.Element | null => {
    if (topic.id === CONNECTIONS_TOPIC) {
      return (
        <div className="grid gap-2">
          <QuickConnections onBusyChange={onConnectionBusy} />
          <p className="text-xs text-muted-foreground">
            Optional. You can add or change connections in Integrations later.
          </p>
        </div>
      )
    }
    // Onboarding runs before Pro starts, so a Pro feature always shows how to get it.
    const offer = topic.pro ? <ProOffer /> : null
    if (!topic.notHere) return offer
    return (
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground" data-testid="onboarding-not-here">
          Coming to this {deviceNoun()} soon. Your license also works on the other computers Off
          Grid AI runs on.
        </p>
        {offer}
      </div>
    )
  }
  const navFooter = (
    <>
      <div className="grid gap-1.5 text-xs text-muted-foreground" data-testid="onboarding-where">
        <p className="flex items-start gap-2 text-foreground">
          <CpuIcon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Models run in your {deviceNoun()}&apos;s memory.
        </p>
        <p className="flex items-start gap-2">
          <GlobeIcon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />A model server you
          add gets prompts only while you select it. Sync never copies its API keys to your phone.
        </p>
      </div>
      <div className="flex items-start gap-2.5 border-t border-border pt-4">
        <Checkbox
          id="onboarding-share-analytics"
          checked={shareAnalytics}
          onCheckedChange={(checked) => onShareAnalytics(checked === true)}
          className="mt-0.5"
        />
        <div className="min-w-0">
          <label
            htmlFor="onboarding-share-analytics"
            className="cursor-pointer text-xs text-foreground"
          >
            Share anonymous stats and crash reports
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Helps us fix what breaks. Your chats never leave this {deviceNoun()}.{' '}
            <button
              type="button"
              onClick={() => setSharingOpen(true)}
              className="text-foreground underline underline-offset-2"
            >
              What we share
            </button>
          </p>
        </div>
      </div>
    </>
  )
  return (
    <div className="flex h-full w-full flex-col">
      <FeatureGuide isPro={false} onOpen={onOpen} picks={{ ids, footer, navFooter }} />
      <WhatWeShareDialog open={sharingOpen} onOpenChange={setSharingOpen} />
    </div>
  )
}
