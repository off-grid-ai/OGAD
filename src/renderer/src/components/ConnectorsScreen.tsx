import { useEffect, useState, useCallback } from 'react';
import { IconLoader2, IconPlug, IconPlus, IconTrash, IconPlugConnected, IconAlertTriangle, IconCircleCheck, IconRefresh, IconChevronRight, IconChevronLeft } from '@tabler/icons-react';
import { CONNECTOR_CATALOG, CATEGORY_ORDER, type CatalogEntry } from './connectorCatalog';
import slackLogo from '@/assets/logos/slack.svg';

// Brands Simple Icons dropped (trademark) → bundled local logos, keyed by catalog id.
const LOGO_OVERRIDE: Record<string, string> = { slack: slackLogo };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api;

interface Connector {
  id: number;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string | null;
  url: string | null;
  enabled: number;
  status: string;
  status_detail: string | null;
  tools: string | null;
  last_synced: number | null;
  synced_count: number | null;
}

// Simple Icons slugs → real brand logos via CDN. Missing/removed ones fall back
// to the colored letter badge. (Logos are UI chrome, not user data.)
const LOGO_SLUGS: Record<string, string> = {
  gmail: 'gmail', 'google-calendar': 'googlecalendar', outlook: 'microsoftoutlook', slack: 'slack',
  discord: 'discord', zoom: 'zoom', whatsapp: 'whatsapp', notion: 'notion', confluence: 'confluence',
  coda: 'coda', obsidian: 'obsidian', linear: 'linear', jira: 'jira', asana: 'asana', clickup: 'clickup',
  trello: 'trello', monday: 'mondaydotcom', shortcut: 'shortcut', github: 'github', gitlab: 'gitlab',
  sentry: 'sentry', vercel: 'vercel', cloudflare: 'cloudflare', stripe: 'stripe', pagerduty: 'pagerduty',
  postgres: 'postgresql', figma: 'figma', canva: 'canva', posthog: 'posthog', amplitude: 'amplitude',
  mixpanel: 'mixpanel', intercom: 'intercom', hubspot: 'hubspot', salesforce: 'salesforce', attio: 'attio',
  'google-drive': 'googledrive', airtable: 'airtable', dropbox: 'dropbox', zapier: 'zapier',
};

// How to obtain credentials for token-based connectors (shown in the connect form).
const SETUP_HINTS: Record<string, string> = {
  slack: 'Create a Slack app, add bot scopes (channels:read, chat:write, search:read), install it to your workspace, then copy the Bot User OAuth Token (xoxb-…) and your Team ID (T…).',
  discord: 'Discord Developer Portal → New Application → Bot → Reset/Copy Token. Enable the Message Content intent.',
  whatsapp: 'Runs a local WhatsApp bridge. On first connect it shows a QR — scan it in WhatsApp → Linked Devices. Paste the session/config path it gives you.',
  coda: 'Coda → Account Settings → API Settings → Generate API token.',
  obsidian: 'Enter the absolute path to your Obsidian vault folder (e.g. /Users/you/Vault).',
  clickup: 'ClickUp → Settings → Apps → Generate (personal API token).',
  trello: 'Get your API key and token from https://trello.com/app-key.',
  shortcut: 'Shortcut → Settings → API Tokens → Generate Token.',
  github: 'GitHub → Settings → Developer settings → Personal access tokens → generate one (repo + read:org scopes).',
  gitlab: 'GitLab → Preferences → Access Tokens → create one with the “api” scope.',
  postgres: 'Paste a (read-only) connection string: postgres://user:password@host:5432/dbname.',
  amplitude: 'Amplitude → Settings → Projects → copy the API Key.',
  mixpanel: 'Mixpanel → Project Settings → Service Accounts → create one.',
  airtable: 'Airtable → Builder Hub → Personal access tokens → create a token (pat…) with the scopes/bases you need.',
};

// Turn raw transport errors into something human.
function cleanError(detail: string): string {
  const d = detail || '';
  if (/invalid_token|Missing or invalid access token|401|unauthorized|Authorization required/i.test(d)) return 'Sign-in required — click Test to authorize in your browser.';
  if (/<!DOCTYPE html|<html|404|not found/i.test(d)) return 'Endpoint not reachable.';
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(d)) return 'Could not reach the server.';
  return d.length > 140 ? d.slice(0, 140) + '…' : d;
}

