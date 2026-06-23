// Native meeting recording orchestration.
//
// Spawns the bundled Swift `meeting-recorder` (ScreenCaptureKit + AVFoundation),
// which writes screen.mov (video + system audio) and mic.m4a. On stop we mux the
// two with the bundled ffmpeg (amix) into one mp4 — so the far side is always
// captured, independent of the user's audio output device — then transcribe +
// summarize + store via the existing meetings pipeline.

import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { app } from 'electron';
import { saveMeetingFromFile } from './meetings';
import { whisperBin, whisperModel } from './rag/extractors';
import { getDB } from './database';

const execFileAsync = promisify(execFile);

function existing(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function recorderBin(): string | null {
  return existing(
    app.isPackaged
      ? [
          path.join(process.resourcesPath, 'bin', 'meeting-recorder'),
          path.join(process.resourcesPath, 'scripts', 'meeting-recorder', 'meeting-recorder'),
        ]
      : [
          path.join(process.cwd(), 'scripts', 'meeting-recorder', 'meeting-recorder'),
          path.join(app.getAppPath(), 'scripts', 'meeting-recorder', 'meeting-recorder'),
        ]
  );
}

function ffmpegBin(): string | null {
  return existing([
    path.join(process.resourcesPath ?? '', 'bin', 'ffmpeg'),
    path.join(app.getAppPath(), 'resources', 'bin', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ]);
}

interface Session {
  child: ChildProcess;
  dir: string;
  startedAt: number;
  stdout: string;
}

let session: Session | null = null;

/** Start a native recording. Returns { ok } or { error }. */
export function startMeetingRecording(platform?: string): { ok: true } | { error: string } {
  if (session) return { error: 'A recording is already in progress.' };
  const bin = recorderBin();
  if (!bin) return { error: 'Meeting recorder binary not found. Build it with scripts/build-meeting-recorder.sh.' };

  const startedAt = Date.now();
  const dir = path.join(os.tmpdir(), `offgrid-meeting-${startedAt}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not create recording dir' };
  }

  // Pass the platform so the recorder can target the meeting window (Meet/Zoom/
  // Teams) rather than guessing a display.
  const args = [dir, platform || 'meet'];
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const s: Session = { child, dir, startedAt, stdout: '' };
  child.stdout?.on('data', (d) => { s.stdout += d.toString(); });
  child.stderr?.on('data', (d) => console.log('[meeting-rec]', d.toString().trim()));
  child.on('error', (e) => console.error('[meeting-rec] spawn error', e));
  session = s;
  return { ok: true };
}

function muxToMp4(screen: string, mic: string, out: string): Promise<void> {
  const ff = ffmpegBin();
  if (!ff) {
    // No ffmpeg — fall back to the screen file as-is (still has the far side).
    return fs.promises.copyFile(screen, out);
  }
  const hasMic = mic && fs.existsSync(mic) && fs.statSync(mic).size > 0;
  // ScreenCaptureKit emits VARIABLE frame rate (a frame only on screen change) on
  // an odd timebase. Copying that (-c:v copy) yields an mp4 whose first frame the
  // <video> element can't decode on long recordings — metadata loads but playback
  // sticks at 0:00. So re-encode to CONSTANT 10fps yuv420p (hardware h264 via
  // VideoToolbox — fast) so it always plays. +faststart puts the moov up front.
  const VID = ['-c:v', 'h264_videotoolbox', '-b:v', '2500k', '-pix_fmt', 'yuv420p'];
  // Audio balance: input 0 = screen (SYSTEM audio = the far side, usually loud);
  // input 1 = mic (you, usually quiet). Boost the mic, mix, then dynamic-normalize
  // so both sides sit at a comparable, audible level instead of "they're loud, you
  // can't be heard". dynaudnorm also lifts quiet stretches for transcription.
  const args = hasMic
    ? ['-y', '-i', screen, '-i', mic,
       '-filter_complex', '[0:v]fps=10[v];[1:a]volume=3.0[m];[0:a][m]amix=inputs=2:duration=longest:normalize=0[mx];[mx]dynaudnorm[a]',
       '-map', '[v]', '-map', '[a]', ...VID, '-c:a', 'aac', '-movflags', '+faststart', out]
    : ['-y', '-i', screen, '-vf', 'fps=10', '-filter:a', 'dynaudnorm', '-map', '0:v', '-map', '0:a?', ...VID, '-c:a', 'aac', '-movflags', '+faststart', out];
  return execFileAsync(ff, args, { maxBuffer: 1024 * 1024 }).then(() => undefined);
}

/**
 * Stop the recording: finalize the native files, mux to one mp4, then
 * transcribe + summarize + store. Returns the saved meeting (or an error).
 */
export async function stopMeetingRecording(): Promise<{ id: number; title: string } | { error: string }> {
  const s = session;
  session = null;
  if (!s) return { error: 'No recording in progress.' };

  // Ask the recorder to finalize, then wait for it to exit (it prints the paths).
  const exited = new Promise<void>((resolve) => {
    s.child.once('exit', () => resolve());
    // Safety net: don't hang forever if the child wedges.
    setTimeout(() => { try { s.child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 20_000);
  });
  try { s.child.kill('SIGINT'); } catch { /* ignore */ }
  await exited;

  const endedAt = Date.now();
  let screen = path.join(s.dir, 'screen.mov');
  let mic = path.join(s.dir, 'mic.m4a');
  try {
    const line = s.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (line) {
      const parsed = JSON.parse(line) as { screen?: string; mic?: string };
      if (parsed.screen) screen = parsed.screen;
      if (typeof parsed.mic === 'string') mic = parsed.mic;
    }
  } catch {
    /* use defaults */
  }

  if (!fs.existsSync(screen)) {
    cleanupDir(s.dir);
    return { error: 'Recording produced no video (screen capture permission?).' };
  }

  const finalPath = path.join(s.dir, `meeting-${s.startedAt}.mp4`);
  try {
    await muxToMp4(screen, mic, finalPath);
  } catch (e) {
    console.error('[meeting-rec] mux failed, falling back to screen file', e);
    try { fs.copyFileSync(screen, finalPath); } catch { /* ignore */ }
  }

  // Diarize from the SEPARATE source tracks (mic = you, system audio = far side)
  // before they're cleaned up. Falls back to plain transcription of the mixed
  // file inside saveMeetingFromFile if this yields nothing.
  let diarized = '';
  try {
    diarized = await buildDiarizedTranscript(screen, mic);
  } catch (e) {
    console.error('[meeting-rec] diarize failed', e);
  }

  try {
    const res = await saveMeetingFromFile(finalPath, { startedAt: s.startedAt, endedAt, ext: 'mp4' }, diarized || undefined);
    cleanupDir(s.dir, finalPath);
    if (res.error) return { error: res.error };
    return { id: res.id, title: res.title };
  } catch (e) {
    cleanupDir(s.dir);
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function isMeetingRecording(): boolean {
  return session !== null;
}

// ---------------------------------------------------------------------------
// Diarization
//
// We capture the two sides of the call on SEPARATE tracks: mic.m4a is you, and
// the system audio (inside screen.mov) is everyone on the far side. So we get
// reliable speaker separation for free — transcribe each source with timestamps,
// label them, and interleave by time. (Splitting MULTIPLE remote participants
// out of the single system stream needs an acoustic diarization model; that's a
// later add. "You" vs "Others" is correct today, and the LLM summary maps the
// far side to real names from context.)
// ---------------------------------------------------------------------------

interface Segment { start: number; speaker: string; text: string }

function hmsToSec(h: string, m: string, s: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function isNoise(t: string): boolean {
  const x = t.trim();
  if (!x) return true;
  // whisper emits things like [BLANK_AUDIO], (silence), *music* for non-speech.
  return /^[[(*].*[\])*]$/.test(x);
}

/** Transcribe one audio source to timestamped segments, tagged with a speaker. */
async function transcribeSegments(srcAudio: string, speaker: string): Promise<Segment[]> {
  if (!fs.existsSync(srcAudio) || fs.statSync(srcAudio).size === 0) return [];
  const ff = ffmpegBin();
  const wbin = whisperBin();
  const model = whisperModel();
  if (!ff || !wbin || !model) return [];

  const wav = path.join(path.dirname(srcAudio), `stt-${speaker}-${path.basename(srcAudio)}.wav`);
  try {
    await execFileAsync(ff, ['-y', '-i', srcAudio, '-ar', '16000', '-ac', '1', '-f', 'wav', wav]);
    // Keep timestamps (no -nt) so we can interleave the two speakers by time.
    // -l auto detects the language; -mc 0 + -sns prevent the repetition/
    // hallucination loop and suppress non-speech tokens.
    const { stdout } = await execFileAsync(wbin, ['-m', model, '-f', wav, '-l', 'auto', '-mc', '0', '-sns', '-np'], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const segs: Segment[] = [];
    const re = /\[(\d+):(\d+):(\d+(?:\.\d+)?)\s*-->\s*\d+:\d+:\d+(?:\.\d+)?\]\s*(.*)/;
    for (const line of stdout.split('\n')) {
      const m = re.exec(line);
      if (!m) continue;
      const text = m[4].trim();
      if (isNoise(text)) continue;
      segs.push({ start: hmsToSec(m[1], m[2], m[3]), speaker, text });
    }
    return segs;
  } catch (e) {
    console.error('[meeting-rec] transcribeSegments failed', e);
    return [];
  } finally {
    fs.promises.unlink(wav).catch(() => {});
  }
}

/** Build a diarized transcript by interleaving the mic (you) and system (far
 *  side) segments in time order. Returns '' if neither side produced speech. */
async function buildDiarizedTranscript(screenMov: string, micFile: string): Promise<string> {
  const [you, them] = await Promise.all([
    fs.existsSync(micFile) ? transcribeSegments(micFile, 'You') : Promise.resolve([]),
    transcribeSegments(screenMov, 'Them'), // system audio lives in the .mov
  ]);
  const all = [...you, ...them].sort((a, b) => a.start - b.start);
  if (!all.length) return '';

  // Collapse consecutive segments from the same speaker into one line.
  const lines: string[] = [];
  let cur: { speaker: string; parts: string[] } | null = null;
  for (const s of all) {
    if (cur && cur.speaker === s.speaker) {
      cur.parts.push(s.text);
    } else {
      if (cur) lines.push(`${cur.speaker}: ${cur.parts.join(' ')}`);
      cur = { speaker: s.speaker, parts: [s.text] };
    }
  }
  if (cur) lines.push(`${cur.speaker}: ${cur.parts.join(' ')}`);
  return lines.join('\n');
}

function cleanupDir(dir: string, keep?: string): void {
  // Remove the temp intermediates; the final file is moved into the meetings
  // store by saveMeetingFromFile, so we can drop the whole temp dir.
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (keep && p === keep) continue;
      fs.rmSync(p, { force: true });
    }
    fs.rmdirSync(dir);
  } catch {
    /* ignore */
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Adopt recordings orphaned by a crash or restart mid-call. The native recorder
 * is a separate process that keeps running (writing screen.mov + mic.m4a to a
 * temp dir) even if the app that spawned it dies — so the media is never lost,
 * but `stopMeetingRecording` never ran to finalize it. On startup we find those
 * temp dirs, ask any still-running recorder to finalize (SIGINT), then mux +
 * diarize + store via the normal pipeline. Idempotent: skips dirs already saved.
 */
export async function recoverOrphanTempDirs(): Promise<void> {
  let names: string[];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^offgrid-meeting-(\d+)$/.exec(name);
    if (!m) continue;
    const dir = path.join(os.tmpdir(), name);
    if (session && session.dir === dir) continue; // the live recording — leave it
    const screen = path.join(dir, 'screen.mov');
    try {
      if (!fs.existsSync(screen) || fs.statSync(screen).size < 1024) continue;
    } catch {
      continue;
    }
    const startedAt = Number(m[1]);
    try {
      const row = getDB().prepare('SELECT id FROM meetings WHERE started_at = ?').get(startedAt);
      if (row) {
        cleanupDir(dir); // already recovered — reclaim the (large) temp media
        continue;
      }
    } catch {
      /* db not ready — try again next launch */
      continue;
    }
    // A recorder may STILL be running for this orphan (it outlived its parent).
    // Ask it to finalize cleanly (closes the mp4 moov atom), then give it a moment.
    try {
      await execFileAsync('pkill', ['-INT', '-f', `meeting-recorder ${dir}`]);
      await delay(3000);
    } catch {
      /* no live recorder — files are already final */
    }
    const mic = path.join(dir, 'mic.m4a');
    const finalPath = path.join(dir, `meeting-${startedAt}.mp4`);
    let endedAt = startedAt;
    try {
      endedAt = Math.max(startedAt, Math.round(fs.statSync(screen).mtimeMs));
    } catch {
      /* keep startedAt */
    }
    console.log('[meetings] recovering orphaned recording from temp:', name);
    try {
      await muxToMp4(screen, mic, finalPath);
    } catch {
      try {
        fs.copyFileSync(screen, finalPath);
      } catch {
        /* ignore */
      }
    }
    // Diarize from the SEPARATE tracks (mic = you, system audio = far side) while
    // they still exist — gives You/Them labels for free. The mux removes the temp
    // tracks afterward, so a recovered-from-mixed file can't be diarized later.
    let diarized = '';
    try {
      diarized = await buildDiarizedTranscript(screen, mic);
    } catch {
      /* fall back to plain transcription inside saveMeetingFromFile */
    }
    try {
      await saveMeetingFromFile(finalPath, { startedAt, endedAt, ext: 'mp4' }, diarized || undefined);
      cleanupDir(dir);
    } catch (e) {
      console.error('[meetings] temp-dir recovery failed for', name, e);
    }
  }
}
