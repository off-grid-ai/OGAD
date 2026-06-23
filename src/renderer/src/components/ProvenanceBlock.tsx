import { useEffect, useState } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api;

export interface Provenance {
  entityName: string | null;
  basedOn: { surface: string; ts: string; summary: string }[];
}

function fmtTs(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// "Where did this come from" — the recent on-device observations (calls / emails
// / notes) the secretary was looking at when it proposed this approval. Fetches
// itself on mount so callers just drop it into an expanded panel.
export function ProvenanceBlock({ approvalId }: { approvalId: number }): React.ReactElement {
  const [p, setP] = useState<Provenance | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let ok = true;
    setLoading(true);
    Promise.resolve(api.approvalsProvenance?.(approvalId))
      .then((r: Provenance | undefined) => { if (ok) { setP(r ?? null); setLoading(false); } })
      .catch(() => { if (ok) setLoading(false); });
    return () => { ok = false; };
  }, [approvalId]);

  if (loading) return <div className="text-[11px] text-neutral-600">Tracing source…</div>;
  if (!p || p.basedOn.length === 0) {
    return <div className="text-[11px] text-neutral-600">No linked source found{p?.entityName ? ` for ${p.entityName}` : ''}.</div>;
  }
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-600">Based on{p.entityName ? ` · ${p.entityName}` : ''}</div>
      <div className="space-y-1">
        {p.basedOn.map((b, i) => (
          <div key={i} className="text-[11px] leading-relaxed text-neutral-400">
            <span className="text-neutral-600">{b.surface} · {fmtTs(b.ts)} — </span>{b.summary}
          </div>
        ))}
      </div>
    </div>
  );
}
