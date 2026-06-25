import { ArrowSquareOut, Check, Lock } from '@phosphor-icons/react';
import { PRO_PAY_URL, PRO_FEATURES, type ProFeature } from './proCatalog';

// Shown in the free build when a Pro tab is opened. Writes up what the feature
// does and sends the user to checkout. (When Pro is active, the real screen
// renders instead — see App.tsx / the pro view-router.)
export function UpgradeScreen({ feature }: { feature?: ProFeature }): React.ReactElement {
  const f = feature;
  const openPay = (): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).api;
    if (api?.openExternal) api.openExternal(PRO_PAY_URL);
    else window.open(PRO_PAY_URL, '_blank');
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-6 px-6 text-center font-mono">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-3 py-1 text-xs uppercase tracking-wide text-green-400">
        <Lock weight="bold" className="h-3.5 w-3.5" /> Off Grid Pro
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
          <h1 className="text-2xl font-semibold text-white">Unlock Off Grid Pro</h1>
          <p className="max-w-xl text-sm leading-relaxed text-neutral-400">
            Pro adds the layer that sees, remembers, and acts: screen capture, your private
            CRM, Day &amp; Reflect, meeting recording, connectors in chat, a proactive secretary,
            and automations — all on-device.
          </p>
        </div>
      )}

      <button
        onClick={openPay}
        className="mt-2 inline-flex items-center gap-2 rounded-lg bg-green-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-green-500"
      >
        Upgrade to Pro <ArrowSquareOut weight="bold" className="h-4 w-4" />
      </button>

      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-neutral-600">
        {PRO_FEATURES.map((x) => (
          <span key={x.route} className={x.route === f?.route ? 'text-green-400' : ''}>
            {x.label}
          </span>
        ))}
      </div>
    </div>
  );
}
