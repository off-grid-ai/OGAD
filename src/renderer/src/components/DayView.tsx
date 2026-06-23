import { useEffect, useState, useCallback } from 'react';
import { IconChevronLeft, IconChevronRight, IconCalendar, IconLoader2, IconRefresh, IconCircleCheck, IconClock, IconMapPin, IconExternalLink, IconSparkles, IconCheck, IconX, IconBolt, IconChevronDown, IconListDetails } from '@tabler/icons-react';
import { ProvenanceBlock } from './ProvenanceBlock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api;

// Where a "View all" link can take the user — handled by the parent (App).
type NavTarget = 'actions' | 'replay';
type Navigate = (view: NavTarget, opts?: { mode?: 'todo' | 'approvals' }) => void;

interface Block {
  startSec: number;
  endSec: number;
  surface: string;
  summaries: string[];
  entities: { id: number; name: string; type: string }[];
  count: number;
}

interface UpcomingEvent { id: number; title: string; starts_at: number | null; ends_at: number | null; location: string | null; attendees: string | null; url: string | null }
interface Priority { id: number; text: string; due: string | null; entityName: string | null; sourceApp: string | null }
interface AheadView { now: number; upcoming: UpcomingEvent[]; priorities: Priority[] }
interface EventPrep {
  people: { id: number; name: string; type: string; summary: string | null }[];
  recent: { summary: string; surface: string; ts: string }[];
  openItems: { id: number; text: string; due: string | null }[];
}
interface Proposal { id: number; title: string; detail: string | null; connector: string | null; tool: string | null; args: string | null; status: string }

const SUGGEST_CAP = 3;
const TODO_CAP = 6;

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const fmtTime = (sec: number): string => new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function fmtDur(secs: number): string {
  const m = Math.max(1, Math.round(secs / 60));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Consistent section label — tiny, uppercase, muted, emerald icon. The rhythm
// marker for every block so the screen reads as one system. `right` holds the
// optional "View all" link.
function Label({ icon: Icon, children, right }: { icon: typeof IconBolt; children: React.ReactNode; right?: React.ReactNode }): React.ReactElement {
  return (
    <div className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-wide text-neutral-500">
      <Icon className="h-3.5 w-3.5 text-green-500" aria-hidden />
      {children}
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

function ViewAll({ n, onClick }: { n: number; onClick: () => void }): React.ReactElement {
  return (
    <button onClick={onClick} className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500 hover:text-green-500">
      View all {n} <span aria-hidden>→</span>
    </button>
  );
}

// "Your day" — the synthesized briefing (LLM over calendar + to-dos + email).
function DayPlan(): React.ReactElement | null {
  const [plan, setPlan] = useState('');
  const [loading, setLoading] = useState(false);
  const regen = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const p = (await api.crmDayPlan?.()) ?? '';
      if (p) setPlan(p);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = (await api.crmDayPlanCached?.()) ?? '';
      if (!cancelled) setPlan(cached);
      regen();
    })();
    return () => { cancelled = true; };
  }, [regen]);

  if (!plan && !loading) return null;
  return (
    <div>
      <Label
        icon={IconSparkles}
        right={
          <button onClick={regen} disabled={loading} aria-label="Re-plan the day" title="Re-plan" className="text-neutral-600 hover:text-green-500">
            {loading ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> : <IconRefresh className="h-3.5 w-3.5" />}
          </button>
        }
      >
        Your day
      </Label>
      {plan ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-300">{plan}</p>
      ) : (
        <div className="flex items-center gap-2 text-xs text-neutral-500"><IconLoader2 className="h-4 w-4 animate-spin" /> Planning your day…</div>
      )}
    </div>
  );
}

