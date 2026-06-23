import { useEffect, useState, useCallback } from 'react';
import {
  IconLoader2,
  IconChecklist,
  IconCircle,
  IconCircleCheck,
  IconX,
  IconRotateClockwise,
  IconShieldCheck,
  IconCheck,
  IconSparkles,
  IconChevronDown,
  IconChevronRight,
} from '@tabler/icons-react';
import { ProvenanceBlock } from './ProvenanceBlock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api;

interface ActionItem {
  id: number;
  text: string;
  due: string | null;
  entity_name: string | null;
  source_app: string | null;
  source_summary: string | null;
  source_ts: number | null;
  confidence: number;
  status: string;
}
interface Approval {
  id: number;
  title: string;
  detail: string | null;
  connector: string | null;
  tool: string | null;
  args: string | null;
  entity_name: string | null;
  status: string;
  result: string | null;
  created_at: number;
}

const fmtWhen = (sec: number | null): string =>
  sec ? new Date(sec * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const fmtMs = (ms: number | null): string =>
  ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-neutral-300', approved: 'text-green-500', executed: 'text-green-500', rejected: 'text-neutral-500', failed: 'text-red-400',
};

function prettyArgs(args: string | null): string | null {
  if (!args) return null;
  try { return JSON.stringify(JSON.parse(args), null, 2); } catch { return args; }
}

// Responsive card grid — fills the full width (1 → 2 → 3 columns).
const GRID = 'grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3';

