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
      className="grid gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-4"
      data-testid="onboarding-pro-offer"
    >
      <p className="text-sm text-neutral-300">
        Pro: $119 once or $7.99 a month. One license covers up to 5 devices.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => openExternal(OFF_GRID_WEBSITE_URL)}>
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
          <p className="text-xs text-neutral-500">
            Optional. You can add or change connections in Integrations later.
          </p>
        </div>
      )
    }
    // Onboarding runs before Pro starts, so a Pro feature always shows how to get it.
    return topic.pro ? <ProOffer /> : null
  }
  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6">
      <div className="flex min-h-0 flex-1 flex-col">
        <FeatureGuide isPro={false} onOpen={onOpen} picks={{ ids, footer }} />
      </div>
      <div className="grid gap-4 border-t border-white/10 pt-4 md:grid-cols-2">
        <div className="grid gap-1 text-xs text-neutral-400" data-testid="onboarding-where">
          <p className="flex items-center gap-2 text-sm text-neutral-200">
            <CpuIcon aria-hidden="true" className="h-4 w-4" />
            Models run in your {deviceNoun()}&apos;s memory.
          </p>
          <p className="flex items-center gap-2">
            <GlobeIcon aria-hidden="true" className="h-4 w-4" />A model server you add gets prompts
            only while you select it. Sync never copies its API keys to your phone.
          </p>
        </div>
        <div className="flex items-start gap-3">
          <Checkbox
            id="onboarding-share-analytics"
            checked={shareAnalytics}
            onCheckedChange={(checked) => onShareAnalytics(checked === true)}
            className="mt-0.5"
          />
          <div className="min-w-0">
            <label
              htmlFor="onboarding-share-analytics"
              className="cursor-pointer text-sm text-neutral-200"
            >
              Share anonymous stats and crash reports
            </label>
            <p className="mt-1 text-xs leading-5 text-neutral-500">
              Helps us fix what breaks on your computer. Your chats never leave it.{' '}
              <button
                type="button"
                onClick={() => setSharingOpen(true)}
                className="text-neutral-300 underline underline-offset-2 hover:text-white"
              >
                What we share
              </button>
            </p>
          </div>
        </div>
      </div>
      <WhatWeShareDialog open={sharingOpen} onOpenChange={setSharingOpen} />
    </div>
  )
}
