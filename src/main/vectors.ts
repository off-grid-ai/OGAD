// LanceDB vector store (Apache-2.0, embedded/offline) — the semantic half of
// universal search. Lives in a Lance dataset under userData/lancedb, keyed by
// `${kind}:${refId}` back to the SQLite source of truth. MiniLM 384-dim vectors.
import * as lancedb from '@lancedb/lancedb';
import path from 'path';
import { app } from 'electron';

export interface VecChunk {
  key: string; // unique `${kind}:${refId}`
  kind: string; // screen | meeting | memory | entity | fact
  refId: number;
  vector: number[]; // 384-dim, MiniLM (normalized)
  text: string; // short snippet for display
  surface: string;
  url: string;
  ts: number; // epoch ms (0 if unknown)
}

const TABLE = 'chunks';
let connPromise: Promise<lancedb.Connection> | null = null;
let tablePromise: Promise<lancedb.Table | null> | null = null;

function conn(): Promise<lancedb.Connection> {
  if (!connPromise) connPromise = lancedb.connect(path.join(app.getPath('userData'), 'lancedb'));
  return connPromise;
}

async function loadTable(): Promise<lancedb.Table | null> {
  const db = await conn();
  const names = await db.tableNames();
  return names.includes(TABLE) ? db.openTable(TABLE) : null;
}

function table(): Promise<lancedb.Table | null> {
  if (!tablePromise) tablePromise = loadTable();
  return tablePromise;
}

/** Append chunks; lazily creates the table (inferring schema) on first batch. */
export async function addChunks(rows: VecChunk[]): Promise<void> {
  if (!rows.length) return;
  const db = await conn();
  const data = rows as unknown as Record<string, unknown>[];
  const tbl = await table();
  if (tbl) {
    await tbl.add(data);
    return;
  }
  const created = await db.createTable(TABLE, data, { mode: 'create' });
  tablePromise = Promise.resolve(created);
}

/** k-NN over the store. Returns chunks with `_distance` (smaller = closer). */
export async function searchVectors(vector: number[], limit: number): Promise<(VecChunk & { _distance: number })[]> {
  const tbl = await table();
  if (!tbl) return [];
  return (await tbl.query().nearestTo(vector).limit(limit).toArray()) as unknown as (VecChunk & { _distance: number })[];
}

export async function vectorCount(): Promise<number> {
  const tbl = await table();
  return tbl ? tbl.countRows() : 0;
}