// Today's calendar — the right rail. Each event opens in Google Calendar and
// expands into prep (who, recently discussed, open items) from on-device memory.
function Calendar({ events }: { events: UpcomingEvent[] }): React.ReactElement {
  const [prepFor, setPrepFor] = useState<number | null>(null);
  const [prep, setPrep] = useState<EventPrep | null>(null);
  const [prepLoading, setPrepLoading] = useState(false);

  const openInCalendar = (e: UpcomingEvent): void => { if (e.url) window.open(e.url, '_blank'); };
  const togglePrep = async (e: UpcomingEvent): Promise<void> => {
    if (prepFor === e.id) { setPrepFor(null); setPrep(null); return; }
    setPrepFor(e.id);
    setPrep(null);
    setPrepLoading(true);
    try {
      const attendees = (e.attendees ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      setPrep((await api.crmEventPrep?.(e.title, attendees)) ?? null);
    } finally {
      setPrepLoading(false);
    }
  };

  return (
    <div>
      <Label icon={IconCalendar}>Today’s meetings</Label>
      {events.length === 0 ? (
        <p className="text-xs text-neutral-600">Nothing left on your calendar today.</p>
      ) : (
        <div className="space-y-1.5">
          {events.map((e) => (
            <div key={e.id} className="overflow-hidden rounded-md border border-neutral-800 bg-neutral-900/40 transition-colors hover:border-neutral-700">
              <div className="group flex items-start gap-3 px-3 py-2">
                <div className="w-14 shrink-0 pt-0.5 text-[11px] tabular-nums text-neutral-400">{e.starts_at ? fmtTime(e.starts_at) : '—'}</div>
                <button onClick={() => openInCalendar(e)} disabled={!e.url} className="min-w-0 flex-1 text-left disabled:cursor-default" title={e.url ? 'Open in Google Calendar' : undefined}>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm text-neutral-100 group-hover:text-white">{e.title}</span>
                    {e.url && <IconExternalLink className="h-3 w-3 shrink-0 text-neutral-600 group-hover:text-green-500" />}
                  </div>
                  {e.location && (
                    <div className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-neutral-500">
                      <IconMapPin className="h-3 w-3 shrink-0" /> {e.location}
                    </div>
                  )}
                </button>
                <button onClick={() => togglePrep(e)} aria-label="Toggle prep" className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${prepFor === e.id ? 'text-green-500' : 'text-neutral-500 hover:text-white'}`}>
                  Prep {prepFor === e.id ? '▴' : '▾'}
                </button>
              </div>
              {prepFor === e.id && (
                <div className="border-t border-neutral-800 bg-neutral-950/40 px-3 py-2.5">
                  {prepLoading ? (
                    <div className="flex items-center gap-2 text-xs text-neutral-500"><IconLoader2 className="h-3.5 w-3.5 animate-spin" /> Pulling context…</div>
                  ) : prep && (prep.people.length || prep.recent.length || prep.openItems.length) ? (
                    <div className="space-y-3 text-xs">
                      {prep.people.length > 0 && (
                        <div>
                          <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-600">Who</div>
                          <div className="space-y-1">
                            {prep.people.map((p) => (
                              <div key={p.id}><span className="text-green-500">{p.name}</span>{p.summary && <span className="text-neutral-400"> — {p.summary}</span>}</div>
                            ))}
                          </div>
                        </div>
                      )}
                      {prep.recent.length > 0 && (
                        <div>
                          <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-600">Recently discussed</div>
                          <div className="space-y-1">
                            {prep.recent.slice(0, 6).map((r, i) => (
                              <div key={i} className="text-neutral-400"><span className="text-neutral-600">{r.surface} · </span>{r.summary}</div>
                            ))}
                          </div>
                        </div>
                      )}
                      {prep.openItems.length > 0 && (
                        <div>
                          <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-600">Open items</div>
                          <div className="space-y-1">
                            {prep.openItems.map((o) => (
                              <div key={o.id} className="text-neutral-300">• {o.text}{o.due && <span className="text-neutral-500"> ({o.due})</span>}</div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-neutral-600">No prior context found for this one yet.</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The secretary's proactive suggestions — actions Off Grid proposed on its own.
// Shows a few; the rest live on the Actions screen via "View all".
function Secretary({ onViewAll }: { onViewAll: Navigate }): React.ReactElement {
  const [pending, setPending] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const load = useCallback(async (): Promise<void> => {
    const all: Proposal[] = (await api.approvalsList?.()) ?? [];
    setPending(all.filter((a) => a.status === 'pending'));
  }, []);
  useEffect(() => {
    load();
    const off = api.onCrmChanged?.(load);
    const poll = setInterval(load, 20000);
    return () => { off?.(); clearInterval(poll); };
  }, [load]);
  const decide = async (id: number, ok: boolean): Promise<void> => {
    setBusy(id);
    try {
      if (ok) await api.approvalsApprove?.(id);
      else await api.approvalsReject?.(id);
    } finally {
      setBusy(null);
      load();
    }
  };
  return (
    <div>
      <Label icon={IconBolt} right={pending.length > SUGGEST_CAP ? <ViewAll n={pending.length} onClick={() => onViewAll('actions', { mode: 'approvals' })} /> : undefined}>
        Off Grid suggests{pending.length ? ` · ${pending.length}` : ''}
      </Label>
      {pending.length === 0 ? (
        <p className="text-xs text-neutral-600">Nothing to approve right now — Off Grid surfaces actions here as it finds them.</p>
      ) : (
        <div className="space-y-2">
          {pending.slice(0, SUGGEST_CAP).map((p) => {
            const open = openId === p.id;
            return (
            <div key={p.id} className="rounded-md border border-neutral-800 bg-neutral-900/40 transition-colors hover:border-neutral-700">
              <div className="flex items-start gap-3 px-3 py-2.5">
                <button onClick={() => setOpenId(open ? null : p.id)} className="min-w-0 flex-1 text-left" title="Where this came from">
                  <div className="flex items-center gap-1.5 text-sm text-neutral-100">
                    {open ? <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" /> : <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-500" />}
                    <span className="truncate">{p.title}</span>
                  </div>
                  {p.detail && <div className="mt-0.5 pl-5 text-xs text-neutral-400">{p.detail}</div>}
                  {(p.connector || p.tool) && <div className="mt-1 pl-5 text-[11px] text-neutral-600">{[p.connector, p.tool].filter(Boolean).join(' · ')}</div>}
                </button>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => decide(p.id, true)} disabled={busy === p.id} className="flex items-center gap-1 rounded-md bg-green-500 px-2.5 py-1 text-xs text-neutral-950 hover:bg-green-400 disabled:opacity-50">
                    {busy === p.id ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> : <IconCheck className="h-3.5 w-3.5" />} Approve
                  </button>
                  <button onClick={() => decide(p.id, false)} disabled={busy === p.id} aria-label="Dismiss suggestion" className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:border-neutral-500"><IconX className="h-3.5 w-3.5" /></button>
                </div>
              </div>
              {open && (
                <div className="border-t border-neutral-800 px-3 py-2.5 pl-8">
                  <ProvenanceBlock approvalId={p.id} />
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// To-dos — priorities from action items. Shows a few; rest on the Actions screen.
function Todos({ items, onViewAll }: { items: Priority[]; onViewAll: Navigate }): React.ReactElement {
  return (
    <div>
      <Label icon={IconCircleCheck} right={items.length > TODO_CAP ? <ViewAll n={items.length} onClick={() => onViewAll('actions', { mode: 'todo' })} /> : undefined}>
        To do
      </Label>
      {items.length === 0 ? (
        <p className="text-xs text-neutral-600">Nothing flagged yet — action items from your email/chats show up here.</p>
      ) : (
        <div className="space-y-1.5">
          {items.slice(0, TODO_CAP).map((p) => (
            <div key={p.id} className="rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2 transition-colors hover:border-neutral-700">
              <div className="text-sm text-neutral-200">{p.text}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-neutral-600">
                {p.due && (
                  <span className="flex items-center gap-1 text-neutral-400"><IconClock className="h-3 w-3" /> {p.due}</span>
                )}
                {p.entityName && <span>{p.entityName}</span>}
                {p.sourceApp && <span className="text-neutral-700">· {p.sourceApp}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DayView({ onNavigate }: { onNavigate?: Navigate }): React.ReactElement {
  const navigate: Navigate = onNavigate ?? (() => {});
  const [day, setDay] = useState<Date>(() => startOfDay(new Date()));
  const [ahead, setAhead] = useState<AheadView | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [journal, setJournal] = useState('');
  const [journalLoading, setJournalLoading] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [showPast, setShowPast] = useState(false);

  const range = useCallback((): [number, number] => {
    const start = startOfDay(day).getTime();
    return [Math.floor(start / 1000), Math.floor((start + 86400000) / 1000)];
  }, [day]);

  const loadBlocks = useCallback(async () => {
    const [s, e] = range();
    setBlocks((await api.crmDayActivity?.(s, e)) ?? []);
  }, [range]);

  const loadJournal = useCallback(async () => {
    const [s, e] = range();
    setJournalLoading(true);
    try {
      const j = (await api.crmDayJournal?.(s, e)) ?? '';
      if (j) setJournal(j);
    } finally {
      setJournalLoading(false);
    }
  }, [range]);

  useEffect(() => {
    loadBlocks();
    const off = api.onCrmChanged?.(loadBlocks);
    const poll = setInterval(loadBlocks, 10000);
    return () => { off?.(); clearInterval(poll); };
  }, [loadBlocks]);

  // TODAY's calendar + to-dos (only relevant on the live day).
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const a = (await api.crmAhead?.()) ?? null;
      if (!cancelled) setAhead(a);
    };
    load();
    const off = api.onCrmChanged?.(load);
    const poll = setInterval(load, 30000);
    return () => { cancelled = true; off?.(); clearInterval(poll); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s] = range();
      const cached = (await api.crmDayJournalCached?.(s)) ?? '';
      if (!cancelled) setJournal(cached);
      loadJournal();
    })();
    return () => { cancelled = true; };
  }, [range, loadJournal]);

  const isToday = startOfDay(new Date()).getTime() === day.getTime();
  const totalSecs = blocks.reduce((acc, b) => acc + Math.max(60, b.endSec - b.startSec), 0);

  const bySurface = new Map<string, number>();
  for (const b of blocks) bySurface.set(b.surface, (bySurface.get(b.surface) ?? 0) + Math.max(60, b.endSec - b.startSec));
  const surfaceTimes = [...bySurface.entries()].sort((a, b) => b[1] - a[1]);
  const maxSurface = surfaceTimes[0]?.[1] ?? 1;
  const recapOpen = showPast || !isToday;

  return (
    <div className="h-full overflow-y-auto font-mono">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-800 px-8 py-4">
        <div>
          <h1 className="text-lg font-light tracking-tight text-white">
            {isToday ? 'Today' : day.toLocaleDateString([], { weekday: 'long' })}
          </h1>
          <div className="text-[11px] uppercase tracking-wide text-neutral-600">
            {day.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}
            {totalSecs > 0 && `  ·  ${fmtDur(totalSecs)} of activity`}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setDay(new Date(day.getTime() - 86400000))} aria-label="Previous day" className="rounded-md border border-neutral-800 p-1.5 text-neutral-400 hover:border-neutral-700 hover:text-white">
            <IconChevronLeft className="h-4 w-4" />
          </button>
          <button onClick={() => setDay(startOfDay(new Date()))} className="rounded-md border border-neutral-800 px-2.5 py-1.5 text-xs text-neutral-400 hover:border-neutral-700 hover:text-white">
            Today
          </button>
          <button
            onClick={() => setDay(new Date(day.getTime() + 86400000))}
            disabled={isToday}
            aria-label="Next day"
            className="rounded-md border border-neutral-800 p-1.5 text-neutral-400 hover:border-neutral-700 hover:text-white disabled:opacity-30"
          >
            <IconChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* FORWARD — only on the live day. Row 1: briefing + today's calendar (right).
          Row 2: Off Grid suggests | to-dos, half each. */}
      {isToday && (
        <>
          <section className="grid grid-cols-1 gap-x-10 gap-y-6 border-b border-neutral-800 px-8 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
            <DayPlan />
            <Calendar events={ahead?.upcoming ?? []} />
          </section>
          <section className="grid grid-cols-1 gap-x-10 gap-y-6 border-b border-neutral-800 px-8 py-5 lg:grid-cols-2">
            <Secretary onViewAll={navigate} />
            <Todos items={ahead?.priorities ?? []} onViewAll={navigate} />
          </section>
        </>
      )}

      {/* BEHIND — what happened. Collapsed by default on Today so the landing stays
          forward-first; one click expands the journal + time-spent + timeline. */}
      {blocks.length > 0 && (
        <button
          onClick={() => setShowPast((v) => !v)}
          className="flex w-full items-center gap-2 border-t border-neutral-800 px-8 py-3 text-[10px] uppercase tracking-wide text-neutral-500 hover:text-neutral-300"
        >
          {recapOpen ? <IconChevronDown className="h-3.5 w-3.5" /> : <IconChevronRight className="h-3.5 w-3.5" />}
          What happened{totalSecs > 0 ? ` · ${fmtDur(totalSecs)}` : ''}
          {recapOpen && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); navigate('replay'); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); navigate('replay'); } }}
              className="ml-auto flex items-center gap-1 text-neutral-500 hover:text-green-500"
            >
              Open in Replay <span aria-hidden>→</span>
            </span>
          )}
        </button>
      )}
      {blocks.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-neutral-600">
          <IconCalendar className="h-6 w-6" />
          <span className="text-sm">No activity captured for this day yet.</span>
        </div>
      ) : recapOpen ? (
        <div className="grid grid-cols-1 gap-x-10 gap-y-8 px-8 pb-8 pt-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          {/* Left: the day's synthesis + where time went (monochrome bars). */}
          <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
            <div className="relative rounded-md border border-neutral-800 bg-neutral-900/40 p-4">
              {journal ? (
                <>
                  <div className="space-y-3 text-sm leading-relaxed text-neutral-300">
                    {journal.split(/\n\n+/).map((para, i) => (
                      <p key={i}>{para}</p>
                    ))}
                  </div>
                  <button onClick={loadJournal} disabled={journalLoading} aria-label="Refresh summary" title="Refresh summary" className="absolute right-2 top-2 text-neutral-600 hover:text-green-500">
                    {journalLoading ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> : <IconRefresh className="h-3.5 w-3.5" />}
                  </button>
                </>
              ) : journalLoading ? (
                <div className="flex items-center gap-2 text-xs text-neutral-500">
                  <IconLoader2 className="h-4 w-4 animate-spin" /> Writing your day…
                </div>
              ) : (
                <p className="text-sm leading-relaxed text-neutral-400">No summary yet.</p>
              )}
            </div>

            {surfaceTimes.length > 0 && (
              <div>
                <Label icon={IconClock}>Time spent</Label>
                <div className="space-y-1.5">
                  {surfaceTimes.map(([s, d]) => (
                    <div key={s} className="flex items-center gap-3">
                      <span className="w-28 shrink-0 truncate text-[11px] text-neutral-400">{s}</span>
                      <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-900">
                        <span className="absolute inset-y-0 left-0 rounded-full bg-neutral-600" style={{ width: `${Math.max(4, (d / maxSurface) * 100)}%` }} />
                      </span>
                      <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-neutral-600">{fmtDur(d)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right: chronological timeline (monochrome — the latest block marks now). */}
          <div>
            <Label icon={IconListDetails}>Timeline</Label>
            <div className="relative space-y-2 border-l border-neutral-800 pl-4">
              {blocks.map((b, i) => {
                const primary = b.entities[0]?.name ?? b.surface;
                const isOpen = open === i;
                const isLatest = i === blocks.length - 1;
                return (
                  <div key={i} className="relative">
                    <span className={`absolute -left-[1.30rem] top-2 h-1.5 w-1.5 rounded-full ${isLatest ? 'bg-green-500' : 'bg-neutral-600'}`} />
                    <button onClick={() => setOpen(isOpen ? null : i)} className="w-full rounded-md border border-neutral-800 bg-neutral-900/40 p-2.5 text-left transition-colors hover:border-neutral-700">
                      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-neutral-400">
                        {primary}
                        <span className="text-neutral-600">
                          {fmtTime(b.startSec)}–{fmtTime(b.endSec)} · {b.surface}
                        </span>
                      </div>
                      <div className="mt-0.5 text-sm text-neutral-200">{b.summaries[0] ?? `${b.count} activities`}</div>
                      {isOpen && b.summaries.length > 1 && (
                        <div className="mt-2 space-y-1 border-t border-neutral-800 pt-2">
                          {b.summaries.slice(1).map((s, j) => (
                            <div key={j} className="text-xs text-neutral-400">{s}</div>
                          ))}
                        </div>
                      )}
                      {isOpen && b.entities.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {b.entities.map((en) => (
                            <span key={en.id} className="rounded-sm border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">
                              {en.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