export function ActionsScreen({ initialMode }: { initialMode?: 'todo' | 'approvals' } = {}) {
  const [mode, setMode] = useState<'todo' | 'approvals'>(initialMode ?? 'todo');
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [todoTab, setTodoTab] = useState<'open' | 'done' | 'dismissed'>('open');
  const [apprTab, setApprTab] = useState<'pending' | 'history'>('pending');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [proposing, setProposing] = useState(false);
  const [proposeMsg, setProposeMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, p] = await Promise.all([api.crmListActions?.() ?? [], api.approvalsList?.() ?? []]);
      setActions(a);
      setApprovals(p);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!api.onCrmChanged) return;
    const off = api.onCrmChanged(load);
    return () => { if (typeof off === 'function') off(); };
  }, [load]);

  const setActionStatus = async (id: number, status: 'open' | 'done' | 'dismissed'): Promise<void> => {
    await api.crmSetActionStatus?.(id, status);
    load();
  };
  const decide = async (id: number, ok: boolean): Promise<void> => {
    if (ok) await api.approvalsApprove?.(id);
    else await api.approvalsReject?.(id);
    load();
  };
  // Have the secretary survey connected tools + context and propose actions.
  const suggest = async (): Promise<void> => {
    setProposing(true);
    setProposeMsg('');
    setMode('approvals');
    setApprTab('pending');
    try {
      const r = await api.crmProposeActions?.();
      if (r?.error) setProposeMsg(r.error);
      else setProposeMsg(r?.proposed ? `Proposed ${r.proposed} action${r.proposed === 1 ? '' : 's'} for your review.` : 'Nothing worth proposing right now.');
    } catch (e) {
      setProposeMsg(e instanceof Error ? e.message : 'Could not propose actions.');
    } finally {
      setProposing(false);
      load();
    }
  };

  const pendingCount = approvals.filter((a) => a.status === 'pending').length;
  const openCount = actions.filter((a) => a.status === 'open').length;
  const shownActions = actions.filter((i) => i.status === todoTab);
  const shownApprovals = approvals.filter((a) => (apprTab === 'pending' ? a.status === 'pending' : a.status !== 'pending'));
  const todoCounts = {
    open: actions.filter((i) => i.status === 'open').length,
    done: actions.filter((i) => i.status === 'done').length,
    dismissed: actions.filter((i) => i.status === 'dismissed').length,
  };

  const Pill = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.ReactElement => (
    <button onClick={onClick} className={`rounded-full px-2.5 py-0.5 text-[11px] capitalize transition-colors ${active ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-white'}`}>{children}</button>
  );

  return (
    <div className="flex h-full flex-col bg-neutral-950 font-mono">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-900 px-6 py-4">
        <div className="flex items-center gap-3">
          <IconChecklist className="h-5 w-5 text-green-500" />
          <div>
            <h1 className="text-lg tracking-tight text-white">Actions</h1>
            <div className="text-[11px] uppercase tracking-wide text-neutral-600">What to do, and what Off Grid wants to do — your call</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={suggest}
            disabled={proposing}
            title="Survey your tools + context and propose actions"
            className="flex items-center gap-1.5 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-1.5 text-xs text-green-400 hover:bg-green-500/20 disabled:opacity-50"
          >
            {proposing ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> : <IconSparkles className="h-3.5 w-3.5" />} Suggest actions
          </button>
          <div className="flex items-center gap-0.5 rounded-full border border-neutral-800 p-0.5">
            <button onClick={() => setMode('todo')} className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs transition-colors ${mode === 'todo' ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-white'}`}>
              To do {openCount > 0 && <span className="text-neutral-500">{openCount}</span>}
            </button>
            <button onClick={() => setMode('approvals')} className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs transition-colors ${mode === 'approvals' ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-white'}`}>
              Approvals {pendingCount > 0 && <span className="text-neutral-300">{pendingCount}</span>}
            </button>
          </div>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex items-center gap-0.5 border-b border-neutral-900 px-6 py-2">
        {mode === 'todo'
          ? (['open', 'done', 'dismissed'] as const).map((t) => (
              <Pill key={t} active={todoTab === t} onClick={() => setTodoTab(t)}>{t} {todoCounts[t] > 0 && <span className="text-neutral-600">{todoCounts[t]}</span>}</Pill>
            ))
          : (['pending', 'history'] as const).map((t) => (
              <Pill key={t} active={apprTab === t} onClick={() => setApprTab(t)}>{t}</Pill>
            ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {proposeMsg && (
          <div className="mb-3 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2 text-xs text-green-400">{proposeMsg}</div>
        )}
        {loading && actions.length === 0 && approvals.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-24 text-sm text-neutral-600"><IconLoader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : mode === 'todo' ? (
          shownActions.length === 0 ? (
            <Empty icon={<IconChecklist />}>{todoTab === 'open' ? 'No open action items yet. They appear as Off Grid spots asks in your messages.' : `Nothing ${todoTab}.`}</Empty>
          ) : (
            <div className={GRID}>
              {shownActions.map((it) => (
                <div key={it.id} className="group flex items-start gap-3 self-start rounded-md border border-neutral-800 bg-neutral-900/40 p-3 transition-colors hover:border-neutral-700">
                  <button onClick={() => setActionStatus(it.id, it.status === 'done' ? 'open' : 'done')} className="mt-0.5 shrink-0 text-neutral-500 hover:text-green-500" aria-label="Toggle done">
                    {it.status === 'done' ? <IconCircleCheck className="h-5 w-5 text-green-500" /> : <IconCircle className="h-5 w-5" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm ${it.status === 'done' ? 'text-neutral-500 line-through' : 'text-neutral-100'}`}>{it.text}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
                      {it.entity_name && <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-green-500">{it.entity_name}</span>}
                      {it.due && <span className="text-neutral-400">{it.due}</span>}
                      {it.source_app && <span>{it.source_app}</span>}
                      {it.source_ts && <span>· {fmtWhen(it.source_ts)}</span>}
                    </div>
                  </div>
                  <button onClick={() => setActionStatus(it.id, it.status === 'dismissed' ? 'open' : 'dismissed')} className="shrink-0 text-neutral-600 opacity-0 transition-opacity hover:text-white group-hover:opacity-100" aria-label={it.status === 'dismissed' ? 'Restore' : 'Dismiss'}>
                    {it.status === 'dismissed' ? <IconRotateClockwise className="h-4 w-4" /> : <IconX className="h-4 w-4" />}
                  </button>
                </div>
              ))}
            </div>
          )
        ) : shownApprovals.length === 0 ? (
          <Empty icon={<IconShieldCheck />}>{apprTab === 'pending' ? 'Nothing waiting for approval. When Off Grid proposes an action (via a connector), it shows up here.' : 'No decisions yet.'}</Empty>
        ) : (
          <div className={GRID}>
            {shownApprovals.map((it) => {
              const open = expanded === it.id;
              const args = prettyArgs(it.args);
              return (
                <div key={it.id} className="flex flex-col self-start rounded-md border border-neutral-800 bg-neutral-900/40 p-3 transition-colors hover:border-neutral-700">
                  <p className="text-sm text-neutral-100">{it.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
                    <span className={STATUS_COLOR[it.status] ?? 'text-neutral-500'}>{it.status}</span>
                    {it.entity_name && <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-green-500">{it.entity_name}</span>}
                    {(it.connector || it.tool) && <span>{[it.connector, it.tool].filter(Boolean).join(' · ')}</span>}
                    <span>· {fmtMs(it.created_at)}</span>
                  </div>

                  {it.status === 'pending' && (
                    <div className="mt-3 flex gap-1">
                      <button onClick={() => decide(it.id, true)} className="flex items-center gap-1 rounded-md bg-green-500 px-2.5 py-1 text-xs text-neutral-950 hover:bg-green-400"><IconCheck className="h-3.5 w-3.5" /> Approve</button>
                      <button onClick={() => decide(it.id, false)} className="flex items-center gap-1 rounded-md border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:border-neutral-500"><IconX className="h-3.5 w-3.5" /> Reject</button>
                    </div>
                  )}

                  {(it.detail || args || it.result) && (
                    <button onClick={() => setExpanded(open ? null : it.id)} className="mt-2 flex items-center gap-0.5 self-start text-[11px] text-neutral-500 hover:text-white">
                      {open ? <IconChevronDown className="h-3 w-3" /> : <IconChevronRight className="h-3 w-3" />} details
                    </button>
                  )}
                  {open && (
                    <div className="mt-2 space-y-2 border-t border-neutral-800 pt-2">
                      {it.detail && <p className="text-xs leading-relaxed text-neutral-400">{it.detail}</p>}
                      <ProvenanceBlock approvalId={it.id} />
                      {args && <pre className="max-h-60 overflow-auto rounded bg-neutral-950 p-2 text-[11px] leading-relaxed text-neutral-400">{args}</pre>}
                      {it.result && <p className="text-[11px] text-neutral-500">Result: {it.result}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Empty({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="py-24 text-center text-neutral-600">
      <div className="mx-auto mb-3 h-10 w-10 opacity-40 [&>svg]:h-10 [&>svg]:w-10">{icon}</div>
      <p className="text-sm">{children}</p>
    </div>
  );
}
