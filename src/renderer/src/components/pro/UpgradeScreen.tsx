import { useEffect, useState } from 'react'
import { flow } from '@renderer/lib/analytics'
import {
  ArrowSquareOut,
  Check,
  Key,
  CircleNotch,
  DeviceMobile,
  Clock,
  Desktop,
  PuzzlePiece
} from '@phosphor-icons/react'
import { PageShell } from '../PageShell'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'
import { Button } from '../ui/button'
import { PRO_PAY_URL, PRO_FEATURES, featureSupportsPlatform, type ProFeature } from './proCatalog'
import { OFF_GRID_MOBILE_URL, OFF_GRID_WEBSITE_URL, openExternal } from '../../constants/links'
import { withUtm } from '@offgrid/core/shared/utm'
import { deviceNoun, currentPlatform } from '@renderer/lib/device'
import { projectPersonalMeshActivationFailure } from '@offgrid/sync'
import {
  LICENCE_ACTION_LABEL,
  activationFailureActions,
  licenceLine,
  productAction,
  type LicenceAction
} from '@offgrid/features'
import { SUPPORT_EMAIL } from '@offgrid/core/shared/analytics'

const KEY_INPUT_ID = 'license-key-input'

/** What each way back does on this computer. An action with nowhere to go here is not shown. */
function licenceActionRunners(retry?: () => void): Partial<Record<LicenceAction, () => void>> {
  return {
    renew: () => void window.api.license?.openPay(),
    'get-pro': () => void window.api.license?.openPay(),
    'enter-key': () => document.getElementById(KEY_INPUT_ID)?.focus(),
    // Devices opens for an unlicensed install only where pairing can turn Pro on.
    ...(window.api.proEntitlementBootstrapEnabled
      ? {
          'pair-again': () =>
            window.dispatchEvent(new CustomEvent('og:navigate', { detail: 'devices' }))
        }
      : {}),
    ...(retry ? { retry } : {}),
    support: () => openExternal(`mailto:${SUPPORT_EMAIL}`)
  }
}

function LicenceActions({
  actions,
  retry
}: Readonly<{ actions: LicenceAction[]; retry?: () => void }>): React.ReactElement | null {
  const run = licenceActionRunners(retry)
  const shown = actions.filter((action) => run[action])
  if (!shown.length) return null
  return (
    <span className="flex flex-wrap gap-2">
      {shown.map((action, index) => (
        <Button
          key={action}
          size="sm"
          variant={index === 0 ? 'default' : 'outline'}
          onClick={() => run[action]?.()}
        >
          {LICENCE_ACTION_LABEL[action]}
        </Button>
      ))}
    </span>
  )
}

/**
 * Why Pro is off on this computer, and the way back: the license ended, or another device removed
 * this one. Nothing for someone who never had Pro. The line and its actions are the shared rule
 * (licenceLine) the phone and the browser extension draw too.
 */
export function LicenceNotice(): React.ReactElement | null {
  const [info, setInfo] = useState<ProLicenseInfo | null>(null)
  useEffect(() => {
    const license = window.api.license
    if (!license) return
    let active = true
    void license
      .status()
      .then((next) => active && setInfo(next))
      .catch(() => {})
    const off = license.onChanged((next) => active && setInfo(next))
    return () => {
      active = false
      off()
    }
  }, [])
  const line = info
    ? licenceLine({
        hasAccess: info.isPro,
        expiry: info.expiry,
        removedBy: info.removedBy ?? null,
        hadLicence: info.verifiedAt > 0
      })
    : null
  if (!line) return null
  return (
    <div
      role="status"
      data-testid="licence-notice"
      className="og-guide-in flex flex-col gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5"
    >
      <span className="text-xs leading-relaxed text-neutral-200">{line.text}</span>
      <LicenceActions actions={line.actions} />
    </div>
  )
}

function availableOnLinux(feature?: ProFeature): boolean {
  return !!feature && featureSupportsPlatform(feature, 'linux')
}

function linuxNoticeTitle(feature?: ProFeature): string {
  return feature
    ? 'This feature is coming soon to Linux.'
    : 'Some Pro features are coming soon to Linux.'
}

function showComingSoonBadge(comingSoon: boolean, linux: boolean, feature?: ProFeature): boolean {
  return comingSoon || (linux && !!feature && !availableOnLinux(feature))
}

