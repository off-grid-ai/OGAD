// Entity resolution + correction — the spine's integrity layer.
//
// Resolution order (biased to UNDER-merge; easier to join later than to divorce):
//   1. hard identifier (email/handle/phone/url) alias hit -> that entity (auto)
//   2. exact name(+type) alias or entities.name hit          -> that entity (auto)
//   3. otherwise CREATE a new entity; if a fuzzy name candidate exists, file a
//      low-confidence merge SUGGESTION for the review queue (we ask, never guess)
//
// Corrections are first-class and DURABLE: rename / retype / addAlias / merge /
// split(move). Each correction persists (aliases, merge log) so the resolver
// learns your graph and stops repeating the mistake.

import { getDB } from '../database';
import { migrateCrm } from './schema';

export type IdentifierKind = 'name' | 'email' | 'handle' | 'phone' | 'url';

export interface Mention {
  name: string;
  type?: string;
  identifiers?: { kind: IdentifierKind; value: string }[];
  partOf?: string; // exact name of an EXISTING project this is a component of
}

/** Find an existing entity id by exact name or name-alias (no creation). */
export function findEntityIdByName(name: string): number | null {
  migrateCrm();
  const n = name.trim();
  if (!n) return null;
  const alias = findByAlias('name', n);
  if (alias) return alias;
  const row = getDB().prepare('SELECT id FROM entities WHERE name = ? COLLATE NOCASE').get(n) as { id: number } | undefined;
  return row?.id ?? null;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Token-overlap similarity for fuzzy name candidacy (cheap, no embeddings). */
function nameSimilarity(a: string, b: string): number {
  const ta = new Set(norm(a).split(/\s+/).filter(Boolean));
  const tb = new Set(norm(b).split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

/** Char-level (Levenshtein) similarity 0..1 — catches OCR drift token-overlap
 *  misses ("weanesday"~"wednesday", "Locally Al"~"Locally AI", "Screenp"~"Screenpipe"). */
function charSimilarity(a: string, b: string): number {
  const s = norm(a);
  const t = norm(b);
  if (!s || !t) return 0;
  if (s === t) return 1;
  const m = s.length;
  const n = t.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (s[i - 1] === t[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - dp[m] / Math.max(m, n);
}

// High-confidence auto-merge: an existing SAME-TYPE entity whose name is a near
// duplicate (char-level). Conservative thresholds — long names need 0.88, short
// ones 0.82 — so "weanesday"->"Wednesday" merges but distinct names don't.
// Two names whose ONLY difference is a number are DISTINCT, not duplicates
// ("Phase 1" vs "Phase 2", "Deck V2" vs "Deck V3", "Q1" vs "Q2"). Char-similarity
// can't tell them apart, so guard explicitly.
function numbersDiffer(a: string, b: string): boolean {
  const na = (a.match(/\d+/g) ?? []).join(',');
  const nb = (b.match(/\d+/g) ?? []).join(',');
  return na !== nb && (na !== '' || nb !== '');
}

function findNearDuplicate(name: string, type: string): number | null {
  const others = getDB().prepare('SELECT id, name, type FROM entities WHERE hidden = 0').all() as {
    id: number;
    name: string;
    type: string;
  }[];
  let best: { id: number; sim: number } | null = null;
  for (const o of others) {
    if (norm(o.type) !== norm(type)) continue;
    if (numbersDiffer(name, o.name)) continue;
    const sim = charSimilarity(name, o.name);
    const thresh = Math.min(name.length, o.name.length) <= 6 ? 0.82 : 0.88;
    if (sim >= thresh && (!best || sim > best.sim)) best = { id: o.id, sim };
  }
  return best?.id ?? null;
}

function addAliasInternal(entityId: number, kind: IdentifierKind, value: string, source: 'auto' | 'user'): void {
  const v = value.trim();
  if (!v) return;
  getDB()
    .prepare(
      `INSERT INTO entity_aliases (entity_id, kind, value, source) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, value) DO UPDATE SET entity_id = excluded.entity_id WHERE source != 'user'`
    )
    .run(entityId, kind, v, source);
}

function findByAlias(kind: IdentifierKind, value: string): number | null {
  const row = getDB()
    .prepare('SELECT entity_id FROM entity_aliases WHERE kind = ? AND value = ?')
    .get(kind, value.trim()) as { entity_id: number } | undefined;
  return row?.entity_id ?? null;
}

/** Resolve a mention to an entity id, creating one if needed. */
export function resolveEntity(mention: Mention): { entityId: number; created: boolean } {
  migrateCrm();
  const db = getDB();
  const type = mention.type?.trim() || 'Unknown';

  // 1. Hard identifiers first — highest precision, auto-merge.
  for (const id of mention.identifiers ?? []) {
    const hit = findByAlias(id.kind, id.value);
    if (hit) {
      // Make sure the name is also recorded as an alias for future matches.
      addAliasInternal(hit, 'name', mention.name, 'auto');
      return { entityId: hit, created: false };
    }
  }

  // 2. Exact name match (alias table, then entities.name).
  const nameHit = findByAlias('name', mention.name);
  if (nameHit) {
    for (const id of mention.identifiers ?? []) addAliasInternal(nameHit, id.kind, id.value, 'auto');
    return { entityId: nameHit, created: false };
  }
  const exact = db
    .prepare('SELECT id FROM entities WHERE name = ? COLLATE NOCASE')
    .get(mention.name) as { id: number } | undefined;
  if (exact) {
    addAliasInternal(exact.id, 'name', mention.name, 'auto');
    for (const id of mention.identifiers ?? []) addAliasInternal(exact.id, id.kind, id.value, 'auto');
    return { entityId: exact.id, created: false };
  }

  // 2b. High-confidence char-level near-duplicate of a same-type entity — auto
  // resolve (this is the OCR-variant collapse: "weanesday"->"Wednesday").
  const near = findNearDuplicate(mention.name, type);
  if (near) {
    addAliasInternal(near, 'name', mention.name, 'auto');
    for (const id of mention.identifiers ?? []) addAliasInternal(near, id.kind, id.value, 'auto');
    return { entityId: near, created: false };
  }

  // 3. Create new entity (under-merge), then queue a fuzzy suggestion if close.
  const info = db
    .prepare('INSERT INTO entities (name, type) VALUES (?, ?) ON CONFLICT(name, type) DO NOTHING')
    .run(mention.name, type);
  let entityId = Number(info.lastInsertRowid);
  if (!entityId) {
    const got = db.prepare('SELECT id FROM entities WHERE name = ? AND type = ?').get(mention.name, type) as
      | { id: number }
      | undefined;
    entityId = got?.id ?? 0;
  }
  if (entityId) {
    addAliasInternal(entityId, 'name', mention.name, 'auto');
    for (const id of mention.identifiers ?? []) addAliasInternal(entityId, id.kind, id.value, 'auto');
    queueFuzzySuggestion(entityId, mention.name);
  }
  return { entityId, created: true };
}

/** If another entity has a similar name, file a merge suggestion (don't merge). */
function queueFuzzySuggestion(newId: number, name: string): void {
  const db = getDB();
  const others = db
    .prepare('SELECT id, name FROM entities WHERE id != ?')
    .all(newId) as { id: number; name: string }[];
  for (const o of others) {
    const sim = nameSimilarity(name, o.name);
    if (sim >= 0.5 && sim < 1) {
      const [a, b] = newId < o.id ? [newId, o.id] : [o.id, newId];
      db.prepare(
        `INSERT INTO entity_merge_suggestions (entity_a, entity_b, reason, confidence)
         VALUES (?, ?, ?, ?) ON CONFLICT(entity_a, entity_b) DO NOTHING`
      ).run(a, b, `Similar names: "${name}" ~ "${o.name}"`, sim);
    }
  }
}

// --- Corrections ------------------------------------------------------------

export function renameEntity(id: number, newName: string): void {
  migrateCrm();
  const db = getDB();
  db.prepare("UPDATE entities SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(newName, id);
  addAliasInternal(id, 'name', newName, 'user');
}

export function retypeEntity(id: number, newType: string): void {
  migrateCrm();
  getDB().prepare("UPDATE entities SET type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(newType, id);
}

export function addAlias(entityId: number, kind: IdentifierKind, value: string): void {
  migrateCrm();
  addAliasInternal(entityId, kind, value, 'user');
}

export function setEntityPhoto(entityId: number, imagePath: string | null): void {
  migrateCrm();
  getDB().prepare("UPDATE entities SET image_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(imagePath, entityId);
}

/** Set (or clear) an entity's parent, guarding against self/cycles. */
export function setEntityParent(childId: number, parentId: number | null): void {
  migrateCrm();
  if (childId === parentId) return;
  // Prevent a simple cycle: parent can't be a descendant of child.
  if (parentId != null) {
    const db = getDB();
    let cur: number | null = parentId;
    let hops = 0;
    while (cur != null && hops++ < 50) {
      if (cur === childId) return; // would create a cycle
      const row = db.prepare('SELECT parent_id FROM entities WHERE id = ?').get(cur) as { parent_id: number | null } | undefined;
      cur = row?.parent_id ?? null;
    }
  }
  getDB().prepare("UPDATE entities SET parent_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(parentId, childId);
}

/** Unlink an observation from one entity (it stays captured + on other entities). */
export function unlinkObservationFromEntity(observationId: number, entityId: number): void {
  migrateCrm();
  getDB()
    .prepare('DELETE FROM observation_entities WHERE observation_id = ? AND entity_id = ?')
    .run(observationId, entityId);
}

/** Move an observation off one entity and onto another (created if new). */
export function reassignObservation(
  observationId: number,
  fromEntityId: number,
  toName: string,
  toType = 'Topic'
): number {
  migrateCrm();
  const db = getDB();
  unlinkObservationFromEntity(observationId, fromEntityId);
  const { entityId } = resolveEntity({ name: toName, type: toType });
  if (entityId) {
    db.prepare('INSERT OR IGNORE INTO observation_entities (observation_id, entity_id) VALUES (?, ?)').run(
      observationId,
      entityId
    );
  }
  return entityId;
}

/** Delete an observation entirely (and its links/frames). */
export function deleteObservation(observationId: number): void {
  migrateCrm();
  const db = getDB();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM observation_entities WHERE observation_id = ?').run(observationId);
    db.prepare('DELETE FROM observation_frames WHERE observation_id = ?').run(observationId);
    db.prepare('DELETE FROM observations WHERE id = ?').run(observationId);
  });
  tx();
}

/** Hide (archive) an entity from feed/timeline views. Still captured + queryable. */
export function setEntityHidden(entityId: number, hidden: boolean): void {
  migrateCrm();
  getDB().prepare("UPDATE entities SET hidden = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(hidden ? 1 : 0, entityId);
}

export function getChildren(parentId: number): { id: number; name: string; type: string }[] {
  migrateCrm();
  return getDB()
    .prepare('SELECT id, name, type FROM entities WHERE parent_id = ? ORDER BY name')
    .all(parentId) as { id: number; name: string; type: string }[];
}

export function removeAlias(aliasId: number): void {
  migrateCrm();
  getDB().prepare('DELETE FROM entity_aliases WHERE id = ?').run(aliasId);
}

/** Merge `mergeId` into `keepId`: repoint all links + aliases, log, delete. */
export function mergeEntities(keepId: number, mergeId: number): void {
  migrateCrm();
  if (keepId === mergeId) return;
  const db = getDB();
  const merged = db.prepare('SELECT name, type FROM entities WHERE id = ?').get(mergeId) as
    | { name: string; type: string }
    | undefined;
  if (!merged) return;

  const tx = db.transaction(() => {
    // Repoint observation links (ignore dup conflicts).
    db.prepare('UPDATE OR IGNORE observation_entities SET entity_id = ? WHERE entity_id = ?').run(keepId, mergeId);
    db.prepare('DELETE FROM observation_entities WHERE entity_id = ?').run(mergeId);
    // Repoint facts, sessions, aliases.
    db.prepare('UPDATE OR IGNORE entity_facts SET entity_id = ? WHERE entity_id = ?').run(keepId, mergeId);
    db.prepare('UPDATE OR IGNORE entity_sessions SET entity_id = ? WHERE entity_id = ?').run(keepId, mergeId);
    db.prepare('UPDATE OR IGNORE entity_aliases SET entity_id = ? WHERE entity_id = ?').run(keepId, mergeId);
    // Repoint graph edges on both ends.
    db.prepare('UPDATE OR IGNORE entity_edges SET source_entity_id = ? WHERE source_entity_id = ?').run(keepId, mergeId);
    db.prepare('UPDATE OR IGNORE entity_edges SET target_entity_id = ? WHERE target_entity_id = ?').run(keepId, mergeId);
    // Record the merged name as an alias so it still resolves to the survivor.
    addAliasInternal(keepId, 'name', merged.name, 'user');
    // Log for reversibility, then remove the merged entity + leftover edges.
    db.prepare('INSERT INTO entity_merge_log (kept_entity_id, merged_name, merged_type) VALUES (?, ?, ?)').run(
      keepId,
      merged.name,
      merged.type
    );
    db.prepare('DELETE FROM entity_edges WHERE source_entity_id = ? OR target_entity_id = ?').run(mergeId, mergeId);
    db.prepare('DELETE FROM entities WHERE id = ?').run(mergeId);
    db.prepare("UPDATE entity_merge_suggestions SET status = 'merged' WHERE entity_a = ? OR entity_b = ? OR entity_a = ? OR entity_b = ?").run(
      keepId, keepId, mergeId, mergeId
    );
  });
  tx();
}

/** Split: move selected observations onto a new (or existing) entity. */
export function splitObservations(observationIds: number[], toName: string, toType = 'Unknown'): number {
  migrateCrm();
  const db = getDB();
  const resolved = resolveEntity({ name: toName, type: toType });
  const stmt = db.prepare('UPDATE OR IGNORE observation_entities SET entity_id = ? WHERE observation_id = ?');
  const tx = db.transaction(() => {
    for (const oid of observationIds) stmt.run(resolved.entityId, oid);
  });
  tx();
  return resolved.entityId;
}

// --- Review queue -----------------------------------------------------------

export function listMergeSuggestions(): {
  id: number;
  a: { id: number; name: string };
  b: { id: number; name: string };
  reason: string;
  confidence: number;
}[] {
  migrateCrm();
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT s.id, s.reason, s.confidence,
              a.id AS aid, a.name AS aname, b.id AS bid, b.name AS bname
       FROM entity_merge_suggestions s
       JOIN entities a ON a.id = s.entity_a
       JOIN entities b ON b.id = s.entity_b
       WHERE s.status = 'pending'
       ORDER BY s.confidence DESC`
    )
    .all() as { id: number; reason: string; confidence: number; aid: number; aname: string; bid: number; bname: string }[];
  return rows.map((r) => ({
    id: r.id,
    a: { id: r.aid, name: r.aname },
    b: { id: r.bid, name: r.bname },
    reason: r.reason,
    confidence: r.confidence,
  }));
}

export function dismissMergeSuggestion(id: number): void {
  migrateCrm();
  getDB().prepare("UPDATE entity_merge_suggestions SET status = 'dismissed' WHERE id = ?").run(id);
}
