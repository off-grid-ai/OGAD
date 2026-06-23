import { useEffect, useState, useCallback, useRef } from 'react';
import {
  IconPlayerPlayFilled,
  IconPlayerPauseFilled,
  IconPlayerSkipBackFilled,
  IconPlayerSkipForwardFilled,
  IconChevronLeft,
  IconChevronRight,
  IconCalendar,
  IconLoader2,
  IconMovie,
} from '@tabler/icons-react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api;

interface Frame {
  ts: number;
  path: string;
  app: string | null;
  caption: string | null;
}

// Clean calendar days (midnight boundary) — Saturday and Sunday stay separate.
const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const fmtTime = (sec: number): string =>
  new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const fmtClock = (sec: number): string =>
  new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const sameDay = (d: Date): boolean => startOfDay(d).getTime() === startOfDay(new Date()).getTime();

// Base playback: advance one frame every BASE_MS at 1×. Speed multiplies.
const BASE_MS = 700;
const SPEEDS = [1, 2, 4, 8, 16];

export function ReplayScreen({ seekToMs }: { seekToMs?: number } = {}) {
  const [day, setDay] = useState<Date>(() => startOfDay(new Date()));
  const [frames, setFrames] = useState<Frame[]>([]);
  const [loading, setLoading] = useState(true);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When arriving from a search result, seek to that exact moment instead of the
  // latest frame. Frame.ts is in seconds; the target is epoch ms.
  const pendingSeek = useRef<number | null>(null);

  const range = useCallback((): [number, number] => {
    const start = startOfDay(day).getTime();
    return [Math.floor(start / 1000), Math.floor((start + 86400000) / 1000)];
  }, [day]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, e] = range();
      const f: Frame[] = (await api.crmReplayFrames?.(s, e)) ?? [];
      setFrames(f);
      if (pendingSeek.current != null && f.length) {
        const target = pendingSeek.current;
        let best = 0;
        let bestD = Infinity;
        f.forEach((fr, i) => {
          const d = Math.abs(fr.ts * 1000 - target);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        setIdx(best);
        pendingSeek.current = null;
      } else {
        setIdx(f.length ? f.length - 1 : 0); // start at the latest moment
      }
    } finally {
      setLoading(false);
    }
  }, [range]);

  // A search jump owns the day — seek to that frame's day + moment.
  useEffect(() => {
    if (seekToMs == null) return;
    pendingSeek.current = seekToMs;
    setDay(startOfDay(new Date(seekToMs)));
  }, [seekToMs]);

  // Land on the day that actually has frames (handles just-after-midnight, when
  // "today" is empty but last evening is full). Skipped when a search jump owns it.
  useEffect(() => {
    if (seekToMs != null) return;
    (async () => {
      const sec = await api.crmReplayDefaultDay?.();
      if (typeof sec === 'number') setDay(startOfDay(new Date(sec * 1000)));
    })();
  }, [seekToMs]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live: when viewing today, pick up new frames as they're captured (only if
  // we're not mid-playback, so we don't yank the user's position around).
  useEffect(() => {
    if (!api.onCrmChanged) return;
    const off = api.onCrmChanged(() => {
      if (sameDay(day) && !playing) void load();
    });
    return off;
  }, [day, playing, load]);

  // Playback loop — advance frames; stop at the end.
  useEffect(() => {
    if (!playing) return;
    if (idx >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    timer.current = setTimeout(() => setIdx((i) => Math.min(frames.length - 1, i + 1)), BASE_MS / speed);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [playing, idx, frames.length, speed]);

  const cur = frames[idx];
  const step = (d: number): void => {
    setPlaying(false);
    setIdx((i) => Math.max(0, Math.min(frames.length - 1, i + d)));
  };
  const toggle = (): void => {
    if (!frames.length) return;
    if (idx >= frames.length - 1) setIdx(0); // replay from start
    setPlaying((p) => !p);
  };

  // Keyboard transport: space = play/pause, ←/→ = step.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        toggle();
      } else if (e.code === 'ArrowLeft') step(-1);
      else if (e.code === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="flex h-full flex-col bg-neutral-950 font-mono">
      {/* Header: day nav + title */}
      <div className="flex items-center justify-between border-b border-neutral-900 px-6 py-3">
        <div className="flex items-center gap-3">
          <IconMovie className="h-5 w-5 text-green-500" />
          <h1 className="text-lg tracking-tight text-white">Replay</h1>
          <span className="text-xs text-neutral-600">{frames.length} frames</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setDay(new Date(day.getTime() - 86400000))} className="rounded p-1.5 text-neutral-500 hover:bg-neutral-900 hover:text-white">
            <IconChevronLeft className="h-4 w-4" />
          </button>
          <span className="flex items-center gap-1.5 px-2 text-sm text-neutral-300">
            <IconCalendar className="h-3.5 w-3.5 text-neutral-600" />
            {sameDay(day) ? 'Today' : day.toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </span>
          <button
            onClick={() => setDay(new Date(day.getTime() + 86400000))}
            disabled={sameDay(day)}
            className="rounded p-1.5 text-neutral-500 hover:bg-neutral-900 hover:text-white disabled:opacity-30"
          >
            <IconChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Stage: image fills the space, commentary lives in its OWN panel on the
          right so it never overlaps the screenshot. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 items-center justify-center bg-black p-4">
          {loading ? (
            <IconLoader2 className="h-6 w-6 animate-spin text-neutral-600" />
          ) : !cur ? (
            <div className="text-center text-neutral-600">
              <IconMovie className="mx-auto mb-3 h-10 w-10 opacity-40" />
              <p className="text-sm">No frames captured {sameDay(day) ? 'yet today' : 'this day'}.</p>
            </div>
          ) : (
            <img
              src={`ogcapture://${cur.path}`}
              alt=""
              className="max-h-full max-w-full rounded-md border border-neutral-800 object-contain shadow-2xl"
            />
          )}
        </div>

        {/* Commentary panel */}
        <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-neutral-900 bg-neutral-950 p-5">
          {cur ? (
            <>
              <div className="flex items-center gap-2 text-sm">
                <span className="font-semibold text-green-500">{cur.app ?? 'Screen'}</span>
              </div>
              <div className="text-xs text-neutral-500">{fmtTime(cur.ts)}</div>
              {cur.caption ? (
                <p className="mt-1 text-sm leading-relaxed text-neutral-300">{cur.caption}</p>
              ) : (
                <p className="mt-1 text-xs italic text-neutral-600">No summary for this frame.</p>
              )}
            </>
          ) : (
            <p className="text-xs text-neutral-600">Select a moment to see what you were doing.</p>
          )}
        </aside>
      </div>

      {/* Transport */}
      <div className="border-t border-neutral-900 px-6 py-4">
        {/* Scrubber */}
        <div className="mb-3 flex items-center gap-3">
          <span className="w-12 shrink-0 text-right text-[11px] text-neutral-500">{cur ? fmtClock(cur.ts) : '—'}</span>
          <input
            type="range"
            min={0}
            max={Math.max(0, frames.length - 1)}
            value={idx}
            onChange={(e) => {
              setPlaying(false);
              setIdx(Number(e.target.value));
            }}
            className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-neutral-800 accent-green-500"
            disabled={!frames.length}
          />
          <span className="w-12 shrink-0 text-[11px] text-neutral-500">
            {frames.length ? `${idx + 1}/${frames.length}` : '0/0'}
          </span>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-center gap-2">
          <button onClick={() => step(-1)} disabled={!frames.length} className="rounded-full p-2 text-neutral-300 hover:bg-neutral-900 hover:text-white disabled:opacity-30">
            <IconPlayerSkipBackFilled className="h-4 w-4" />
          </button>
          <button
            onClick={toggle}
            disabled={!frames.length}
            className="rounded-full bg-green-500 p-3 text-neutral-950 transition-colors hover:bg-green-400 disabled:opacity-30"
          >
            {playing ? <IconPlayerPauseFilled className="h-5 w-5" /> : <IconPlayerPlayFilled className="h-5 w-5" />}
          </button>
          <button onClick={() => step(1)} disabled={!frames.length} className="rounded-full p-2 text-neutral-300 hover:bg-neutral-900 hover:text-white disabled:opacity-30">
            <IconPlayerSkipForwardFilled className="h-4 w-4" />
          </button>

          {/* Speed */}
          <div className="ml-4 flex items-center gap-1 rounded-full border border-neutral-800 p-0.5">
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                  speed === s ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-white'
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