// License-key activation. Only meaningful in a pro-capable build (__OFFGRID_PRO__);
// a core build has no pro code bundled, so entering a key would unlock nothing.
// Main and renderer lifecycle owners react to the saved entitlement, so activation
// completes in this process without a restart.
export function LicenseActivation(): React.ReactElement {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{
    kind: 'ok' | 'err'
    text: string
    actions?: LicenceAction[]
  } | null>(null)

  const activate = async (): Promise<void> => {
    const license = window.api.license
    if (!license || !key.trim()) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await license.activate(key.trim())
      if (r.ok) {
        setMsg({ kind: 'ok', text: 'Activated. Pro is starting.' })
      } else {
        const failure = projectPersonalMeshActivationFailure(r.reason)
        setMsg({
          kind: 'err',
          text: failure.description,
          actions: activationFailureActions(failure.code, failure.retryable)
        })
      }
    } catch {
      setMsg({ kind: 'err', text: 'Activation failed.', actions: ['retry', 'support'] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex w-full flex-col items-stretch gap-2">
      <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-neutral-500">
        <Key weight="bold" className="h-3.5 w-3.5" /> Already bought Pro? Enter your license key
      </label>
      <div className="flex gap-2">
        <input
          id={KEY_INPUT_ID}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && activate()}
          placeholder="key/..."
          spellCheck={false}
          autoCapitalize="off"
          className="flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder:text-neutral-600 focus:border-green-500/60 focus:outline-none"
        />
        <button
          onClick={activate}
          disabled={busy || !key.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <CircleNotch weight="bold" className="h-4 w-4 animate-spin" /> : 'Activate'}
        </button>
      </div>
      {msg && (
        <div
          className={`flex flex-wrap items-center justify-between gap-3 text-left text-xs ${
            msg.kind === 'ok'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-red-600 dark:text-red-400'
          }`}
        >
          <span>{msg.text}</span>
          {msg.actions ? (
            <LicenceActions actions={msg.actions} retry={() => void activate()} />
          ) : null}
        </div>
      )}
    </div>
  )
}

// Shown in the free build when a Pro tab is opened. Pro is launching soon — this
// writes up what the feature will do and points to early access (free waitlist)
// or paying now (lifetime free + first access). People who've already paid are
// reassured they're first in line.
export function UpgradeScreen({
  feature,
  variant = 'upgrade'
}: {
  feature?: ProFeature
  variant?: 'upgrade' | 'coming-soon'
}): React.ReactElement {
  const f = feature
  const comingSoon = variant === 'coming-soon'
  const linux = currentPlatform() === 'linux'
  const linuxFeatureAvailable = availableOnLinux(f)
  const linuxAvailable = PRO_FEATURES.filter(availableOnLinux)
    .map((item) => item.label)
    .join(', ')
  // Whether to warn a prospective buyer that Pro isn't fully live on their device
  // yet. Per-feature: if this writeup is for a specific feature, only warn when THAT
  // feature isn't ported here (so a Windows-ready feature like Vault shows no
  // warning). For the generic pitch, warn while any feature is still coming soon.
  const platformNotice = f
    ? !featureSupportsPlatform(f, currentPlatform())
    : PRO_FEATURES.some((x) => !featureSupportsPlatform(x, currentPlatform()))
  const open = (url: string): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).api
    if (api?.openExternal) api.openExternal(url)
    else window.open(url, '_blank')
  }
  // The upgrade funnel: this screen is the gate, and "Get Pro" opens the paywall.
  const gateFeature = f?.route ?? 'pro'
  useEffect(() => {
    flow.start('pro_upgrade')
    flow.step('pro_upgrade', 'gate_shown', gateFeature)
  }, [gateFeature])

  return (
    <PageShell
      className="font-mono"
      eyebrow={
        showComingSoonBadge(comingSoon, linux, f)
          ? 'Off Grid AI Pro · Coming soon'
          : `Off Grid AI Pro · ${linux && !f && platformNotice ? 'Available features' : 'Available now'}`
      }
      title={f ? f.label : linux ? 'Off Grid AI Pro on Linux' : 'Off Grid AI Pro is here'}
      description={f?.tagline}
    >
      <div className="grid grid-cols-1 items-start gap-x-12 gap-y-8 lg:grid-cols-[1.4fr_minmax(320px,1fr)]">
        {/* Left — the pitch (left-aligned, desktop reading column) */}
        <div className="flex flex-col gap-5">
          <p className="max-w-2xl text-sm leading-relaxed text-neutral-400">
            {f
              ? f.description
              : 'Pro adds the layer that sees, remembers, and acts — always on, it never forgets, makes everything findable with unified search, and a proactive secretary surfaces what matters and acts for you. Screen capture, your private CRM, meetings, and connectors included. All on-device.'}
          </p>

          {f && (
            <AnimatedGroup
              as="ul"
              asChild="li"
              preset="slide"
              className="grid gap-2 sm:grid-cols-2"
            >
              {f.highlights.map((h) => (
                <div key={h} className="flex items-start gap-2 text-sm text-neutral-300">
                  <Check
                    weight="bold"
                    className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                  />{' '}
                  {h}
                </div>
              ))}
            </AnimatedGroup>
          )}

          {/* Everything Pro includes — the other gated tabs */}
          <div className="mt-1 border-t border-neutral-800 pt-4">
            <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-600">
              Everything in Pro
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-neutral-500">
              {PRO_FEATURES.map((x) => (
                <span
                  key={x.route}
                  className={`flex items-center gap-1.5 ${x.route === f?.route ? 'text-emerald-600 dark:text-emerald-400' : ''}`}
                >
                  <span
                    className={`h-1 w-1 rounded-full ${x.route === f?.route ? 'bg-green-400' : 'bg-neutral-600'}`}
                  />
                  {x.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Right - account-aware action card, shared by upgrade and entitlement states. */}
        <aside className="flex flex-col gap-4 rounded-xl border border-neutral-800 bg-neutral-900/40 p-5 lg:sticky lg:top-0">
          {comingSoon ? (
            <>
              <div className="text-[10px] uppercase tracking-widest text-neutral-500">
                You have Pro
              </div>
              <p className="text-sm leading-relaxed text-neutral-300">
                {linux
                  ? `This feature is coming soon to Linux. ${linuxAvailable} are available now. Your license also works on Windows and macOS.`
                  : `Your license covers desktop and mobile - up to 5 devices. This feature is not on your ${deviceNoun()} yet.`}
              </p>
              <p className="text-[11px] leading-relaxed text-neutral-600">
                Core features work on your {deviceNoun()} today.
              </p>
              <div className="border-t border-neutral-800" />
              <button
                onClick={() => openExternal(withUtm(OFF_GRID_WEBSITE_URL, 'upgrade-website'))}
                className="group flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2.5 text-left transition-colors hover:border-green-500/30"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800 transition-colors group-hover:border-green-500/30">
                  <Desktop
                    weight="regular"
                    className="h-4 w-4 text-neutral-300 transition-colors group-hover:text-emerald-500"
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-neutral-200">
                    Use Pro on Windows, Linux, or macOS
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-tight text-neutral-500">
                    Install Off Grid AI Desktop on Windows, Linux, or macOS and use the same
                    license.
                  </span>
                </span>
                <ArrowSquareOut weight="bold" className="h-4 w-4 shrink-0 text-neutral-500" />
              </button>
            </>
          ) : (
            <>
              {/* State platform availability before offering a purchase. */}
              {platformNotice && (
                <div className="flex items-start gap-2 rounded-lg border border-neutral-700 bg-neutral-800/50 px-3 py-2.5 text-[11px] leading-relaxed text-neutral-300">
                  <Clock weight="fill" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400" />
                  <span>
                    <span className="font-medium text-neutral-200">
                      {linux ? linuxNoticeTitle(f) : `Coming soon to your ${deviceNoun()}.`}
                    </span>{' '}
                    {linux
                      ? `${linuxAvailable} are available on Linux now. Other Pro features are available on Windows and macOS.`
                      : 'This feature is available on Windows, Linux, and macOS.'}
                  </span>
                </div>
              )}
              <LicenceNotice />
              {(!linux || !f || linuxFeatureAvailable) && (
                <>
                  <div className="text-[10px] uppercase tracking-widest text-neutral-500">
                    Unlock Pro
                  </div>
                  <Button
                    size="lg"
                    className="w-full"
                    onClick={() => {
                      flow.step('pro_upgrade', 'paywall_viewed')
                      open(withUtm(PRO_PAY_URL, 'upgrade-screen'))
                    }}
                  >
                    Get Pro <ArrowSquareOut weight="bold" className="h-4 w-4" />
                  </Button>
                  <p className="text-[11px] leading-relaxed text-neutral-600">
                    One-time purchase. Runs on your device, with no subscription, no cloud and no
                    account.
                  </p>
                </>
              )}

              {__OFFGRID_PRO__ && (!linux || !f || linuxFeatureAvailable) ? (
                <>
                  <div className="border-t border-neutral-800" />
                  <LicenseActivation />
                </>
              ) : null}
            </>
          )}

          {/* Cross-sell: your Pro license spans both products. Mirrors mobile's
              "Get Off Grid AI Desktop" row on its Pro tab. */}
          <div className="border-t border-neutral-800" />
          <button
            onClick={() => openExternal(withUtm(OFF_GRID_MOBILE_URL, 'upgrade-mobile'))}
            className="group flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2.5 text-left transition-colors hover:border-green-500/30"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800 transition-colors group-hover:border-green-500/30">
              <DeviceMobile
                weight="regular"
                className="h-4 w-4 text-neutral-300 transition-colors group-hover:text-emerald-500"
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-neutral-200">
                {productAction({ product: 'mobile' }).label}
              </span>
              <span className="mt-0.5 block text-[11px] leading-tight text-neutral-500">
                {linux
                  ? 'Off Grid AI Mobile is available on your phone.'
                  : 'Your license covers your phone too. Install it, then scan the code in Sync to pair.'}
              </span>
            </span>
            <ArrowSquareOut weight="bold" className="h-4 w-4 shrink-0 text-neutral-500" />
          </button>
          {/* The browser extension is part of Pro: the store for this computer's default browser. */}
          <button
            onClick={() => void window.api.getExtension?.()}
            className="group flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2.5 text-left transition-colors hover:border-green-500/30"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800 transition-colors group-hover:border-green-500/30">
              <PuzzlePiece
                weight="regular"
                className="h-4 w-4 text-neutral-300 transition-colors group-hover:text-emerald-500"
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-neutral-200">
                {productAction({ product: 'extension' }).label}
              </span>
              <span className="mt-0.5 block text-[11px] leading-tight text-neutral-500">
                Chat, your vault and Scribe in your browser. Included in Pro.
              </span>
            </span>
            <ArrowSquareOut weight="bold" className="h-4 w-4 shrink-0 text-neutral-500" />
          </button>
        </aside>
      </div>
    </PageShell>
  )
}
