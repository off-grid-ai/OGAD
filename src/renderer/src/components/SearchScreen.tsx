import { useCallback, useEffect, useRef, useState } from 'react';
import { IconSearch, IconLoader2, IconPhoto, IconUser, IconHash, IconVideo, IconBulb, IconExternalLink } from '@tabler/icons-react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api;

export interface SearchHit {
  key: string;
  kind: 'screen' | 'meeting' | 'memory' | 'entity' | 'fact';
  refId: number;
  title: string;
  snippet: string;
  surface: string;
  url: string | null;
  ts: number;
  imagePath: string | null;
  score: number;
}

const KIND_ICON = {
  screen: IconPhoto,
  meeting: IconVideo,
  memory: IconBulb,
  entity: IconUser,
  fact: IconHash,
} as const;

function timeAgo(ms: number): string {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function ResultRow({ hit, onOpen }: { hit: SearchHit; onOpen: (h: SearchHit) => void }): React.ReactElement {
  const Icon = KIND_ICON[hit.kind] ?? IconSearch;
  return (
    <button
      onClick={() => onOpen(hit)}
      className="group flex w-full items-start gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2.5 text-left transition-colors hover:border-green-500/60 hover:bg-neutral-900"
    >
      {hit.imagePath ? (
        <img src={`ogcapture://${hit.imagePath}`} alt="" className="h-12 w-16 shrink-0 rounded border border-neutral-800 object-cover" />
      ) : (
        <div className="flex h-12 w-16 shrink-0 items-center justify-center rounded border border-neutral-800 bg-neutral-900">
          <Icon className="h-4 w-4 text-neutral-500" aria-hidden />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-white">{hit.title}</span>
          <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">{hit.kind}</span>
          {hit.url && <IconExternalLink className="h-3 w-3 shrink-0 text-neutral-600 group-hover:text-green-500" aria-hidden />}
          <span className="ml-auto shrink-0 text-[10px] text-neutral-600">{timeAgo(hit.ts)}</span>
        </div>
        <p className="mt-1 line-clamp-2 text-xs text-neutral-500">{hit.snippet}</p>
      </div>
    </button>
  );
}

export function SearchScreen({ initialQuery = '', onOpen }: { initialQuery?: string; onOpen: (h: SearchHit) => void }): React.ReactElement {
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ vectors: number; pending: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const run = useCallback(async (q: string) => {
    if (!q.trim()) { setHits([]); return; }
    setLoading(true);
    try {
      setHits((await api.universalSearch(q, { limit: 40, semantic: true })) as SearchHit[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { void api.searchStatus().then(setStatus).catch(() => {}); }, []);
  useEffect(() => { if (initialQuery) void run(initialQuery); }, [initialQuery, run]);

  // Debounce typing → search.
  useEffect(() => {
    const t = setTimeout(() => void run(query), 220);
    return () => clearTimeout(t);
  }, [query, run]);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col font-mono">
      <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2.5">
        {loading ? <IconLoader2 className="h-4 w-4 animate-spin text-green-500" aria-hidden /> : <IconSearch className="h-4 w-4 text-neutral-500" aria-hidden />}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search everything you've seen, said, and saved…"
          aria-label="Universal search"
          className="w-full bg-transparent text-sm text-white placeholder-neutral-600 outline-none"
        />
      </div>

      {status && status.pending > 0 && (
        <p className="px-1 pt-2 text-[11px] text-neutral-600">Sharpening results…</p>
      )}

      <div className="mt-3 flex-1 space-y-2 overflow-y-auto pb-8">
        {hits.map((h) => <ResultRow key={h.key} hit={h} onOpen={onOpen} />)}
        {!loading && query.trim() && hits.length === 0 && (
          <p className="px-1 py-8 text-center text-sm text-neutral-600">Nothing found for “{query}”.</p>
        )}
        {!query.trim() && (
          <p className="px-1 py-8 text-center text-sm text-neutral-600">Type to search across screen captures, meetings, memories, people, and notes.</p>
        )}
      </div>
    </div>
  );
}
