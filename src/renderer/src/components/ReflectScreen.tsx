import { useEffect, useState, useCallback } from 'react';
import {
  IconChevronLeft,
  IconChevronRight,
  IconCalendar,
  IconLoader2,
  IconChartPie,
  IconArrowsShuffle,
  IconTargetArrow,
} from '@tabler/icons-react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api;

interface Slice {
  key: string;
  name: string;
  type: string;
  sec: number;
  pct: number;
}
interface Reflection {
  totalActiveSec: number;
  observationCount: number;
  mindShare: Slice[];
  categories: { category: string; sec: number; pct: number }[];
  apps: { app: string; sec: number; pct: number }[];
  contextSwitches: number;
  switchesPerHour: number;
  longestFocusSec: number;
  avgFocusSec: number;
}
interface DayTrend {
  dayStartSec: number;
  totalActiveSec: number;
  work: number;
  communication: number;
  consumption: number;
  other: number;
  switchesPerHour: number;
  longestFocusSec: number;
}
interface WeekReflection {
  days: DayTrend[];
  mindShare: Slice[];
  totalActiveSec: number;
  avgSwitchesPerHour: number;
  deepWorkSec: number;
}

const PALETTE = ['#34D399', '#22D3EE', '#A78BFA', '#F59E0B', '#60A5FA', '#F472B6', '#4ADE80', '#FB923C', '#818CF8', '#2DD4BF'];
function colorFor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (d: Date): boolean => startOfDay(d).getTime() === startOfDay(new Date()).getTime();
function fmtDur(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.round(secs / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const CAT_LABEL: Record<string, string> = {
  work: 'Work / building',
  communication: 'Communication',
  consumption: 'Consumption',
  other: 'Other',
};
const CAT_COLOR: Record<string, string> = {
  work: '#34D399',
  communication: '#60A5FA',
  consumption: '#F59E0B',
  other: '#737373',
};
const CARD = 'rounded-lg border border-neutral-800 bg-neutral-900/30 p-5';

export function ReflectScreen() {
  const [day, setDay] = useState<Date>(() => startOfDay(new Date()));
  const [mode, setMode] = useState<'day' | 'week'>('day');
  const [data, setData] = useState<Reflection | null>(null);
  const [week, setWeek] = useState<WeekReflection | null>(null);
  const [loading, setLoading] = useState(true);

  const dayStartSec = useCallback((): number => Math.floor(startOfDay(day).getTime() / 1000), [day]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = dayStartSec();
      if (mode === 'day') setData((await api.crmDayReflection?.(s, s + 86400)) ?? null);
      else setWeek((await api.crmWeekReflection?.(s)) ?? null);
    } finally {
      setLoading(false);
    }
  }, [dayStartSec, mode]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!api.onCrmChanged) return;
    const off = api.onCrmChanged(() => {
      if (sameDay(day)) void load();
    });
    return off;
  }, [day, load]);

  const stepDays = mode === 'week' ? 7 : 1;

  return (
    <div className="h-full overflow-y-auto bg-neutral-950 font-mono">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-900 px-6 py-4">
        <div className="flex items-center gap-3">
          <IconChartPie className="h-5 w-5 text-green-500" />
          <div>
            <h1 className="text-lg tracking-tight text-white">Reflect</h1>
            <div className="text-[11px] uppercase tracking-wide text-neutral-600">
              {mode === 'day'
                ? `${sameDay(day) ? 'Today' : day.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}${data && data.totalActiveSec > 0 ? `  ·  ${fmtDur(data.totalActiveSec)} active` : ''}`
                : `7 days${week && week.totalActiveSec > 0 ? `  ·  ${fmtDur(week.totalActiveSec)} active` : ''}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Day | Week toggle */}
          <div className="flex items-center gap-0.5 rounded-full border border-neutral-800 p-0.5">
            {(['day', 'week'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-full px-3 py-1 text-xs capitalize transition-colors ${
                  mode === m ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-white'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setDay(new Date(day.getTime() - stepDays * 86400000))} className="rounded p-1.5 text-neutral-500 hover:bg-neutral-900 hover:text-white">
              <IconChevronLeft className="h-4 w-4" />
            </button>
            <span className="flex items-center gap-1.5 px-2 text-sm text-neutral-300">
              <IconCalendar className="h-3.5 w-3.5 text-neutral-600" />
              {sameDay(day) ? (mode === 'week' ? 'This week' : 'Today') : day.toLocaleDateString([], { month: 'short', day: 'numeric' })}
            </span>
            <button
              onClick={() => setDay(new Date(day.getTime() + stepDays * 86400000))}
              disabled={sameDay(day)}
              className="rounded p-1.5 text-neutral-500 hover:bg-neutral-900 hover:text-white disabled:opacity-30"
            >
              <IconChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {mode === 'day' ? <DayPanel data={data} loading={loading} isToday={sameDay(day)} /> : <WeekPanel data={week} loading={loading} />}
    </div>
  );
}

function DayPanel({ data, loading, isToday }: { data: Reflection | null; loading: boolean; isToday: boolean }): React.ReactElement {
  const total = data?.totalActiveSec ?? 0;
  const top = data?.mindShare?.filter((s) => s.pct >= 0.01).slice(0, 8) ?? [];

  if (loading && !data)
    return <Centered><IconLoader2 className="h-4 w-4 animate-spin" /> Reading your day…</Centered>;
  if (!data || total === 0)
    return (
      <Empty>No activity captured {isToday ? 'yet today' : 'this day'}.</Empty>
    );

  return (
    <div className="grid grid-cols-1 gap-5 px-8 py-6 lg:grid-cols-3">
      <section className={`${CARD} lg:col-span-2`}>
        <h2 className="mb-3 text-[11px] uppercase tracking-wide text-neutral-500">Mind share — what you gave attention to</h2>
        <div className="mb-4 flex h-3 w-full overflow-hidden rounded-full bg-neutral-900">
          {top.map((s) => (
            <div key={s.key} style={{ width: `${s.pct * 100}%`, backgroundColor: colorFor(s.name) }} title={`${s.name} · ${Math.round(s.pct * 100)}%`} />
          ))}
        </div>
        <div className="space-y-2">
          {top.map((s) => (
            <div key={s.key} className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: colorFor(s.name) }} />
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">{s.name}</span>
              <span className="text-xs text-neutral-500">{fmtDur(s.sec)}</span>
              <span className="w-10 text-right text-xs tabular-nums text-neutral-400">{Math.round(s.pct * 100)}%</span>
            </div>
          ))}
        </div>
      </section>

      <div className="space-y-5">
        <section className={CARD}>
          <h2 className="mb-3 text-[11px] uppercase tracking-wide text-neutral-500">Balance</h2>
          <div className="mb-3 flex h-3 w-full overflow-hidden rounded-full bg-neutral-900">
            {data.categories.map((c) => (
              <div key={c.category} style={{ width: `${c.pct * 100}%`, backgroundColor: CAT_COLOR[c.category] ?? '#737373' }} title={`${CAT_LABEL[c.category] ?? c.category} · ${Math.round(c.pct * 100)}%`} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {data.categories.map((c) => (
              <div key={c.category} className="flex items-center gap-2 text-xs">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CAT_COLOR[c.category] ?? '#737373' }} />
                <span className="text-neutral-300">{CAT_LABEL[c.category] ?? c.category}</span>
                <span className="text-neutral-500">{Math.round(c.pct * 100)}% · {fmtDur(c.sec)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className={CARD}>
          <h2 className="mb-3 text-[11px] uppercase tracking-wide text-neutral-500">Focus & context switching</h2>
          <div className="grid grid-cols-2 gap-3">
            <Stat icon={<IconArrowsShuffle className="h-4 w-4" />} value={String(data.contextSwitches)} label="switches" />
            <Stat icon={<IconArrowsShuffle className="h-4 w-4" />} value={String(data.switchesPerHour)} label="per hour" accent={data.switchesPerHour > 30} />
            <Stat icon={<IconTargetArrow className="h-4 w-4" />} value={fmtDur(data.longestFocusSec)} label="longest focus" />
            <Stat icon={<IconTargetArrow className="h-4 w-4" />} value={fmtDur(data.avgFocusSec)} label="avg focus" />
          </div>
          {data.switchesPerHour > 30 && (
            <p className="mt-3 text-xs leading-relaxed text-amber-400/80">
              Fragmented — you switched contexts {data.switchesPerHour}× per hour.
            </p>
          )}
        </section>
      </div>

      <section className={`${CARD} lg:col-span-3`}>
        <h2 className="mb-3 text-[11px] uppercase tracking-wide text-neutral-500">Time by app</h2>
        <div className="space-y-1.5">
          {data.apps.map((a) => (
            <div key={a.app} className="flex items-center gap-4">
              <span className="w-40 shrink-0 truncate text-sm text-neutral-300">{a.app}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-900">
                <div className="h-full rounded-full bg-neutral-600" style={{ width: `${a.pct * 100}%` }} />
              </div>
              <span className="w-14 text-right text-xs text-neutral-500">{fmtDur(a.sec)}</span>
            </div>
          ))}
        </div>
      </section>

      <p className="text-[11px] text-neutral-700 lg:col-span-3">
        Estimated from {data.observationCount} captured moments. Time is approximate (dwell between samples).
      </p>
    </div>
  );
}

function WeekPanel({ data, loading }: { data: WeekReflection | null; loading: boolean }): React.ReactElement {
  if (loading && !data) return <Centered><IconLoader2 className="h-4 w-4 animate-spin" /> Reading your week…</Centered>;
  if (!data || data.totalActiveSec === 0) return <Empty>No activity captured this week.</Empty>;

  const maxDay = Math.max(1, ...data.days.map((d) => d.totalActiveSec));
  const top = data.mindShare.filter((s) => s.pct >= 0.01).slice(0, 8);

  return (
    <div className="grid grid-cols-1 gap-5 px-8 py-6 lg:grid-cols-3">
      {/* Daily trend bars */}
      <section className={`${CARD} lg:col-span-2`}>
        <h2 className="mb-4 text-[11px] uppercase tracking-wide text-neutral-500">Daily activity — work vs communication vs consumption</h2>
        <div className="flex h-48 items-end gap-3">
          {data.days.map((d) => {
            const dt = new Date(d.dayStartSec * 1000);
            const segs: [string, number][] = [
              ['work', d.work],
              ['communication', d.communication],
              ['consumption', d.consumption],
              ['other', d.other],
            ];
            return (
              <div key={d.dayStartSec} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                <div className="flex w-full flex-1 flex-col justify-end">
                  <div
                    className="flex w-full flex-col-reverse overflow-hidden rounded-md"
                    style={{ height: `${(d.totalActiveSec / maxDay) * 100}%`, minHeight: d.totalActiveSec > 0 ? 4 : 0 }}
                    title={`${dt.toLocaleDateString([], { weekday: 'short' })} · ${fmtDur(d.totalActiveSec)}`}
                  >
                    {segs.map(([cat, sec]) =>
                      sec > 0 ? <div key={cat} style={{ height: `${(sec / d.totalActiveSec) * 100}%`, backgroundColor: CAT_COLOR[cat] }} /> : null
                    )}
                  </div>
                </div>
                <span className="text-[10px] text-neutral-500">{dt.toLocaleDateString([], { weekday: 'short' })}</span>
                <span className="text-[10px] text-neutral-700">{d.totalActiveSec > 0 ? fmtDur(d.totalActiveSec) : '—'}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1">
          {(['work', 'communication', 'consumption'] as const).map((c) => (
            <div key={c} className="flex items-center gap-2 text-xs">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CAT_COLOR[c] }} />
              <span className="text-neutral-400">{CAT_LABEL[c]}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Week stats */}
      <div className="space-y-5">
        <section className={CARD}>
          <h2 className="mb-3 text-[11px] uppercase tracking-wide text-neutral-500">This week</h2>
          <div className="grid grid-cols-2 gap-3">
            <Stat icon={<IconTargetArrow className="h-4 w-4" />} value={fmtDur(data.deepWorkSec)} label="deep work" />
            <Stat icon={<IconChartPie className="h-4 w-4" />} value={fmtDur(Math.round(data.totalActiveSec / 7))} label="avg / day" />
            <Stat icon={<IconArrowsShuffle className="h-4 w-4" />} value={String(data.avgSwitchesPerHour)} label="avg switches/hr" accent={data.avgSwitchesPerHour > 30} />
            <Stat icon={<IconChartPie className="h-4 w-4" />} value={fmtDur(data.totalActiveSec)} label="total active" />
          </div>
        </section>
      </div>

      {/* Week mind share */}
      <section className={`${CARD} lg:col-span-3`}>
        <h2 className="mb-3 text-[11px] uppercase tracking-wide text-neutral-500">Mind share — this week</h2>
        <div className="mb-4 flex h-3 w-full overflow-hidden rounded-full bg-neutral-900">
          {top.map((s) => (
            <div key={s.key} style={{ width: `${s.pct * 100}%`, backgroundColor: colorFor(s.name) }} title={`${s.name} · ${Math.round(s.pct * 100)}%`} />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-x-10 gap-y-2 md:grid-cols-2">
          {top.map((s) => (
            <div key={s.key} className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: colorFor(s.name) }} />
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">{s.name}</span>
              <span className="text-xs text-neutral-500">{fmtDur(s.sec)}</span>
              <span className="w-10 text-right text-xs tabular-nums text-neutral-400">{Math.round(s.pct * 100)}%</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Stat({ icon, value, label, accent }: { icon: React.ReactNode; value: string; label: string; accent?: boolean }): React.ReactElement {
  return (
    <div className={`rounded-md border p-3 ${accent ? 'border-amber-500/40 bg-amber-500/5' : 'border-neutral-800 bg-neutral-900/40'}`}>
      <div className={`mb-1 ${accent ? 'text-amber-400' : 'text-neutral-500'}`}>{icon}</div>
      <div className="text-lg tabular-nums text-white">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-neutral-600">{label}</div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="flex items-center justify-center gap-2 py-24 text-sm text-neutral-600">{children}</div>;
}
function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="py-24 text-center text-neutral-600">
      <IconChartPie className="mx-auto mb-3 h-10 w-10 opacity-40" />
      <p className="text-sm">{children}</p>
    </div>
  );
}
