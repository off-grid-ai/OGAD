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
  IconClock,
} from '@tabler/icons-react';

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

export function ActionsScreen({ initialMode }: { initialMode?: 'todo' | 'approvals' } = {}) {
  const [mode, setMode] = useState<'todo' | 'approvals'>(initialMode ?? 'todo');
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [todoTab, setTodoTab] = useState<'open' | 'done' | 'dismissed'>('open');
  const [apprTab, setApprTab] = useState<'pending' | 'history'>('pending');
  const [selId, setSelId] = useState<number | null>(null);
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

  // The detail pane always reflects a real item: the clicked one, else the first.
  const selAction = mode === 'todo' ? (shownActions.find((i) => i.id === selId) ?? shownActions[0] ?? null) : null;
  const selApproval = mode === 'approvals' ? (shownApprovals.find((a) => a.id === selId) ?? shownApprovals[0] ?? null) : null;

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
              <Pill key={t} active={todoTab === t} onClick={() => { setTodoTab(t); setSelId(null); }}>{t} {todoCounts[t] > 0 && <span className="text-neutral-600">{todoCounts[t]}</span>}</Pill>
            ))
          : (['pending', 'history'] as const).map((t) => (
              <Pill key={t} active={apprTab === t} onClick={() => { setApprTab(t); setSelId(null); }}>{t}</Pill>
            ))}
      </div>

      {proposeMsg && (
        <div className="border-b border-neutral-900 px-6 py-2 text-xs text-green-400">{proposeMsg}</div>
      )}

      {/* Master-detail: dense list (left) → full item (right). Uses the full width. */}
      <div className="flex min-h-0 flex-1">
        <div className="w-[400px] shrink-0 overflow-y-auto border-r border-neutral-900">
          {loading && actions.length === 0 && approvals.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-24 text-sm text-neutral-600"><IconLoader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : mode === 'todo' ? (
            shownActions.length === 0 ? (
              <Empty icon={<IconChecklist />}>{todoTab === 'open' ? 'No open action items yet. They appear as Off Grid spots asks in your messages.' : `Nothing ${todoTab}.`}</Empty>
            ) : (
              <div>
                {shownActions.map((it) => (
                  <button
                    key={it.id}
                    onClick={() => setSelId(it.id)}
                    className={`group flex w-full items-start gap-2.5 border-b border-neutral-900 px-4 py-3 text-left transition-colors ${selAction?.id === it.id ? 'bg-neutral-900' : 'hover:bg-neutral-900/50'}`}
                  >
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => { e.stopPropagation(); void setActionStatus(it.id, it.status === 'done' ? 'open' : 'done'); }}
                      className="mt-0.5 shrink-0 text-neutral-500 hover:text-green-500"
                    >
                      {it.status === 'done' ? <IconCircleCheck className="h-4 w-4 text-green-500" /> : <IconCircle className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm ${it.status === 'done' ? 'text-neutral-500 line-through' : 'text-neutral-200'}`}>{it.text}</span>
                      <span className="mt-0.5 flex items-center gap-2 truncate text-[11px] text-neutral-600">
                        {it.due && <span className="text-neutral-400">{it.due}</span>}
                        {it.source_app && <span>{it.source_app}</span>}
                      </span>
                    </span>
                    {selAction?.id === it.id && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />}
                  </button>
                ))}
              </div>
            )
          ) : shownApprovals.length === 0 ? (
            <Empty icon={<IconShieldCheck />}>{apprTab === 'pending' ? 'Nothing waiting for approval. When Off Grid proposes an action, it shows up here.' : 'No decisions yet.'}</Empty>
          ) : (
            <div>
              {shownApprovals.map((it) => (
                <button
                  key={it.id}
                  onClick={() => setSelId(it.id)}
                  className={`flex w-full flex-col gap-0.5 border-b border-neutral-900 px-4 py-3 text-left transition-colors ${selApproval?.id === it.id ? 'bg-neutral-900' : 'hover:bg-neutral-900/50'}`}
                >
                  <span className="truncate text-sm text-neutral-200">{it.title}</span>
                  <span className="flex items-center gap-2 truncate text-[11px] text-neutral-600">
                    <span className={STATUS_COLOR[it.status] ?? 'text-neutral-500'}>{it.status}</span>
                    {(it.connector || it.tool) && <span>· {[it.connector, it.tool].filter(Boolean).join(' · ')}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Detail pane */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {mode === 'todo' && selAction ? (
            <TodoDetail key={selAction.id} item={selAction} onStatus={setActionStatus} />
          ) : mode === 'approvals' && selApproval ? (
            <ApprovalDetail key={selApproval.id} item={selApproval} onDecide={decide} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-neutral-700">Select an item to see the details.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-600">{label}</div>
      <div className="text-sm text-neutral-300">{children}</div>
    </div>
  );
}

function TodoDetail({ item, onStatus }: { item: ActionItem; onStatus: (id: number, s: 'open' | 'done' | 'dismissed') => void }): React.ReactElement {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-8 py-7">
      <div className="flex items-start gap-3">
        <button onClick={() => onStatus(item.id, item.status === 'done' ? 'open' : 'done')} className="mt-1 shrink-0 text-neutral-500 hover:text-green-500" aria-label="Toggle done">
          {item.status === 'done' ? <IconCircleCheck className="h-6 w-6 text-green-500" /> : <IconCircle className="h-6 w-6" />}
        </button>
        <h2 className={`flex-1 text-lg leading-snug ${item.status === 'done' ? 'text-neutral-500 line-through' : 'text-white'}`}>{item.text}</h2>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {item.entity_name && <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-green-500">{item.entity_name}</span>}
        {item.due && <span className="flex items-center gap-1 text-neutral-400"><IconClock className="h-3 w-3" /> {item.due}</span>}
        {item.source_app && <span className="text-neutral-500">{item.source_app}</span>}
        {item.source_ts && <span className="text-neutral-600">· {fmtWhen(item.source_ts)}</span>}
        {typeof item.confidence === 'number' && <span className="text-neutral-600">· {Math.round(item.confidence * 100)}% confidence</span>}
      </div>

      {item.source_summary && (
        <Field label="Where this came from">
          <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3 leading-relaxed text-neutral-400">{item.source_summary}</div>
        </Field>
      )}

      <div className="flex gap-2 pt-1">
        {item.status !== 'done' && (
          <button onClick={() => onStatus(item.id, 'done')} className="flex items-center gap-1.5 rounded-md bg-green-500 px-3 py-1.5 text-xs text-neutral-950 hover:bg-green-400"><IconCheck className="h-3.5 w-3.5" /> Mark done</button>
        )}
        <button onClick={() => onStatus(item.id, item.status === 'dismissed' ? 'open' : 'dismissed')} className="flex items-center gap-1.5 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500">
          {item.status === 'dismissed' ? <><IconRotateClockwise className="h-3.5 w-3.5" /> Restore</> : <><IconX className="h-3.5 w-3.5" /> Dismiss</>}
        </button>
      </div>
    </div>
  );
}

function ApprovalDetail({ item, onDecide }: { item: Approval; onDecide: (id: number, ok: boolean) => void }): React.ReactElement {
  const args = prettyArgs(item.args);
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-8 py-7">
      <div>
        <h2 className="text-lg leading-snug text-white">{item.title}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span className={STATUS_COLOR[item.status] ?? 'text-neutral-500'}>{item.status}</span>
          {item.entity_name && <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-green-500">{item.entity_name}</span>}
          {(item.connector || item.tool) && <span className="text-neutral-500">{[item.connector, item.tool].filter(Boolean).join(' · ')}</span>}
          <span className="text-neutral-600">· {fmtMs(item.created_at)}</span>
        </div>
      </div>

      {item.status === 'pending' && (
        <div className="flex gap-2">
          <button onClick={() => onDecide(item.id, true)} className="flex items-center gap-1.5 rounded-md bg-green-500 px-3.5 py-1.5 text-xs text-neutral-950 hover:bg-green-400"><IconCheck className="h-3.5 w-3.5" /> Approve</button>
          <button onClick={() => onDecide(item.id, false)} className="flex items-center gap-1.5 rounded-md border border-neutral-700 px-3.5 py-1.5 text-xs text-neutral-300 hover:border-neutral-500"><IconX className="h-3.5 w-3.5" /> Reject</button>
        </div>
      )}

      {item.detail && <Field label="What this does"><p className="leading-relaxed text-neutral-400">{item.detail}</p></Field>}
      {args && (
        <Field label="Payload">
          <pre className="overflow-x-auto rounded-md border border-neutral-800 bg-neutral-950 p-3 text-[11px] leading-relaxed text-neutral-400">{args}</pre>
        </Field>
      )}
      {item.result && <Field label="Result"><p className="text-xs text-neutral-500">{item.result}</p></Field>}
    </div>
  );
}

function Empty({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="px-6 py-16 text-center text-neutral-600">
      <div className="mx-auto mb-3 h-8 w-8 opacity-40 [&>svg]:h-8 [&>svg]:w-8">{icon}</div>
      <p className="text-xs leading-relaxed">{children}</p>
    </div>
  );
}
