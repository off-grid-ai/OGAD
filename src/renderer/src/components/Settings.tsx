import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { LockKey } from '@phosphor-icons/react';
import { ProgressiveBlur } from './ui/progressive-blur';

// A Pro section shown (disabled) in the free build: title + description + a
// "Pro · July 2026" badge, dimmed and non-interactive.
function ProPlaceholder({ title, description, delay = 0.18 }: { title: string; description: string; delay?: number }): React.ReactElement {
  return (
    <motion.div
      className="relative rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6"
      initial={{ opacity: 0, filter: 'blur(10px)' }}
      animate={{ opacity: 1, filter: 'blur(0px)' }}
      transition={{ duration: 0.6, delay }}
    >
      <span className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-green-400">
        <LockKey weight="bold" className="h-3 w-3" /> Pro · July 2026
      </span>
      <h3 className="mb-1 pr-28 text-base font-medium text-neutral-300">{title}</h3>
      <p className="text-sm text-neutral-600">{description}</p>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Proactive delivery — let Off Grid reach out unprompted
// ---------------------------------------------------------------------------

function ProactiveSection(): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).api;
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    api.getSettings?.().then((s: Record<string, unknown>) => {
      // default ON unless explicitly disabled
      setEnabled(s?.['proactive:enabled'] !== false);
    });
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);
  const toggle = (): void => {
    const next = !enabled;
    setEnabled(next);
    api.saveSetting?.('proactive:enabled', next);
  };
  return (
    <motion.div
      className="rounded-2xl bg-neutral-900/60 backdrop-blur-sm border border-neutral-800 p-6"
      initial={{ opacity: 0, filter: 'blur(10px)' }}
      animate={{ opacity: 1, filter: 'blur(0px)' }}
      transition={{ duration: 0.6, delay: 0.18 }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-white font-medium text-base mb-1">Proactive delivery</h3>
          <p className="text-neutral-500 text-sm">
            Off Grid reaches out on its own — a morning briefing of your day and a heads-up ~20 min before each meeting with who’s in it and your open items. Delivered as native notifications, even when the window is closed.
          </p>
        </div>
        <button
          onClick={toggle}
          role="switch"
          aria-checked={enabled}
          className={`relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${enabled ? 'bg-emerald-500' : 'bg-neutral-700'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Secretary — what Off Grid has learned from your dismissals
// ---------------------------------------------------------------------------

function SecretaryPrefs(): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).api;
  const [doc, setDoc] = useState('');
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const load = (): void => {
    api.secretaryPrefsGet?.().then((p: { doc?: string; pendingFeedback?: number }) => {
      setDoc(p?.doc ?? '');
      setPending(p?.pendingFeedback ?? 0);
    });
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const refresh = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.secretaryPrefsDistill?.();
      if (r && typeof r.doc === 'string') setDoc(r.doc);
      load();
    } finally {
      setBusy(false);
    }
  };
  const clear = async (): Promise<void> => { await api.secretaryPrefsSet?.(''); setDoc(''); };

  return (
    <motion.div
      className="rounded-2xl bg-neutral-900/60 backdrop-blur-sm border border-neutral-800 p-6"
      initial={{ opacity: 0, filter: 'blur(10px)' }}
      animate={{ opacity: 1, filter: 'blur(0px)' }}
      transition={{ duration: 0.6, delay: 0.18 }}
    >
      <h3 className="text-white font-medium text-base mb-1">What Off Grid has learned</h3>
      <p className="text-neutral-500 text-sm mb-4">
        Preferences distilled from the reasons you give when you dismiss a suggestion. This is the only learned text fed back to the assistant — it refreshes about once an hour, and raw notes are never used directly.
      </p>
      {doc ? (
        <pre className="whitespace-pre-wrap rounded-xl border border-neutral-700/50 bg-neutral-800/40 p-3 font-mono text-sm leading-relaxed text-neutral-300">{doc}</pre>
      ) : (
        <p className="rounded-xl border border-neutral-700/50 bg-neutral-800/40 p-3 text-sm text-neutral-600">
          Nothing learned yet. When you dismiss a suggestion, tell Off Grid why — it generalizes the useful ones here.
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button onClick={refresh} disabled={busy} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-50">
          {busy ? 'Updating…' : `Update now${pending ? ` (${pending} new)` : ''}`}
        </button>
        {doc && (
          <button onClick={clear} className="rounded-lg px-3 py-1.5 text-xs text-neutral-500 hover:text-white">Clear</button>
        )}
      </div>
    </motion.div>
  );
}

type ConsoleStatus = Awaited<ReturnType<typeof window.api.consoleStatus>>;

const inputCls =
  'w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600';
const btnCls =
  'px-4 py-2 rounded-xl bg-neutral-800 border border-neutral-700 text-white text-sm font-medium disabled:opacity-50 hover:bg-neutral-700 transition-colors';

function ConsoleSection() {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<ConsoleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = (): void => {
    window.api.consoleStatus().then(setStatus);
  };
  useEffect(refresh, []);

  const connect = async (): Promise<void> => {
    if (!url.trim() || !token.trim()) return;
    setBusy(true);
    setError('');
    const res = await window.api.consoleEnroll(url.trim(), token.trim());
    setBusy(false);
    if (res.enrolled) {
      setToken('');
      refresh();
    } else {
      setError(res.error || 'enrollment failed');
    }
  };

  const disconnect = async (): Promise<void> => {
    await window.api.consoleDisconnect();
    refresh();
  };

  const syncNow = async (): Promise<void> => {
    setBusy(true);
    await window.api.consoleSyncNow();
    setBusy(false);
    refresh();
  };

  return (
    <motion.div
      className="rounded-2xl bg-neutral-900/60 backdrop-blur-sm border border-neutral-800 p-6"
      initial={{ opacity: 0, filter: 'blur(10px)' }}
      animate={{ opacity: 1, filter: 'blur(0px)' }}
      transition={{ duration: 0.6, delay: 0.4 }}
    >
      <h3 className="text-white font-medium text-base mb-1">Fleet Console</h3>
      <p className="text-neutral-500 text-sm mb-4">
        Optionally enroll this device in an Off Grid Console for org policy, fleet audit, and remote
        commands. The app stays fully local — this only adds reporting to a console you control.
      </p>

      {status?.enrolled ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <span className="text-neutral-500">Device</span>
            <span className="text-neutral-200 font-mono">{status.deviceId}</span>
            <span className="text-neutral-500">Console</span>
            <span className="text-neutral-200 truncate">{status.url}</span>
            <span className="text-neutral-500">Policy version</span>
            <span className="text-neutral-200">{status.policyVersion ?? '—'}</span>
            <span className="text-neutral-500">Queued events</span>
            <span className="text-neutral-200">{status.queued}</span>
          </div>
          {status.killed ? (
            <p className="rounded-lg bg-red-950/50 border border-red-900 px-3 py-2 text-sm text-red-300">
              Kill switch received from the console.
            </p>
          ) : null}
          <div className="flex gap-2">
            <button onClick={syncNow} disabled={busy} className={btnCls}>
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
            <button onClick={disconnect} className={btnCls}>
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Console URL — e.g. https://console.yourorg.com"
            className={inputCls}
          />
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Enrollment token"
            className={inputCls}
          />
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button onClick={connect} disabled={busy || !url || !token} className={btnCls}>
            {busy ? 'Enrolling…' : 'Connect'}
          </button>
        </div>
      )}
    </motion.div>
  );
}

export function Settings() {
  // Pro/core aware: the proactive / secretary / fleet-console sections are Pro
  // and are hidden in the free build.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isPro = !!(window as any).api?.isPro;
  const [idName, setIdName] = useState('');
  const [idEmail, setIdEmail] = useState('');

  // Load identity on mount (Pro only — the handler lives in the pro layer).
  useEffect(() => {
    if (!isPro) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.api as any).idGet?.().then((id: { name: string; email: string }) => {
      if (id) {
        setIdName(id.name || '');
        setIdEmail(id.email || '');
      }
    }).catch(() => {});
  }, [isPro]);

  const saveIdentity = (): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.api as any).idSet?.({ name: idName.trim(), email: idEmail.trim() });
  };

  return (
    <div className="relative h-full">
      <div className="absolute inset-0 overflow-y-auto pb-16">
        <motion.div
          className="flex flex-col gap-6 px-1"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          {/* Header */}
          <motion.div
            className="flex items-center gap-3"
            initial={{ opacity: 0, filter: 'blur(10px)' }}
            animate={{ opacity: 1, filter: 'blur(0px)' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <div className="h-10 w-10 rounded-xl bg-neutral-800 border border-neutral-700 flex items-center justify-center">
              <svg className="w-5 h-5 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Settings</h2>
              <p className="text-sm text-neutral-500">{isPro ? 'Who you are, what Off Grid has learned, and your devices' : 'Personalization & automation unlock with Pro'}</p>
            </div>
          </motion.div>

          {/* Identity — who you are (Pro: foundation for the act pillar) */}
          {isPro ? (
            <motion.div
              className="rounded-2xl bg-neutral-900/60 backdrop-blur-sm border border-neutral-800 p-6"
              initial={{ opacity: 0, filter: 'blur(10px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              transition={{ duration: 0.6, delay: 0.15 }}
            >
              <h3 className="text-white font-medium text-base mb-1">You</h3>
              <p className="text-neutral-500 text-sm mb-4">
                Tells Off Grid who “you” are — so it can tell your messages and commitments apart from everyone else’s. Used to attribute action items and to make sense of your email and calendar.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <input value={idName} onChange={(e) => setIdName(e.target.value)} onBlur={saveIdentity} placeholder="Your name" className="rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600" />
                <input value={idEmail} onChange={(e) => setIdEmail(e.target.value)} onBlur={saveIdentity} placeholder="you@email.com" className="rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600" />
              </div>
            </motion.div>
          ) : (
            <ProPlaceholder delay={0.15} title="You" description="Tell Off Grid who you are so it can attribute your messages, commitments, and calendar — part of the Pro intelligence layer." />
          )}

          {/* Pro sections — shown but disabled in the free build. */}
          {isPro ? <ProactiveSection /> : <ProPlaceholder title="Proactive delivery" description="A morning briefing and a heads-up before each meeting — native notifications, even when the window is closed." />}
          {isPro ? <SecretaryPrefs /> : <ProPlaceholder title="What Off Grid has learned" description="Preferences distilled from the suggestions you dismiss, fed back to your assistant so it gets sharper over time." />}
          {isPro ? <ConsoleSection /> : <ProPlaceholder title="Fleet Console" description="Optionally enroll this device in an Off Grid Console for org policy, fleet audit, and remote commands — fully local." />}
        </motion.div>
      </div>

      <ProgressiveBlur
        height="80px"
        position="bottom"
        className="pointer-events-none"
      />
    </div>
  );
}
