// Replay / "movie" timeline: every screenshot the capture loop has ever written
// to the captures/ dir, in chronological order, so the renderer can scrub and
// play through the day like a film. We read the DISK (dense — one frame per
// capture tick, ~hundreds/day) rather than the frames table (sparse — only the
// frames attached to a stored observation), and LEFT-JOIN the DB for captions
// (app + what-you-were-doing) where we have them.

import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { getDB } from '../database';
import { migrateCrm } from './schema';

export interface ReplayFrame {
  ts: number; // epoch seconds (from the capture-<ms>.png filename)
  path: string; // absolute path on disk (served to renderer via ogcapture://)
  app: string | null; // captured app, if known from the DB
  caption: string | null; // observation summary, if this frame produced one
}

function capturesDir(): string {
  return path.join(app.getPath('userData'), 'captures');
}

// capture-<epochMs>.png  (exclude the "-crop.png" OCR crops — same moment, ugly)
const FRAME_RE = /^capture-(\d+)\.png$/;

// Blank/failed captures (locked screen, capture errors) write tiny/empty PNGs.
// Real screenshots are 20KB+; solid-color blanks are <1KB. Skip them so the
// movie doesn't flicker through white frames.
const MIN_FRAME_BYTES = 8_000;

const dayStartSec = (ms: number): number => {
  const d = new Date(ms);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
};

/**
 * All captured frames in [startSec, endSec], oldest→newest, enriched with the
 * app + summary from the DB when a frame produced an observation.
 */
export function listReplayFrames(startSec: number, endSec: number): ReplayFrame[] {
  migrateCrm();
  const dir = capturesDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  // Caption lookup: basename -> {app, summary}. A frame row carries the app;
  // the observation it's attached to carries the human summary.
  const captions = new Map<string, { app: string | null; summary: string | null }>();
  try {
    const rows = getDB()
      .prepare(
        `SELECT f.image_path AS imagePath, f.app AS app, o.summary AS summary
         FROM frames f
         LEFT JOIN observation_frames of ON of.frame_id = f.id
         LEFT JOIN observations o ON o.id = of.observation_id
         WHERE f.image_path IS NOT NULL`
      )
      .all() as { imagePath: string; app: string | null; summary: string | null }[];
    for (const r of rows) captions.set(path.basename(r.imagePath), { app: r.app, summary: r.summary });
  } catch {
    /* DB optional — frames still play without captions */
  }

  const out: ReplayFrame[] = [];
  for (const name of files) {
    const m = FRAME_RE.exec(name);
    if (!m) continue;
    const ts = Math.floor(Number(m[1]) / 1000);
    if (!Number.isFinite(ts) || ts < startSec || ts > endSec) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).size < MIN_FRAME_BYTES) continue; // blank/failed capture
    } catch {
      continue;
    }
    const cap = captions.get(name);
    out.push({ ts, path: full, app: cap?.app ?? null, caption: cap?.summary ?? null });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * The calendar day (local) Replay should land on by default: the day with the
 * most real frames among the last few days. Avoids opening to an empty "today"
 * just after midnight when all the action was the evening before.
 */
export function defaultReplayDayStartSec(): number {
  const dir = capturesDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return dayStartSec(Date.now());
  }
  const counts = new Map<number, number>();
  for (const name of files) {
    const m = FRAME_RE.exec(name);
    if (!m) continue;
    const ms = Number(m[1]);
    if (!Number.isFinite(ms)) continue;
    try {
      if (fs.statSync(path.join(dir, name)).size < MIN_FRAME_BYTES) continue;
    } catch {
      continue;
    }
    const key = dayStartSec(ms);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = dayStartSec(Date.now());
  let bestCount = -1;
  for (const [day, n] of counts) {
    if (n > bestCount) {
      best = day;
      bestCount = n;
    }
  }
  return best;
}
