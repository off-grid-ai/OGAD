import { IconLock } from '@tabler/icons-react'
import { PageShell } from './PageShell'
import { FEATURE_GROUPS, PRO_FEATURES, featureSupportsPlatform } from './pro/proCatalog'
import { currentPlatform } from '@renderer/lib/device'
import type { ViewMode } from '@renderer/lib/view-modes'

/**
 * "What it does for you": every feature, grouped by the job it does, each with its name, its
 * one-line pitch and a way in. Opened from the info button beside Back, so it is never hidden.
 * The copy is the catalog's (proCatalog), the one place it lives.
 */
export function FeatureGuide({
  isPro,
  onOpen
}: Readonly<{ isPro: boolean; onOpen: (view: ViewMode) => void }>): React.ReactElement {
  const platform = currentPlatform()
  const features = PRO_FEATURES.filter((f) => featureSupportsPlatform(f, platform))
  return (
    <PageShell
      title="What it does for you"
      eyebrow="Off Grid AI"
      description="Everything runs on this computer. Open anything below to try it."
    >
      <div className="grid gap-x-8 gap-y-8 pb-10 md:grid-cols-2 xl:grid-cols-3">
        {FEATURE_GROUPS.map((group) => {
          const inGroup = features.filter((f) => f.group === group.id)
          if (inGroup.length === 0) return null
          return (
            <section key={group.id} aria-labelledby={`guide-${group.id}`}>
              <h2
                id={`guide-${group.id}`}
                className="pb-2 font-mono text-[10px] uppercase tracking-widest text-neutral-500"
              >
                {group.title}
              </h2>
              <ul className="grid gap-2">
                {inGroup.map((f) => (
                  <li key={f.route}>
                    <button
                      type="button"
                      onClick={() => onOpen(f.route as ViewMode)}
                      className="flex w-full items-center gap-3 rounded-lg border border-neutral-800 bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:border-green-500/60"
                    >
                      <f.icon className="h-5 w-5 shrink-0 text-neutral-400" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-neutral-100">{f.label}</span>
                        <span className="block text-xs text-neutral-500">{f.tagline}</span>
                      </span>
                      {isPro ? null : (
                        <IconLock className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-label="Pro" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </PageShell>
  )
}
