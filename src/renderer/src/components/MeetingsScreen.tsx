import { useEffect, useState, useCallback } from 'react';
import { IconLoader2, IconMicrophone, IconPlayerStopFilled, IconTrash, IconVideo } from '@tabler/icons-react';
import type { MeetingRecorder } from '../useMeetingRecorder';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api;

interface Meeting {
  id: number;
  title: string | null;
  transcript: string | null;
  summary: string | null;
  audio_path: string | null;
  started_at: number | null;
  duration_sec: number | null;
}

function fmtDur(s: number | null): string {
  if (!s) return '';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}
function fmtWhen(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
}

export function MeetingsScreen({ rec }: { rec: MeetingRecorder }) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const rows = ((await api.meetingList?.()) ?? []) as Meeting[];
    setMeetings(rows);
    setSelectedId((cur) => (cur != null && rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? null));
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!api.onCrmChanged) return;
    return api.onCrmChanged(load);
  }, [load]);
  useEffect(() => { if (!rec.busy) void load(); }, [rec.busy, load]);

  const del = async (id: number): Promise<void> => {
    await api.meetingDelete?.(id);
    load();
  };

  const selected = meetings.find((m) => m.id === selectedId) ?? null;

  return (
    <div className="flex h-full flex-col bg-neutral-950 font-mono">
      <div className="flex items-center justify-between border-b border-neutral-900 px-6 py-4">
        <div className="flex items-center gap-3">
          <IconVideo className="h-5 w-5 text-green-500" />
          <div>
            <h1 className="text-lg tracking-tight text-white">Meetings</h1>
            <div className="text-[11px] uppercase tracking-wide text-neutral-600">Auto-records Zoom/Meet/Teams · screen + speaker + mic · transcribed on device</div>
          </div>
        </div>
        {rec.recording ? (
          <button onClick={rec.stop} className="flex items-center gap-2 rounded-md bg-red-500 px-3.5 py-1.5 text-xs text-white hover:bg-red-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-white" /> <IconPlayerStopFilled className="h-3.5 w-3.5" /> Stop · {fmtDur(rec.elapsed)}
          </button>
        ) : rec.busy ? (
          <span className="flex items-center gap-2 text-xs text-neutral-400"><IconLoader2 className="h-4 w-4 animate-spin" /> Transcribing…</span>
        ) : (
          <button onClick={() => rec.start()} className="flex items-center gap-2 rounded-md bg-green-500 px-3.5 py-1.5 text-xs text-neutral-950 hover:bg-green-400">
            <IconMicrophone className="h-4 w-4" /> Record meeting
          </button>
        )}
      </div>

      {/* Desktop master–detail: meeting list ⟶ player + summary + transcript. */}
      <div className="flex min-h-0 flex-1">
        <div className="w-[32%] min-w-[280px] shrink-0 overflow-y-auto border-r border-neutral-900 p-3">
          {rec.error && <p className="mb-2 rounded-md border border-red-500/40 bg-red-500/5 p-2.5 text-xs text-red-400">{rec.error}</p>}
          {meetings.length === 0 && !rec.recording && !rec.busy ? (
            <div className="px-3 py-16 text-center text-neutral-600">
              <IconVideo className="mx-auto mb-3 h-9 w-9 opacity-40" />
              <p className="text-xs leading-relaxed">No meetings yet. Off Grid auto-records Zoom / Google Meet calls — or hit “Record meeting”.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {meetings.map((m) => {
                const active = m.id === selectedId;
                return (
                  <button
                    key={m.id}
                    onClick={() => setSelectedId(m.id)}
                    className={`group flex w-full items-start gap-2 rounded-md border px-3 py-2.5 text-left transition-colors ${
                      active ? 'border-green-500/60 bg-neutral-900' : 'border-transparent hover:border-neutral-800 hover:bg-neutral-900/50'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-sm ${active ? 'text-white' : 'text-neutral-200'}`}>{m.title || 'Meeting'}</p>
                      <div className="mt-0.5 text-[11px] text-neutral-500">{fmtWhen(m.started_at)} · {fmtDur(m.duration_sec)}</div>
                      {!m.summary && !m.transcript && (
                        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-600"><IconLoader2 className="h-3 w-3 animate-spin" /> Transcribing…</p>
                      )}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); del(m.id); }}
                      className="shrink-0 text-neutral-700 opacity-0 transition group-hover:opacity-100 hover:text-red-400"
                      aria-label="Delete meeting"
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                    </button>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          {rec.recording && (
            <p className="mb-4 rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-400">
              Recording your current screen + speaker audio + mic, on device. It stops automatically when the call ends, or hit Stop.
            </p>
          )}
          {!selected ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-600">Select a meeting to view it.</div>
          ) : (
            <div className="mx-auto max-w-4xl space-y-5">
              <div>
                <h2 className="text-lg text-white">{selected.title || 'Meeting'}</h2>
                <div className="mt-0.5 text-xs text-neutral-500">{fmtWhen(selected.started_at)} · {fmtDur(selected.duration_sec)}</div>
              </div>
              {selected.audio_path && (
                <video key={selected.id} src={`ogcapture://${selected.audio_path}`} controls className="aspect-video w-full rounded-md border border-neutral-800 bg-black" />
              )}
              {selected.summary && (
                <div>
                  <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-neutral-500">Summary</h3>
                  <p className="text-sm leading-relaxed text-neutral-300">{selected.summary}</p>
                </div>
              )}
              {selected.transcript ? (
                <div>
                  <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-neutral-500">Transcript</h3>
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-400">{selected.transcript}</p>
                </div>
              ) : (
                <p className="flex items-center gap-1.5 text-xs text-neutral-600"><IconLoader2 className="h-3 w-3 animate-spin" /> Transcribing on device…</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
