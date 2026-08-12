import { useState } from 'react'
import {
  ArrowSquareOut,
  Check,
  Sparkle,
  Key,
  CircleNotch,
  DeviceMobile,
  Clock,
  Desktop
} from '@phosphor-icons/react'
import { PRO_PAY_URL, PRO_FEATURES, featureSupportsPlatform, type ProFeature } from './proCatalog'
import { OFF_GRID_MOBILE_URL, OFF_GRID_WEBSITE_URL, openExternal } from '../../constants/links'
import { deviceNoun, currentPlatform } from '@renderer/lib/device'
import { projectPersonalMeshActivationFailure } from '@offgrid/sync'

// License-key activation. Only meaningful in a pro-capable build (__OFFGRID_PRO__);
// a core build has no pro code bundled, so entering a key would unlock nothing.
// On success the cached entitlement flips, but main-process pro features (tray,
// capture, CRM loops) only attach at boot — so we offer a relaunch.
function LicenseActivation(): React.ReactElement {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const activate = async (): Promise<void> => {
    const license = window.api.license
    if (!license || !key.trim()) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await license.activate(key.trim())
      if (r.ok) {
        setMsg({ kind: 'ok', text: 'Activated. Restart to finish unlocking Pro.' })
      } else {
        setMsg({
          kind: 'err',
          text: projectPersonalMeshActivationFailure(r.reason).description
        })
      }
    } catch {
      setMsg({ kind: 'err', text: 'Activation failed. Please try again.' })
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
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && activate()}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          spellCheck={false}
          autoCapitalize="characters"
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
          className={`flex items-center justify-between gap-3 text-left text-xs ${
            msg.kind === 'ok'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-red-600 dark:text-red-400'
          }`}
        >
          <span>{msg.text}</span>
          {msg.kind === 'ok' && (
            // Solid emerald, white text - the same treatment every other primary action in the app
            // uses. This was green-300 text on a transparent background behind a 40%-opacity border,
            // which is the lightest green in the scale on no fill at all: barely legible in dark mode
            // and worse in light. It is also the one action a person must find right after activating,
            // so it should read as the primary button it is.
            <button
              onClick={() => window.api.license?.relaunch()}
              className="shrink-0 rounded-md bg-emerald-600 px-2.5 py-1 font-medium text-white transition-colors duration-150 hover:bg-emerald-500 active:scale-95"
            >
              Restart now
            </button>
          )}
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

  return (
    <div className="h-full overflow-y-auto px-8 py-10 font-mono lg:px-12">
      <div className="mx-auto grid max-w-5xl grid-cols-1 items-start gap-x-12 gap-y-8 lg:grid-cols-[1.4fr_minmax(320px,1fr)]">
        {/* Left — the pitch (left-aligned, desktop reading column) */}
        <div className="flex flex-col gap-5">
          {comingSoon ? (
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-800/50 px-3 py-1 text-[11px] uppercase tracking-wide text-neutral-300">
              <Clock weight="fill" className="h-3.5 w-3.5" /> Off Grid AI Pro · Coming soon
            </span>
          ) : (
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-3 py-1 text-[11px] uppercase tracking-wide text-emerald-400">
              <Sparkle weight="fill" className="h-3.5 w-3.5" /> Off Grid AI Pro · Available now
            </span>
          )}

          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900/60">
              {f ? (
                <f.icon weight="duotone" className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Sparkle weight="duotone" className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
              )}
            </div>
            <div className="min-w-0">
              <h1 className="text-3xl font-semibold tracking-tight text-white">
                {f ? f.label : 'Off Grid AI Pro is here'}
              </h1>
              {f && <p className="mt-1 text-base text-neutral-300">{f.tagline}</p>}
            </div>
          </div>

          <p className="max-w-2xl text-sm leading-relaxed text-neutral-400">
            {f
              ? f.description
              : 'Pro adds the layer that sees, remembers, and acts — always on, it never forgets, makes everything findable with unified search, and a proactive secretary surfaces what matters and acts for you. Screen capture, your private CRM, meetings, and connectors included. All on-device.'}
          </p>

          {f && (
            <ul className="grid gap-2 sm:grid-cols-2">
              {f.highlights.map((h) => (
                <li key={h} className="flex items-start gap-2 text-sm text-neutral-300">
                  <Check weight="bold" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" /> {h}
                </li>
              ))}
            </ul>
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
        <aside className="flex flex-col gap-4 rounded-xl border border-neutral-800 bg-neutral-900/40 p-5 lg:sticky lg:top-10">
          {comingSoon ? (
            <>
              <div className="text-[10px] uppercase tracking-widest text-neutral-500">
                You have Pro
              </div>
              <p className="text-sm leading-relaxed text-neutral-300">
                Your license covers desktop and mobile - up to 5 devices.
                Windows is live and Pro features are arriving one at a time; this one is not on your{' '}
                {deviceNoun()} yet, and the ones that are work here today.
              </p>
              <p className="text-[11px] leading-relaxed text-neutral-600">
                Everything else in Off Grid works on your {deviceNoun()} today.
              </p>
              <div className="border-t border-neutral-800" />
              <button
                onClick={() => openExternal(OFF_GRID_WEBSITE_URL)}
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
                    Use Pro on your Mac
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-tight text-neutral-500">
                    Install Off Grid AI Desktop for Mac and use the same license.
                  </span>
                </span>
                <ArrowSquareOut weight="bold" className="h-4 w-4 shrink-0 text-neutral-500" />
              </button>
            </>
          ) : (
            <>
              {/* On a platform where this feature isn't live yet, keep the buy CTA
                  (the license is valid on Mac + phone today), but set expectations up
                  front so a user doesn't buy expecting it to run here. A feature that
                  IS ported to this platform (e.g. Vault on Windows) shows no notice. */}
              {platformNotice && (
                <div className="flex items-start gap-2 rounded-lg border border-neutral-700 bg-neutral-800/50 px-3 py-2.5 text-[11px] leading-relaxed text-neutral-300">
                  <Clock weight="fill" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400" />
                  <span>
                    <span className="font-medium text-neutral-200">
                      Coming soon to your {deviceNoun()}.
                    </span>{' '}
                    Windows is live and Pro features are arriving one at a time - this one runs on
                    Mac today. Your license covers desktop and mobile - up to 5 devices.
                  </span>
                </div>
              )}
              <div className="text-[10px] uppercase tracking-widest text-neutral-500">
                Unlock Pro
              </div>
              <button
                onClick={() => open(PRO_PAY_URL)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-green-500"
              >
                Get Pro <ArrowSquareOut weight="bold" className="h-4 w-4" />
              </button>
              <p className="text-[11px] leading-relaxed text-neutral-600">
                One-time purchase. Runs entirely on your device - no subscription, no cloud, no
                account.
              </p>

              {__OFFGRID_PRO__ ? (
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
            onClick={() => openExternal(OFF_GRID_MOBILE_URL)}
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
                Get Off Grid AI Mobile
              </span>
              <span className="mt-0.5 block text-[11px] leading-tight text-neutral-500">
                Your license covers your phone too - up to 5 devices, synced over your own network.
              </span>
            </span>
            <ArrowSquareOut weight="bold" className="h-4 w-4 shrink-0 text-neutral-500" />
          </button>
        </aside>
      </div>
    </div>
  )
}
