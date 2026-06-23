// Meeting recorder — opt-in, explicit start/stop, fully on-device. The renderer
// captures system audio (remote participants, via Electron loopback) mixed with
// the mic (you), and hands the recording here. We transcribe it locally with the
// bundled whisper pipeline, store it, and fold a summary into memory so meetings
// land on the timeline like everything else. Nothing is ever uploaded.

import fs from 'fs';
import path from 'path';
import { app, BrowserWindow } from 'electron';
import { getDB } from './database';
import { desktopExtraction } from './rag/extractors';
import { llm } from './llm';
import { recordObservation } from './crm/observations';

let ready = false;
function ensure(): void {
  if (ready) return;
  getDB().exec(
    `CREATE TABLE IF NOT EXISTS meetings (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       title TEXT,
       transcript TEXT,
       summary TEXT,
       audio_path TEXT,
       started_at INTEGER,
       ended_at INTEGER,
       duration_sec INTEGER,
       created_at INTEGER NOT NULL DEFAULT 0
     )`
  );
  ready = true;
}

function meetingsDir(): string {
  const d = path.join(app.getPath('userData'), 'meetings');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function emitChanged(): void {
  try {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('crm:changed'));
  } catch {
    /* ignore */
  }
}

function extractJson(s: string): string {
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  return a >= 0 && b > a ? s.slice(a, b + 1) : '{}';
}

export interface MeetingRow {
  id: number;
  title: string | null;
  transcript: string | null;
  summary: string | null;
  audio_path: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_sec: number | null;
}

/** Save a recorded meeting from raw bytes (legacy renderer path). */
export async function saveMeeting(
  audio: Uint8Array,
  meta: { startedAt: number; endedAt: number; ext?: string }
): Promise<{ id: number; title: string; transcript: string; error?: string }> {
  ensure();
  const dir = meetingsDir();
  const audioPath = path.join(dir, `meeting-${meta.startedAt}.${meta.ext ?? 'webm'}`);
  await fs.promises.writeFile(audioPath, Buffer.from(audio));
  return processMeeting(audioPath, meta);
}

/** Save a recorded meeting from a file the native recorder already produced. */
export async function saveMeetingFromFile(
  srcPath: string,
  meta: { startedAt: number; endedAt: number; ext?: string },
  preTranscript?: string
): Promise<{ id: number; title: string; transcript: string; error?: string }> {
  ensure();
  const dir = meetingsDir();
  const audioPath = path.join(dir, `meeting-${meta.startedAt}.${meta.ext ?? 'mp4'}`);
  await fs.promises.copyFile(srcPath, audioPath);
  return processMeeting(audioPath, meta, preTranscript);
}

/** Transcribe locally, summarize, and store a meeting whose media is at audioPath.
 *  If preTranscript is given (e.g. a diarized "You:/Them:" transcript built from
 *  the separate mic + system tracks), we skip whisper and use it directly. */
