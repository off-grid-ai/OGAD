import { ArrowSquareOut, Check, Sparkle } from '@phosphor-icons/react';
import { PRO_PAY_URL, PRO_EARLY_ACCESS_URL, PRO_LAUNCH, PRO_FEATURES, type ProFeature } from './proCatalog';

// Shown in the free build when a Pro tab is opened. Pro is launching soon — this
// writes up what the feature will do and points to early access (free waitlist)
// or paying now (lifetime free + first access). People who've already paid are
// reassured they're first in line.
export function UpgradeScreen({ feature }: { feature?: ProFeature }): React.ReactElement {
  const f = feature;
  const open = (url: string): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).api;
    if (api?.openExternal) api.openExternal(url);
    else window.open(url, '_blank');
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-6 px-6 text-center font-mono">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-3 py-1 text-xs uppercase tracking-wide text-green-400">
        <Sparkle weight="fill" className="h-3.5 w-3.5" /> Off Grid Pro · Coming {PRO_LAUNCH}
      </span>

      {f ? (
        <>
          <div className="flex flex-col items-center gap-3">
            <f.icon weight="duotone" className="h-12 w-12 text-green-400" />
            <h1 className="text-2xl font-semibold text-white">{f.label}</h1>
            <p className="text-base text-neutral-300">{f.tagline}</p>
          </div>
          <p className="max-w-xl text-sm leading-relaxed text-neutral-400">{f.description}</p>
          <ul className="flex flex-col items-start gap-2 text-left">
            {f.highlights.map((h) => (
              <li key={h} className="flex items-start gap-2 text-sm text-neutral-300">
                <Check weight="bold" className="mt-0.5 h-4 w-4 shrink-0 text-green-400" /> {h}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <h1 className="text-2xl font-semibold text-white">Off Grid Pro lands {PRO_LAUNCH}</h1>
          <p className="max-w-xl text-sm leading-relaxed text-neutral-400">
            Pro adds the layer that sees, remembers, and acts — always on, it never forgets,
            makes everything findable with unified search, and a proactive secretary surfaces
            what matters and acts for you. Screen capture, your private CRM, meetings, and
            connectors included. All on-device.
          </p>
        </div>
      )}

      <div className="mt-2 flex flex-col items-center gap-3 sm:flex-row">
        <button
          onClick={() => open(PRO_EARLY_ACCESS_URL)}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-green-500"
        >
          Join early access <ArrowSquareOut weight="bold" className="h-4 w-4" />
        </button>
        <button
          onClick={() => open(PRO_PAY_URL)}
          className="inline-flex items-center gap-2 rounded-lg border border-neutral-700 px-5 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:border-green-500/60 hover:text-white"
        >
          Pay now — lock lifetime free <ArrowSquareOut weight="bold" className="h-4 w-4" />
        </button>
      </div>

      <p className="max-w-md text-xs leading-relaxed text-neutral-500">
        Already paid? You’re all set — stay tuned. Pro launches {PRO_LAUNCH} and you’ll be
        among the very first to get access.
      </p>

      <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-neutral-600">
        {PRO_FEATURES.map((x) => (
          <span key={x.route} className={x.route === f?.route ? 'text-green-400' : ''}>
            {x.label}
          </span>
        ))}
      </div>
    </div>
  );
}
