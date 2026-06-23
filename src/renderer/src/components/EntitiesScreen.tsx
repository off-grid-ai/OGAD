import { useEffect, useState, useCallback, type ReactElement, type ReactNode } from 'react';
import {
  IconSearch,
  IconLoader2,
  IconChevronRight,
  IconChevronDown,
  IconPencil,
  IconPlus,
  IconX,
  IconArrowMerge,
  IconUser,
  IconBuilding,
  IconHash,
  IconFile,
  IconCamera,
  IconWand,
  IconEye,
  IconEyeOff,
  IconArrowRight,
} from '@tabler/icons-react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api;

interface EntityListItem {
  id: number;
  name: string;
  type: string;
  parentId: number | null;
  hidden: number;
  imagePath: string | null;
  observationCount: number;
  distinctDays: number;
  lastTs: string | null;
  latestSummary: string | null;
}
interface Alias { id: number; kind: string; value: string; source: string }
interface Observation {
  id: number;
  summary: string;
  surface: string | null;
  app: string | null;
  url: string | null;
  ts: string;
  frameCount: number;
}
interface Record {
  entity: { id: number; name: string; type: string; summary: string | null; imagePath: string | null; updatedAt: string };
  aliases: Alias[];
  surfaces: { surface: string; count: number; lastTs: string }[];
  related: { id: number; name: string; type: string; weight: number }[];
  observations: Observation[];
}

