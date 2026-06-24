import { useEffect, useState, useCallback } from 'react';
import { IconLoader2, IconShieldCheck, IconCheck, IconX, IconChevronDown, IconChevronRight } from '@tabler/icons-react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api;

interface Approval {
  id: number;
  title: string;
  detail: string | null;
  connector: string | null;
  tool: string | null;
  args: string | null;
  entity_name: string | null;
  source: string | null;
  status: string;
  result: string | null;
  created_at: number;
  decided_at: number | null;
}

const fmt = (ms: number | null): string => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

const STATUS_COLOR: Record<string, string> = {
  pending: 'text-amber-400',
  approved: 'text-green-500',
  executed: 'text-green-500',
  rejected: 'text-neutral-500',
  failed: 'text-red-400',
};

export function ApprovalsScreen() {
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems((await api.approvalsList?.()) ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!api.onCrmChanged) return;
    return api.onCrmChanged(load);
  }, [load]);

  const decide = async (id: number, ok: boolean): Promise<void> => {
    if (ok) await api.approvalsApprove?.(id);
    else await api.approvalsReject?.(id);
    load();
  };

  const pending = items.filter((i) => i.status === 'pending');
  const history = items.filter((i) => i.status !== 'pending');
  const shown = tab === 'pending' ? pending : history;

  return (
    <div className="flex h-full flex-col bg-neutral-950 font-mono">
      <div className="flex items-center justify-between border-b border-neutral-900 px-6 py-4">
        <div className="flex items-center gap-3">
          <IconShieldCheck className="h-5 w-5 text-green-500" />
          <div>
            <h1 className="text-lg tracking-tight text-white">Approvals</h1>
            <div className="text-[11px] uppercase tracking-wide text-neutral-600">Off Grid never acts without your approval</div>
          </div>
        </div>
        <div className="flex items-center gap-0.5 rounded-full border border-neutral-800 p-0.5">
          {(['pending', 'history'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-3 py-1 text-xs capitalize transition-colors ${tab === t ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-white'}`}
            >
              {t} {t === 'pending' && pending.length > 0 && <span className="text-amber-400">{pending.length}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-24 text-sm text-neutral-600">
            <IconLoader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : shown.length === 0 ? (
          <div className="py-24 text-center text-neutral-600">
            <IconShieldCheck className="mx-auto mb-3 h-10 w-10 opacity-40" />
            <p className="text-sm">
              {tab === 'pending'
                ? 'Nothing waiting for approval. When Off Grid proposes an action (via a connector), it shows up here for you to approve.'
                : 'No decisions yet.'}
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-2">
            {shown.map((it) => {
              const open = expanded === it.id;
              return (
                <div key={it.id} className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-neutral-100">{it.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
                        <span className={STATUS_COLOR[it.status] ?? 'text-neutral-500'}>{it.status}</span>
                        {it.entity_name && <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-green-500">{it.entity_name}</span>}
                        {(it.connector || it.tool) && <span>{[it.connector, it.tool].filter(Boolean).join(' · ')}</span>}
                        <span>· {fmt(it.created_at)}</span>
                        {(it.detail || it.args) && (
                          <button onClick={() => setExpanded(open ? null : it.id)} className="flex items-center gap-0.5 text-neutral-400 hover:text-white">
                            {open ? <IconChevronDown className="h-3 w-3" /> : <IconChevronRight className="h-3 w-3" />} details
                          </button>
                        )}
                      </div>
                    </div>
                    {it.status === 'pending' && (
                      <div className="flex shrink-0 gap-1">
                        <button onClick={() => decide(it.id, true)} className="flex items-center gap-1 rounded-md bg-green-500 px-2.5 py-1 text-xs text-neutral-950 hover:bg-green-400">
                          <IconCheck className="h-3.5 w-3.5" /> Approve
                        </button>
                        <button onClick={() => decide(it.id, false)} className="flex items-center gap-1 rounded-md border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:border-neutral-500">
                          <IconX className="h-3.5 w-3.5" /> Reject
                        </button>
                      </div>
                    )}
                  </div>
                  {open && (
                    <div className="mt-2 space-y-2 border-t border-neutral-800 pt-2">
                      {it.detail && <p className="text-xs leading-relaxed text-neutral-400">{it.detail}</p>}
                      {it.args && (
                        <pre className="overflow-x-auto rounded bg-neutral-950 p-2 text-[11px] text-neutral-400">{(() => { try { return JSON.stringify(JSON.parse(it.args), null, 2); } catch { return it.args; } })()}</pre>
                      )}
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