async function processMeeting(
  audioPath: string,
  meta: { startedAt: number; endedAt: number; ext?: string },
  preTranscript?: string
): Promise<{ id: number; title: string; transcript: string; error?: string }> {
  const durationSec = Math.max(0, Math.round((meta.endedAt - meta.startedAt) / 1000));

  // STEP 1 — persist the recording IMMEDIATELY, before any slow transcription /
  // summarization. The media is the irreplaceable part; transcript + summary are
  // derived and can be (re)computed. This guarantees a meeting can never be lost
  // to a transcription error or an app restart mid-processing — it shows up in
  // the UI right away as "Transcribing…" and gets enriched in place.
  const info = getDB()
    .prepare(
      `INSERT INTO meetings (title, transcript, summary, audio_path, started_at, ended_at, duration_sec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('Meeting', '', '', audioPath, meta.startedAt, meta.endedAt, durationSec, Date.now());
  const id = Number(info.lastInsertRowid);
  emitChanged();

  // STEP 2 — transcribe (or use the diarized transcript we were handed).
  let transcript = (preTranscript ?? '').trim();
  if (!transcript) {
    try {
      if (!desktopExtraction.transcribeAudio) throw new Error('Transcription not available');
      transcript = await desktopExtraction.transcribeAudio(audioPath);
    } catch (e) {
      // Keep the row — the user still has the recording and can replay it.
      console.error('[meetings] transcription failed:', e);
      return { id, title: 'Meeting', transcript: '', error: e instanceof Error ? e.message : String(e) };
    }
  }
  transcript = transcript.trim();
  getDB().prepare('UPDATE meetings SET transcript = ? WHERE id = ?').run(transcript, id);
  emitChanged();

  // STEP 3 — title + summary + people, locally. Keep cheap; tolerate empty.
  let title = 'Meeting';
  let summary = '';
  let people: string[] = [];
  if (transcript.length > 20) {
    try {
      const prompt = `Below is a transcript of a call/meeting (speaker-labeled where known). Write a PRECISE recap — be specific, name names. Return JSON only:
{"title": "<3-7 word title naming the actual topic>", "summary": "<a precise recap that NAMES the real people on the call, their company/role, what was actually discussed, key points and decisions, and concrete next steps. Use the real names and specifics from the transcript — never write 'the other person', 'a developer', or 'the client' if a name or company is present.>", "people": ["<full names actually mentioned>"]}

Transcript:
"""
${transcript.slice(0, 12000)}
"""`;
      const resp = await llm.chat(prompt, [], 120_000, 700, { temperature: 0.3, disableThinking: true });
      const p = JSON.parse(extractJson(resp)) as { title?: string; summary?: string; people?: string[] };
      if (p.title) title = p.title.trim().slice(0, 80);
      if (p.summary) summary = p.summary.trim();
      if (Array.isArray(p.people)) people = p.people.filter((x) => typeof x === 'string' && x.trim().length > 1).slice(0, 12);
    } catch (e) {
      console.error('[meetings] summarize failed:', e);
      summary = transcript.slice(0, 280);
    }
  }
  getDB().prepare('UPDATE meetings SET title = ?, summary = ? WHERE id = ?').run(title, summary, id);

  // Fold into memory so it shows on the timeline / counts in reflect.
  try {
    recordObservation({
      summary: summary || `Meeting: ${title}`,
      surface: 'Meeting',
      surfaceApp: 'Meeting',
      category: 'communication',
      engagement: 0.8,
      salience: 0.9,
      mentions: people.map((name) => ({ name, type: 'Person' })),
      frames: [{ app: 'Meeting', text: transcript.slice(0, 6000), source: 'meeting' }],
    });
  } catch (e) {
    console.error('[meetings] recordObservation failed:', e);
  }

  emitChanged();
  return { id, title, transcript };
}

/**
 * On startup, adopt any recording media in the meetings dir that has no DB row
 * — e.g. a recording whose transcription was interrupted by a crash/restart.
 * The media is the irreplaceable part; we insert the row and (re)derive the
 * transcript/summary. Runs sequentially so we don't slam the local LLM.
 */
export async function recoverOrphanedMeetings(): Promise<void> {
  ensure();
  const dir = meetingsDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  const media = files.filter((f) => /\.(mp4|mov|webm|m4a)$/i.test(f));
  for (const f of media) {
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      if (st.size < 1024) {
        fs.rmSync(full, { force: true }); // empty/broken capture
        continue;
      }
      const row = getDB().prepare('SELECT id FROM meetings WHERE audio_path = ?').get(full);
      if (row) continue; // already tracked
      const m = /meeting-(\d+)\./.exec(f);
      const startedAt = m ? Number(m[1]) : st.mtimeMs;
      const endedAt = Math.max(startedAt, st.mtimeMs);
      console.log('[meetings] recovering orphaned recording:', f);
      await processMeeting(full, { startedAt, endedAt, ext: path.extname(f).slice(1) });
    } catch (e) {
      console.error('[meetings] recover failed for', f, e);
    }
  }
}

export function listMeetings(limit = 50): MeetingRow[] {
  ensure();
  return getDB()
    .prepare('SELECT id, title, transcript, summary, audio_path, started_at, ended_at, duration_sec FROM meetings ORDER BY started_at DESC LIMIT ?')
    .all(limit) as MeetingRow[];
}

export function deleteMeeting(id: number): void {
  ensure();
  const row = getDB().prepare('SELECT audio_path FROM meetings WHERE id = ?').get(id) as { audio_path: string } | undefined;
  if (row?.audio_path) fs.promises.unlink(row.audio_path).catch(() => {});
  getDB().prepare('DELETE FROM meetings WHERE id = ?').run(id);
  emitChanged();
}
