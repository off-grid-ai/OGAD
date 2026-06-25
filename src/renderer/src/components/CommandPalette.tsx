import { useCallback, useEffect, useRef, useState } from 'react';
import { IconPhoto, IconUser, IconHash, IconVideo, IconBulb, IconSearch, IconCornerDownLeft } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Command, CommandInput, CommandList, CommandItem, CommandGroup, CommandEmpty } from './ui/command';
import type { SearchHit } from '@/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api;

const KIND_ICON = { screen: IconPhoto, meeting: IconVideo, memory: IconBulb, entity: IconUser, fact: IconHash } as const;

interface CommandPaletteProps {
  onOpenHit: (hit: SearchHit) => void;
  onSeeAll: (query: string) => void;
}

// ⌘K universal search launcher. Fast (keyword-only) results; Enter opens, or jump
// to the full Search screen for the semantic pass. Pre-ranked server-side, so
// cmdk's own filtering is disabled (shouldFilter={false}).
export function CommandPalette({ onOpenHit, onSeeAll }: CommandPaletteProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Debounced fast search (keyword only for instant feel).
  useEffect(() => {
    if (!query.trim()) { setHits([]); return undefined; }
    const id = ++seq.current;
    const t = setTimeout(async () => {
      const r = (await api.universalSearch(query, { limit: 8, semantic: false })) as SearchHit[];
      if (id === seq.current) setHits(r);
    }, 140);
    return () => clearTimeout(t);
  }, [query]);

  const open_ = useCallback((h: SearchHit) => { setOpen(false); onOpenHit(h); }, [onOpenHit]);
  const seeAll = useCallback(() => { if (query.trim()) { setOpen(false); onSeeAll(query); } }, [query, onSeeAll]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} className="overflow-hidden p-0">
        <DialogTitle className="sr-only">Search Off Grid</DialogTitle>
        <Command shouldFilter={false} className="font-mono">
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search everything…" />
          <CommandList>
            {query.trim() && hits.length === 0 && <CommandEmpty>No matches — press Enter for a deep search.</CommandEmpty>}
            {hits.length > 0 && (
              <CommandGroup heading="Results">
                {hits.map((h) => {
                  const Icon = KIND_ICON[h.kind] ?? IconSearch;
                  return (
                    <CommandItem key={h.key} value={h.key} onSelect={() => open_(h)} className="gap-3">
                      <Icon className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-white">{h.title}</div>
                        <div className="truncate text-xs text-neutral-500">{h.snippet}</div>
                      </div>
                      <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">{h.kind}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {query.trim() && (
              <CommandGroup>
                <CommandItem value="__see_all__" onSelect={seeAll} className="gap-2 text-green-500">
                  <IconCornerDownLeft className="h-4 w-4 shrink-0" aria-hidden />
                  See all results for “{query}”
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