function isProject(t: string): boolean {
  const x = t.toLowerCase();
  return x.includes('project') || x.includes('repo');
}
function isPerson(t: string): boolean {
  const x = t.toLowerCase();
  return x.includes('person') || x.includes('people');
}
// Display buckets for the type tabs (stable order; only non-empty ones render).
const TYPE_ORDER = ['Projects', 'People', 'Companies', 'Topics', 'Places', 'Products', 'Objects', 'Concepts'];
function typeBucket(type: string): string {
  const x = (type || '').toLowerCase();
  if (x.includes('project') || x.includes('repo')) return 'Projects';
  if (x.includes('person') || x.includes('people')) return 'People';
  if (x.includes('compan') || x.includes('org')) return 'Companies';
  if (x.includes('place')) return 'Places';
  if (x.includes('product')) return 'Products';
  if (x.includes('object')) return 'Objects';
  if (x.includes('concept')) return 'Concepts';
  return 'Topics';
}
function typeIcon(type: string) {
  if (isPerson(type)) return IconUser;
  if (type.toLowerCase().includes('compan') || type.toLowerCase().includes('org')) return IconBuilding;
  return IconHash;
}
function timeAgo(ts: string | null): string {
  if (!ts) return '';
  const then = new Date(ts.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function EntitiesScreen() {
  const [entities, setEntities] = useState<EntityListItem[]>([]);
  const [filter, setFilter] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [merging, setMerging] = useState<EntityListItem | null>(null);

  const refresh = useCallback(async () => {
    setEntities((await api.crmListEntities?.()) ?? []);
  }, []);
  useEffect(() => {
    refresh();
    const off = api.onCrmChanged?.(refresh); // live push when a capture lands
    const poll = setInterval(refresh, 15000); // fallback
    return () => {
      off?.();
      clearInterval(poll);
    };
  }, [refresh]);

  const organize = async (): Promise<void> => {
    setOrganizing(true);
    try {
      await api.crmOrganize?.();
      await refresh();
    } finally {
      setOrganizing(false);
    }
  };

  const [showHidden, setShowHidden] = useState(false);
  const [showLatent, setShowLatent] = useState(false);
  const [tab, setTab] = useState('All');
  const hiddenCount = entities.filter((e) => e.hidden).length;
  const f = filter.toLowerCase();

  // Significance gate: an entity is SURFACED (worth bringing up) only once it
  // recurs across days, has real weight, or is part of the project hierarchy.
  // One-off mentions ("1000 Oaks" from a single chat) stay LATENT — still
  // stored + searchable, just not cluttering the list until they matter.
  const parentSet = new Set(entities.filter((e) => e.parentId != null).map((e) => e.parentId as number));
  const isSurfaced = (e: EntityListItem): boolean =>
    e.parentId != null || parentSet.has(e.id) || (e.distinctDays ?? 1) >= 2 || e.observationCount >= 6;

  const matchesText = (e: EntityListItem): boolean => e.name.toLowerCase().includes(f);
  const shown = entities.filter(matchesText).filter((e) => {
    if (showHidden) return !!e.hidden; // archive view
    if (e.hidden) return false;
    if (f) return true; // an explicit search reveals latent matches too
    return showLatent || isSurfaced(e);
  });
  const latentCount = entities.filter((e) => !e.hidden && !isSurfaced(e)).length;

  const onMerge = (e: EntityListItem): void => setMerging(e);
  const onHide = async (e: EntityListItem): Promise<void> => {
    await api.crmSetHidden?.(e.id, !e.hidden);
    refresh();
  };

  // Type tabs: count entities per bucket; show only buckets that have rows.
  const counts = shown.reduce<{ [k: string]: number }>((acc, e) => {
    const b = typeBucket(e.type);
    acc[b] = (acc[b] ?? 0) + 1;
    return acc;
  }, {});
  const tabs = ['All', ...TYPE_ORDER.filter((t) => counts[t])];
  const activeTab = tabs.includes(tab) ? tab : 'All';

  const inTab = (e: EntityListItem): boolean => activeTab === 'All' || typeBucket(e.type) === activeTab;
  const projects = shown.filter((e) => isProject(e.type) && inTab(e));
  const people = shown.filter((e) => isPerson(e.type) && inTab(e)).sort(byRecent);
  const topics = shown.filter((e) => !isProject(e.type) && !isPerson(e.type) && inTab(e)).sort(byRecent);

  // Project hierarchy: top-level = no parent (or parent not a visible project).
  const projIds = new Set(shown.filter((e) => isProject(e.type)).map((p) => p.id));
  const topProjects = projects.filter((p) => p.parentId == null || !projIds.has(p.parentId)).sort(byRecent);
  const childrenOf = (id: number): EntityListItem[] =>
    shown.filter((e) => isProject(e.type) && e.parentId === id).sort(byRecent);

  const renderRow = (e: EntityListItem, depth: number): ReactElement => (
    <Row
      key={e.id}
      e={e}
      depth={depth}
      expanded={expandedId === e.id}
      onToggle={() => setExpandedId(expandedId === e.id ? null : e.id)}
      onChanged={refresh}
      onMerge={() => onMerge(e)}
      onHide={() => onHide(e)}
      childRows={isProject(e.type) ? childrenOf(e.id).map((c) => renderRow(c, depth + 1)) : []}
    />
  );

  return (
    <div className="flex h-full flex-col font-mono">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4">
        <h1 className="text-lg font-light tracking-tight text-white">Entities</h1>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5">
            <IconSearch className="h-3.5 w-3.5 text-neutral-500" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find…"
              className="w-40 bg-transparent text-xs text-white placeholder-neutral-600 outline-none"
            />
          </div>
          {latentCount > 0 && (
            <button
              onClick={() => setShowLatent((s) => !s)}
              title="One-off mentions, stored but not surfaced until they recur"
              className={`rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                showLatent ? 'border-green-500 text-green-500' : 'border-neutral-800 text-neutral-400 hover:text-white'
              }`}
            >
              {showLatent ? 'Hide latent' : `Latent (${latentCount})`}
            </button>
          )}
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowHidden((s) => !s)}
              className={`rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                showHidden ? 'border-green-500 text-green-500' : 'border-neutral-800 text-neutral-400 hover:text-white'
              }`}
            >
              {showHidden ? 'Hide archived' : `Show archived (${hiddenCount})`}
            </button>
          )}
          <button
            onClick={organize}
            disabled={organizing}
            title="Auto-merge duplicates + build project hierarchy"
            className="flex items-center gap-1 rounded-md border border-neutral-800 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-green-500 hover:text-green-500 disabled:opacity-50"
          >
            {organizing ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <IconWand className="h-4 w-4" />} Organize
          </button>
        </div>
      </div>

      {merging && (
        <MergeOverlay
          source={merging}
          candidates={entities.filter((e) => e.id !== merging.id)}
          onClose={() => setMerging(null)}
          onMerge={async (targetId) => {
            await api.crmMergeEntities?.(targetId, merging.id);
            setMerging(null);
            refresh();
          }}
        />
      )}

      {/* Type tabs — cut the firehose to one category at a time. */}
      <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
              activeTab === t ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-neutral-200'
            }`}
          >
            {t}
            {t !== 'All' && <span className="ml-1.5 text-neutral-600">{counts[t]}</span>}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-8">
        {shown.length === 0 && <p className="px-3 py-6 text-sm text-neutral-600">No entities yet.</p>}
        {activeTab === 'All' ? (
          <>
            <Group label="Projects" show={topProjects.length > 0}>{topProjects.map((p) => renderRow(p, 0))}</Group>
            <Group label="People" show={people.length > 0}>{people.map((p) => renderRow(p, 0))}</Group>
            <Group label="Topics & things" show={topics.length > 0}>{topics.map((t) => renderRow(t, 0))}</Group>
          </>
        ) : activeTab === 'Projects' ? (
          <Group label="Projects" show={topProjects.length > 0}>{topProjects.map((p) => renderRow(p, 0))}</Group>
        ) : activeTab === 'People' ? (
          <Group label="People" show={people.length > 0}>{people.map((p) => renderRow(p, 0))}</Group>
        ) : (
          <Group label={activeTab} show={topics.length > 0}>{topics.map((t) => renderRow(t, 0))}</Group>
        )}
      </div>
    </div>
  );
}

const byRecent = (a: EntityListItem, b: EntityListItem): number => (b.lastTs ?? '').localeCompare(a.lastTs ?? '');

function Group({ label, show, children }: { label: string; show: boolean; children: ReactNode }) {
  if (!show) return null;
  return (
    <div className="mb-4">
      <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-neutral-600">{label}</div>
      {children}
    </div>
  );
}

function Row({
  e,
  depth,
  expanded,
  onToggle,
  onChanged,
  onMerge,
  onHide,
  childRows,
}: {
  e: EntityListItem;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onMerge: () => void;
  onHide: () => void;
  childRows: ReactElement[];
}) {
  const Icon = typeIcon(e.type);
  return (
    <>
      <div
        onClick={onToggle}
        style={{ paddingLeft: 12 + depth * 20 }}
        className={`group flex w-full cursor-pointer items-center gap-2 rounded-md py-2 pr-3 transition-colors ${
          expanded ? 'bg-neutral-900' : 'hover:bg-neutral-900/50'
        } ${e.hidden ? 'opacity-50' : ''}`}
      >
        {expanded ? (
          <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        ) : (
          <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-600" />
        )}
        {e.imagePath ? (
          <img src={`ogcapture://${e.imagePath}`} alt="" className="h-5 w-5 shrink-0 rounded-full border border-neutral-800 object-cover" />
        ) : (
          <Icon className="h-4 w-4 shrink-0 text-neutral-500" />
        )}
        <span className="shrink-0 truncate text-sm text-white">{e.name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-600">
          {e.latestSummary ? `— ${e.latestSummary}` : ''}
        </span>
        {/* Hover actions */}
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
          <button
            onClick={(ev) => { ev.stopPropagation(); onMerge(); }}
            title="Merge into another entity"
            className="rounded p-1 text-neutral-500 hover:text-green-500"
          >
            <IconArrowMerge className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(ev) => { ev.stopPropagation(); onHide(); }}
            title={e.hidden ? 'Unhide' : 'Hide from feed (still captured)'}
            className="rounded p-1 text-neutral-500 hover:text-white"
          >
            {e.hidden ? <IconEye className="h-3.5 w-3.5" /> : <IconEyeOff className="h-3.5 w-3.5" />}
          </button>
        </div>
        {e.observationCount > 0 && <span className="shrink-0 text-[10px] text-neutral-700">{e.observationCount}</span>}
        {e.lastTs && <span className="shrink-0 text-[10px] text-neutral-600">{timeAgo(e.lastTs)}</span>}
      </div>

      {/* Children + detail only when expanded — collapsing the parent hides its sub-projects. */}
      {expanded && (
        <>
          {childRows}
          <div style={{ paddingLeft: 12 + depth * 20 }}>
            <ExpandedEntity entityId={e.id} allEntities={[]} onChanged={onChanged} />
          </div>
        </>
      )}
    </>
  );
}