function Badge({ id, color, letter }: { id: string; color: string; letter: string }): React.ReactElement {
  const slug = LOGO_SLUGS[id];
  const override = LOGO_OVERRIDE[id];
  const [failed, setFailed] = useState(false);
  const src = override ?? (slug ? `https://cdn.simpleicons.org/${slug}` : '');
  if (src && !failed) {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center">
        <img src={src} alt="" className="h-7 w-7 object-contain" onError={() => setFailed(true)} />
      </div>
    );
  }
  const dark = color.toLowerCase() === '#ffffff';
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-bold" style={{ backgroundColor: color, color: dark ? '#111' : '#fff' }}>
      {letter}
    </div>
  );
}

export function ConnectorsScreen() {
  const [items, setItems] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [syncMsg, setSyncMsg] = useState<string>('');
  const [queries, setQueries] = useState<Record<number, string>>({});
  const [detailId, setDetailId] = useState<number | null>(null);
  const [tab, setTab] = useState<'all' | 'connected' | 'disconnected'>('all');
  const [syncedItems, setSyncedItems] = useState<{ id: number; summary: string; ts: string; url: string | null }[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [errorFor, setErrorFor] = useState<Record<string, string>>({});
  const [tokenFor, setTokenFor] = useState<CatalogEntry | null>(null);
  const [tokenVals, setTokenVals] = useState<Record<string, string>>({});

  // custom form
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems((await api.mcpList?.()) ?? []);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const installed = new Set(items.map((i) => i.name.toLowerCase()));
  const gallery = CONNECTOR_CATALOG.filter((e) => !installed.has(e.name.toLowerCase()));

  const doConnect = async (entry: CatalogEntry, secretVals: Record<string, string>): Promise<void> => {
    setConnecting(entry.id);
    setErrorFor((p) => ({ ...p, [entry.id]: '' }));
    let id: number | undefined;
    try {
      id = await api.mcpAdd?.({
        name: entry.name,
        transport: entry.transport,
        url: entry.url,
        command: entry.command,
        args: entry.args,
        envKeys: entry.secrets?.map((s) => s.key),
      });
      for (const [k, v] of Object.entries(secretVals)) {
        if (v && id != null) await api.secretsSet?.(`connector:${id}:${k}`, v);
      }
      const res = await api.mcpTest?.(id);
      if (res?.ok) {
        // Truly connected → it moves into "Connected" and out of the gallery.
        setTokenFor(null);
        setTokenVals({});
      } else {
        // Not connected — roll back so it doesn't litter "Connected"; show error here.
        if (id != null) await api.mcpRemove?.(id);
        setErrorFor((p) => ({ ...p, [entry.id]: cleanError(res?.error ?? 'Could not connect') }));
      }
    } catch (e) {
      if (id != null) await api.mcpRemove?.(id);
      setErrorFor((p) => ({ ...p, [entry.id]: e instanceof Error ? e.message : 'Could not connect' }));
    } finally {
      setConnecting(null);
      load();
    }
  };

  const onConnect = (entry: CatalogEntry): void => {
    if (entry.auth === 'token' && entry.secrets?.length) {
      setTokenFor(entry);
      setTokenVals({});
    } else {
      void doConnect(entry, {});
    }
  };

  const addCustom = async (): Promise<void> => {
    if (!name.trim()) return;
    await api.mcpAdd?.({
      name: name.trim(),
      transport,
      url: transport === 'http' ? url.trim() : undefined,
      command: transport === 'stdio' ? command.trim() : undefined,
      args: transport === 'stdio' && args.trim() ? args.trim().split(/\s+/) : undefined,
    });
    setName(''); setUrl(''); setCommand(''); setArgs(''); setAdding(false);
    load();
  };

  const test = async (id: number): Promise<void> => {
    setTestingId(id);
    try {
      await api.mcpTest?.(id);
    } finally {
      setTestingId(null);
      load();
    }
  };
  const toggle = async (id: number, enabled: boolean): Promise<void> => { await api.mcpSetEnabled?.(id, enabled); load(); };
  const remove = async (id: number): Promise<void> => { await api.mcpRemove?.(id); load(); };
  const sync = async (id: number, query?: string): Promise<void> => {
    setSyncingId(id);
    setSyncMsg('');
    try {
      const res = await api.mcpIngest?.(id, query);
      if (res && !res.ok) setSyncMsg(res.error ?? 'Sync failed');
      else if (res && res.count === 0) setSyncMsg('Synced — nothing new found.');
      else if (res) setSyncMsg(`Synced ${res.count} item${res.count === 1 ? '' : 's'}.`);
    } finally {
      setSyncingId(null);
      load();
      const c = items.find((x) => x.id === id);
      if (c) setSyncedItems((await api.mcpItems?.(c.name)) ?? []);
    }
  };
  const openDetail = async (c: Connector): Promise<void> => {
    setDetailId(c.id);
    setSyncedItems((await api.mcpItems?.(c.name)) ?? []);
  };
  const fmtAgo = (ms: number | null): string => {
    if (!ms) return 'never';
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  return (
    <div className="flex h-full flex-col bg-neutral-950 font-mono">
      <div className="flex items-center justify-between border-b border-neutral-900 px-6 py-4">
        <div className="flex items-center gap-3">
          <IconPlug className="h-5 w-5 text-green-500" />
          <div>
            <h1 className="text-lg tracking-tight text-white">Integrations</h1>
            <div className="text-[11px] uppercase tracking-wide text-neutral-600">Connect a tool · authorized actions run only after approval</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {detailId == null && (
            <div className="flex items-center gap-0.5 rounded-full border border-neutral-800 p-0.5">
              {(['all', 'connected', 'disconnected'] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} className={`rounded-full px-3 py-1 text-xs capitalize transition-colors ${tab === t ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-white'}`}>
                  {t} {t === 'connected' && items.length > 0 && <span className="text-neutral-500">{items.length}</span>}
                </button>
              ))}
            </div>
          )}
          <button onClick={() => setAdding((v) => !v)} className="flex items-center gap-1 rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:border-green-500 hover:text-green-500">
            <IconPlus className="h-4 w-4" /> Custom
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {(() => {
          const detail = detailId != null ? items.find((c) => c.id === detailId) : null;
          if (detail) {
            const dcat = CONNECTOR_CATALOG.find((x) => x.name === detail.name);
            const dtools = detail.tools ? (JSON.parse(detail.tools) as { name: string; description?: string }[]) : [];
            return (
              <div className="mx-auto max-w-[1500px] space-y-5">
                <button onClick={() => { setDetailId(null); load(); }} className="flex items-center gap-1 text-xs text-neutral-400 hover:text-white"><IconChevronLeft className="h-4 w-4" /> All integrations</button>
                <div className="flex items-start gap-3">
                  {dcat ? <Badge id={dcat.id} color={dcat.color} letter={dcat.letter} /> : <div className="h-9 w-9 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg tracking-tight text-white">{detail.name}</h2>
                      {detail.status === 'ok' ? <span className="text-[11px] text-green-500">connected</span> : detail.status === 'error' ? <span className="text-[11px] text-red-400">error</span> : <span className="text-[11px] text-neutral-600">not tested</span>}
                    </div>
                    <div className="truncate text-[11px] text-neutral-500">{detail.transport === 'http' ? detail.url : `${detail.command ?? ''} ${detail.args ? (JSON.parse(detail.args) as string[]).join(' ') : ''}`}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button onClick={() => test(detail.id)} disabled={testingId === detail.id} className="flex items-center gap-1 rounded-md border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:border-green-500 hover:text-green-500 disabled:opacity-50">{testingId === detail.id ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> : <IconPlugConnected className="h-3.5 w-3.5" />} Test</button>
                    <button onClick={() => toggle(detail.id, !detail.enabled)} className={`rounded-md px-2.5 py-1 text-xs ${detail.enabled ? 'text-green-500' : 'text-neutral-500'} hover:bg-neutral-800`}>{detail.enabled ? 'On' : 'Off'}</button>
                    <button onClick={async () => { await remove(detail.id); setDetailId(null); }} className="rounded-md p-1 text-neutral-600 hover:text-red-400"><IconTrash className="h-4 w-4" /></button>
                  </div>
                </div>
                {detail.status === 'error' && detail.status_detail && <p className="text-[11px] text-red-400/80">{cleanError(detail.status_detail)}</p>}

                {detail.status === 'ok' && (
                  <div className="flex items-center gap-2">
                    <button onClick={() => sync(detail.id)} disabled={syncingId === detail.id} className="flex items-center gap-1 rounded-md bg-green-500/90 px-3 py-1.5 text-xs text-neutral-950 hover:bg-green-400 disabled:opacity-50">{syncingId === detail.id ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> : <IconRefresh className="h-3.5 w-3.5" />} Sync recent</button>
                    <input value={queries[detail.id] ?? ''} onChange={(e) => setQueries((p) => ({ ...p, [detail.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter' && queries[detail.id]?.trim()) sync(detail.id, queries[detail.id]); }} placeholder={`Ask ${detail.name} for… (e.g. ABSLI)`} className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-200 outline-none focus:border-neutral-600" />
                    <button onClick={() => sync(detail.id, queries[detail.id])} disabled={syncingId === detail.id || !queries[detail.id]?.trim()} className="shrink-0 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-green-500 hover:text-green-500 disabled:opacity-40">Pull</button>
                  </div>
                )}
                {syncMsg && <p className="text-[11px] leading-relaxed text-neutral-400">{syncMsg}</p>}

                <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                  {/* Synced data — the meat (wide) */}
                  <section className="lg:col-span-2">
                    <h3 className="mb-2 text-[11px] uppercase tracking-wide text-neutral-500">Synced data · {detail.synced_count ?? 0} items</h3>
                    {syncedItems.length === 0 ? (
                      <p className="text-xs text-neutral-600">Nothing yet — hit Sync, or Pull something specific.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {syncedItems.map((it) => (
                          <div key={it.id} className="flex items-start gap-2 text-xs">
                            <span className="shrink-0 text-neutral-600">{it.ts.slice(5, 16)}</span>
                            {it.url ? <a href={it.url} target="_blank" rel="noreferrer" className="text-green-500 hover:underline">{it.summary} ↗</a> : <span className="text-neutral-300">{it.summary}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* Tools (narrow side column) */}
                  {dtools.length > 0 && (
                    <section className="lg:col-span-1">
                      <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-neutral-500">Tools · {dtools.length}</h3>
                      <div className="flex flex-wrap gap-1">{dtools.map((t) => <span key={t.name} title={t.description} className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">{t.name}</span>)}</div>
                    </section>
                  )}
                </div>
              </div>
            );
          }
          return (
            <div className="mx-auto max-w-[1600px] space-y-8">
          {/* Custom (advanced) form */}
          {adding && (
            <div className="space-y-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-4">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600" />
              <div className="flex w-fit items-center gap-0.5 rounded-full border border-neutral-800 p-0.5">
                {(['http', 'stdio'] as const).map((t) => (
                  <button key={t} onClick={() => setTransport(t)} className={`rounded-full px-3 py-1 text-xs transition-colors ${transport === t ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-white'}`}>{t === 'http' ? 'HTTP / SSE' : 'stdio (local)'}</button>
                ))}
              </div>
              {transport === 'http' ? (
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/endpoint" className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600" />
              ) : (
                <>
                  <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="command (e.g. npx)" className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600" />
                  <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="args" className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600" />
                </>
              )}
              <div className="flex gap-2">
                <button onClick={addCustom} className="rounded-md bg-green-500 px-3 py-1.5 text-xs text-neutral-950 hover:bg-green-400">Add</button>
                <button onClick={() => setAdding(false)} className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300">Cancel</button>
              </div>
            </div>
          )}

          {/* CATALOG GALLERY — grouped by category (Disconnected) */}
          {tab !== 'connected' && CATEGORY_ORDER.map((cat) => {
            const entries = gallery.filter((e) => e.category === cat);
            if (entries.length === 0) return null;
            return (
              <section key={cat}>
                <h2 className="mb-3 text-[11px] uppercase tracking-wide text-neutral-500">{cat}</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                  {entries.map((e) => (
                    <div key={e.id} className={`flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-4 ${!e.ready ? 'opacity-55' : ''}`}>
                      <div className="flex items-start gap-3">
                        <Badge id={e.id} color={e.color} letter={e.letter} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm text-neutral-100">{e.name}</span>
                            {!e.ready && <span className="rounded-sm bg-neutral-800 px-1 py-0.5 text-[9px] uppercase tracking-wide text-neutral-500">disabled</span>}
                          </div>
                          <p className="truncate text-[11px] text-neutral-500">{e.blurb}</p>
                        </div>
                      </div>
                      {!e.ready ? (
                        <div className="rounded-md border border-neutral-800 py-1.5 text-center text-xs text-neutral-600">Not enabled yet</div>
                      ) : tokenFor?.id === e.id ? (
                        <div className="space-y-2">
                          {(SETUP_HINTS[e.id] || e.docsUrl) && (
                            <p className="text-[11px] leading-relaxed text-neutral-500">
                              {SETUP_HINTS[e.id]}{' '}
                              {e.docsUrl && (
                                <a href={e.docsUrl} target="_blank" rel="noreferrer" className="text-green-500 hover:underline">
                                  How to get this →
                                </a>
                              )}
                            </p>
                          )}
                          {e.secrets?.map((s) => (
                            <input
                              key={s.key}
                              type="password"
                              value={tokenVals[s.key] ?? ''}
                              onChange={(ev) => setTokenVals((p) => ({ ...p, [s.key]: ev.target.value }))}
                              placeholder={s.label + (s.placeholder ? ` (${s.placeholder})` : '')}
                              className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-200 outline-none focus:border-neutral-600"
                            />
                          ))}
                          <div className="flex gap-2">
                            <button onClick={() => doConnect(e, tokenVals)} className="rounded-md bg-green-500 px-2.5 py-1 text-xs text-neutral-950 hover:bg-green-400">Connect</button>
                            <button onClick={() => setTokenFor(null)} className="rounded-md border border-neutral-700 px-2.5 py-1 text-xs text-neutral-400">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <button
                            onClick={() => onConnect(e)}
                            disabled={connecting === e.id}
                            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-neutral-700 py-1.5 text-xs text-neutral-200 hover:border-green-500 hover:text-green-500 disabled:opacity-60"
                          >
                            {connecting === e.id ? (
                              <><IconLoader2 className="h-3.5 w-3.5 animate-spin" /> {e.auth === 'oauth' ? 'Authorize in browser…' : 'Connecting…'}</>
                            ) : (
                              <><IconPlugConnected className="h-3.5 w-3.5" /> Connect{e.auth === 'oauth' ? ' with OAuth' : ''}</>
                            )}
                          </button>
                          {errorFor[e.id] && <p className="text-[11px] leading-relaxed text-red-400/80">{errorFor[e.id]}</p>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}

          {/* INSTALLED (Connected) */}
          {tab !== 'disconnected' && (
          <section>
            <h2 className="mb-3 text-[11px] uppercase tracking-wide text-neutral-500">Connected</h2>
            {loading && items.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-neutral-600"><IconLoader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            ) : items.length === 0 ? (
              <p className="py-8 text-sm text-neutral-600">Nothing connected yet. Pick one above.</p>
            ) : (
              <div className="space-y-2">
                {items.map((c) => {
                  const cat = CONNECTOR_CATALOG.find((x) => x.name === c.name);
                  return (
                    <button key={c.id} onClick={() => openDetail(c)} className="flex w-full items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-left transition-colors hover:border-neutral-700">
                      {cat ? <Badge id={cat.id} color={cat.color} letter={cat.letter} /> : <div className="h-9 w-9 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-neutral-100">{c.name}</span>
                          {c.status === 'ok' ? (
                            <span className="flex items-center gap-1 text-[11px] text-green-500"><IconCircleCheck className="h-3.5 w-3.5" /> connected</span>
                          ) : c.status === 'error' ? (
                            <span className="flex items-center gap-1 text-[11px] text-red-400"><IconAlertTriangle className="h-3.5 w-3.5" /> error</span>
                          ) : (
                            <span className="text-[11px] text-neutral-600">not tested</span>
                          )}
                        </div>
                        <div className="text-[11px] text-neutral-500">{c.synced_count ?? 0} items synced · last {fmtAgo(c.last_synced)}</div>
                      </div>
                      <IconChevronRight className="h-4 w-4 shrink-0 text-neutral-600" />
                    </button>
                  );
                })}
              </div>
            )}
          </section>
          )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