function MergeOverlay({
  source,
  candidates,
  onClose,
  onMerge,
}: {
  source: EntityListItem;
  candidates: EntityListItem[];
  onClose: () => void;
  onMerge: (targetId: number) => void;
}) {
  const [q, setQ] = useState('');
  const shown = candidates.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 10);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-32" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-96 rounded-md border border-neutral-800 bg-neutral-950 p-3 shadow-xl">
        <div className="mb-2 text-xs text-neutral-400">
          Merge <span className="text-white">{source.name}</span> into…
        </div>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the survivor entity…"
          className="mb-2 w-full rounded-sm border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-white outline-none focus:border-green-500"
        />
        <div className="max-h-64 overflow-y-auto">
          {shown.map((c) => (
            <button
              key={c.id}
              onClick={() => onMerge(c.id)}
              className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-900"
            >
              <span>{c.name}</span>
              <span className="text-[10px] uppercase text-neutral-600">{c.type}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ExpandedEntity({
  entityId,
  onChanged,
}: {
  entityId: number;
  allEntities: EntityListItem[];
  onChanged: () => void;
}) {
  const [rec, setRec] = useState<Record | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [synthesizing, setSynthesizing] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const load = useCallback(async () => {
    const r = (await api.crmEntityRecord?.(entityId, {})) ?? null;
    setRec(r);
    return r as Record | null;
  }, [entityId]);

  const synthesize = useCallback(async () => {
    setSynthesizing(true);
    try {
      await api.crmSummarizeEntity?.(entityId);
      await load();
    } finally {
      setSynthesizing(false);
    }
  }, [entityId, load]);

  // After moving/removing an observation: refresh immediately, then recalibrate
  // the synthesis in the background (it's now stale).
  const afterMutate = useCallback(() => {
    load();
    onChanged();
    setSynthesizing(true);
    api.crmSummarizeEntity?.(entityId).finally(() => {
      setSynthesizing(false);
      load();
    });
  }, [entityId, load, onChanged]);

  useEffect(() => {
    load().then((r) => {
      // Auto-synthesize the narrative if we have activity but no summary yet.
      if (r && !r.entity.summary && r.observations.length > 0) synthesize();
    });
  }, [load, synthesize]);

  if (!rec) return <div className="px-7 py-2 text-xs text-neutral-600">Loading…</div>;

  return (
    <div className="ml-5 mb-2 rounded-md border border-neutral-800 bg-neutral-950/60 p-3">
      {/* Header: photo + name + type */}
      <div className="flex items-center gap-3">
        <button
          onClick={async () => {
            const p = await api.crmSetEntityPhoto?.(entityId);
            if (p) load();
          }}
          title="Set photo"
          className="group relative h-9 w-9 shrink-0 overflow-hidden rounded-full border border-neutral-800 bg-neutral-900"
        >
          {rec.entity.imagePath ? (
            <img src={`ogcapture://${rec.entity.imagePath}`} alt="" className="h-full w-full object-cover" />
          ) : (
            <IconCamera className="m-auto mt-2 h-4 w-4 text-neutral-600" />
          )}
        </button>
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={async () => {
              if (nameDraft.trim() && nameDraft !== rec.entity.name) {
                await api.crmRenameEntity?.(entityId, nameDraft.trim());
                onChanged();
                load();
              }
              setEditingName(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditingName(false);
            }}
            className="rounded border border-green-500 bg-neutral-900 px-2 py-0.5 text-sm text-white outline-none"
          />
        ) : (
          <button
            onClick={() => {
              setNameDraft(rec.entity.name);
              setEditingName(true);
            }}
            className="group flex items-center gap-1.5 text-sm text-white"
          >
            {rec.entity.name}
            <IconPencil className="h-3 w-3 text-neutral-600 opacity-0 group-hover:opacity-100" />
          </button>
        )}
        <input
          defaultValue={rec.entity.type}
          onBlur={async (e) => {
            if (e.target.value.trim() && e.target.value !== rec.entity.type) {
              await api.crmRetypeEntity?.(entityId, e.target.value.trim());
              onChanged();
            }
          }}
          className="w-24 rounded-sm border border-neutral-800 bg-neutral-900/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400 outline-none focus:border-green-500"
        />
      </div>

      {/* Identifiers (horizontal, multiples) */}
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        <IdentifierRow label="Email" kind="email" aliases={rec.aliases} entityId={entityId} onChange={load} />
        <IdentifierRow label="Phone" kind="phone" aliases={rec.aliases} entityId={entityId} onChange={load} />
        <IdentifierRow label="Handle" kind="handle" aliases={rec.aliases} entityId={entityId} onChange={load} />
        <AliasNames aliases={rec.aliases} entityName={rec.entity.name} entityId={entityId} onChange={load} />
      </div>

      {/* Synthesis — the narrative, the hero (not a listicle) */}
      <div className="mt-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
        {synthesizing ? (
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> Synthesizing…
          </div>
        ) : rec.entity.summary ? (
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm leading-relaxed text-neutral-200">{rec.entity.summary}</p>
            <button onClick={synthesize} title="Re-synthesize" className="shrink-0 text-neutral-600 hover:text-green-500">
              <IconWand className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : rec.observations.length > 0 ? (
          <button onClick={synthesize} className="flex items-center gap-1 text-xs text-neutral-500 hover:text-green-500">
            <IconWand className="h-3.5 w-3.5" /> Synthesize what&apos;s happening
          </button>
        ) : (
          <p className="text-xs text-neutral-600">No activity captured yet.</p>
        )}
      </div>

      {/* Raw activity log — collapsed by default; the synthesis is the hero */}
      {rec.observations.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowLog((s) => !s)}
            className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-neutral-600 hover:text-neutral-400"
          >
            <IconChevronRight className={`h-3 w-3 transition-transform ${showLog ? 'rotate-90' : ''}`} />
            Activity log ({rec.observations.length})
          </button>
          {showLog && (
            <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {rec.observations.slice(0, 18).map((o) => (
                <ActivityCard key={o.id} o={o} entityId={entityId} afterMutate={afterMutate} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Related */}
      {rec.related.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {rec.related.map((r) => (
            <span key={r.id} className="rounded-sm border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">
              {r.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function IdentifierRow({
  label,
  kind,
  aliases,
  entityId,
  onChange,
}: {
  label: string;
  kind: string;
  aliases: Alias[];
  entityId: number;
  onChange: () => void;
}) {
  const items = aliases.filter((a) => a.kind === kind);
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState('');
  const submit = async (): Promise<void> => {
    if (val.trim()) {
      await api.crmAddAlias?.(entityId, kind, val.trim());
      setVal('');
      onChange();
    }
    setAdding(false);
  };
  return (
    <div className="flex items-start gap-2">
      <span className="w-12 shrink-0 pt-1 text-[10px] uppercase tracking-wide text-neutral-600">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((a) => (
          <span key={a.id} className="group flex items-center gap-1 rounded-sm bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-300">
            {a.value}
            <button onClick={async () => { await api.crmRemoveAlias?.(a.id); onChange(); }} className="opacity-0 transition group-hover:opacity-100">
              <IconX className="h-3 w-3 hover:text-red-500" />
            </button>
          </span>
        ))}
        {adding ? (
          <input
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={submit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') setAdding(false);
            }}
            placeholder={`add ${label.toLowerCase()}`}
            className="w-40 rounded-sm border border-green-500 bg-neutral-900 px-1.5 py-0.5 text-[11px] text-white outline-none"
          />
        ) : (
          <button onClick={() => setAdding(true)} className="flex items-center gap-0.5 rounded-sm border border-dashed border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-500 hover:border-green-500 hover:text-green-500">
            <IconPlus className="h-3 w-3" /> add
          </button>
        )}
      </div>
    </div>
  );
}

// One activity-log card: screenshot cover + summary, with hover actions to
// reassign the observation to a different entity (created if new) or remove it.
function ActivityCard({
  o,
  entityId,
  afterMutate,
}: {
  o: Observation;
  entityId: number;
  afterMutate: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const [name, setName] = useState('');
  const reassign = async (): Promise<void> => {
    if (name.trim()) {
      await api.crmReassignObservation?.(o.id, entityId, name.trim());
      afterMutate();
    }
    setName('');
    setMoving(false);
  };
  return (
    <div className="group/card relative flex flex-col overflow-hidden rounded border border-neutral-900 bg-neutral-900/40">
      <div className="absolute right-1.5 top-1.5 z-10 flex gap-1 opacity-0 transition group-hover/card:opacity-100">
        <button
          onClick={() => setMoving((m) => !m)}
          title="Move to another entity"
          className="rounded bg-black/60 p-1 text-neutral-300 backdrop-blur hover:text-green-400"
        >
          <IconArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={async () => {
            await api.crmUnlinkObservation?.(o.id, entityId);
            afterMutate();
          }}
          title="Remove from this entity"
          className="rounded bg-black/60 p-1 text-neutral-300 backdrop-blur hover:text-red-400"
        >
          <IconX className="h-3.5 w-3.5" />
        </button>
      </div>
      {moving && (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={reassign}
          onKeyDown={(e) => {
            if (e.key === 'Enter') reassign();
            if (e.key === 'Escape') setMoving(false);
          }}
          placeholder="Move to entity… (Enter)"
          className="absolute left-1.5 right-1.5 top-9 z-10 rounded-sm border border-green-500 bg-neutral-950 px-1.5 py-1 text-[11px] text-white outline-none"
        />
      )}
      {o.frameCount > 0 && <FrameThumbs observationId={o.id} cover />}
      <div className="flex flex-1 flex-col p-2.5">
        <span className="line-clamp-3 text-xs text-neutral-300">{o.summary}</span>
        <div className="mt-auto flex items-center justify-between pt-1.5 text-[10px] uppercase tracking-wide text-neutral-700">
          <span className="truncate">{o.surface || o.app || ''}</span>
          <span className="shrink-0">{timeAgo(o.ts)}</span>
        </div>
      </div>
    </div>
  );
}

// The raw captured screenshots beneath an observation — linked, not processed.
// `cover` renders the first frame as a full-width card cover (for the grid).
function FrameThumbs({ observationId, cover }: { observationId: number; cover?: boolean }) {
  const [frames, setFrames] = useState<{ id: number; imagePath: string | null }[] | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  useEffect(() => {
    api.crmObservationFrames?.(observationId).then((f: { id: number; imagePath: string | null }[]) => setFrames(f ?? []));
  }, [observationId]);
  const withImg = (frames ?? []).filter((f) => f.imagePath);
  if (withImg.length === 0) return null;
  return (
    <>
      {cover ? (
        <img
          src={`ogcapture://${withImg[0].imagePath}`}
          alt="frame"
          onClick={() => setZoom(withImg[0].imagePath)}
          className="aspect-video w-full cursor-zoom-in border-b border-neutral-800 object-cover object-top hover:opacity-90"
        />
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {withImg.map((f) => (
            <img
              key={f.id}
              src={`ogcapture://${f.imagePath}`}
              alt="frame"
              onClick={() => setZoom(f.imagePath)}
              className="h-14 w-24 cursor-zoom-in rounded border border-neutral-800 object-cover object-top hover:border-green-500"
            />
          ))}
        </div>
      )}
      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8" onClick={() => setZoom(null)}>
          <img src={`ogcapture://${zoom}`} alt="frame" className="max-h-full max-w-full rounded border border-neutral-800" />
        </div>
      )}
    </>
  );
}

function AliasNames({
  aliases,
  entityName,
  entityId,
  onChange,
}: {
  aliases: Alias[];
  entityName: string;
  entityId: number;
  onChange: () => void;
}) {
  const names = aliases.filter((a) => a.kind === 'name' && a.value.toLowerCase() !== entityName.toLowerCase());
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState('');
  const submit = async (): Promise<void> => {
    if (val.trim()) {
      await api.crmAddAlias?.(entityId, 'name', val.trim());
      setVal('');
      onChange();
    }
    setAdding(false);
  };
  return (
    <div className="flex items-start gap-2">
      <span className="w-12 shrink-0 pt-1 text-[10px] uppercase tracking-wide text-neutral-600">Also</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {names.map((a) => (
          <span key={a.id} className="group flex items-center gap-1 rounded-sm bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-300">
            {a.value}
            <button onClick={async () => { await api.crmRemoveAlias?.(a.id); onChange(); }} className="opacity-0 transition group-hover:opacity-100">
              <IconX className="h-3 w-3 hover:text-red-500" />
            </button>
          </span>
        ))}
        {adding ? (
          <input
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={submit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') setAdding(false);
            }}
            placeholder="a.k.a."
            className="w-40 rounded-sm border border-green-500 bg-neutral-900 px-1.5 py-0.5 text-[11px] text-white outline-none"
          />
        ) : (
          <button onClick={() => setAdding(true)} className="flex items-center gap-0.5 rounded-sm border border-dashed border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-500 hover:border-green-500 hover:text-green-500">
            <IconPlus className="h-3 w-3" /> alias
          </button>
        )}
      </div>
    </div>
  );
}
