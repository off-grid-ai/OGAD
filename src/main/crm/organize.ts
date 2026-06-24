// "Organize" — the global entity intelligence the per-capture extractor can't
// provide. Reviews the WHOLE entity list with the local model and auto-applies
// (reversibly): merge true duplicates/variants, and set project parent->child
// hierarchy (off-grid-ai -> off-grid-mobile / off-grid-desktop). Grammar-
// constrained + thinking-off for reliable output.

import { getDB } from '../database';
import { migrateCrm } from './schema';
import { llm } from '../llm';
import { mergeEntities, setEntityParent } from './resolve';

const ORGANIZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    merges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          keepId: { type: 'integer' },
          mergeIds: { type: 'array', items: { type: 'integer' } },
        },
        required: ['keepId', 'mergeIds'],
      },
    },
    hierarchy: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          parentId: { type: 'integer' },
          childId: { type: 'integer' },
        },
        required: ['parentId', 'childId'],
      },
    },
  },
  required: ['merges', 'hierarchy'],
} as const;

const ORGANIZE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'organize', schema: ORGANIZE_SCHEMA, strict: true },
};

export async function organizeEntities(): Promise<{ merged: number; parented: number }> {
  migrateCrm();
  const db = getDB();
  const ents = db.prepare('SELECT id, name, type FROM entities').all() as { id: number; name: string; type: string }[];
  if (ents.length < 2) return { merged: 0, parented: 0 };

  const list = ents.map((e) => `#${e.id} "${e.name}" (${e.type})`).join('\n');
  const prompt = `Here are the user's tracked entities (id, name, type):
${list}

Organize them. Reply JSON only, using ONLY ids from the list above:
1. "merges": groups that are the SAME real thing (name variants/spellings, e.g. "Off Grid" / "offgrid-ai" / "off-grid-ai" are one project). For each group pick the cleanest as keepId and put the others in mergeIds. Only merge TRUE duplicates — never merge two genuinely different things.
2. "hierarchy": for PROJECTS/repos, parent->child relationships (a product/monorepo and its sub-projects, e.g. off-grid-ai is the parent of off-grid-mobile and off-grid-desktop). Give parentId and childId.

If unsure, leave it out. Do not invent ids.`;

  let parsed: { merges?: { keepId: number; mergeIds: number[] }[]; hierarchy?: { parentId: number; childId: number }[] };
  try {
    const resp = await llm.chat(prompt, [], 120_000, 1024, {
      responseFormat: ORGANIZE_RESPONSE_FORMAT,
      temperature: 0.1,
      disableThinking: true,
    });
    const s = resp.indexOf('{');
    const e = resp.lastIndexOf('}');
    parsed = JSON.parse(s >= 0 && e > s ? resp.slice(s, e + 1) : '{}');
  } catch (err) {
    console.error('[CRM organize] failed:', err);
    return { merged: 0, parented: 0 };
  }

  const exists = (id: number): boolean => ents.some((x) => x.id === id);
  let merged = 0;
  let parented = 0;

  // Apply merges first (they delete entities), then hierarchy on survivors.
  const goneIds = new Set<number>();
  for (const m of parsed.merges ?? []) {
    if (!exists(m.keepId)) continue;
    for (const mid of m.mergeIds ?? []) {
      if (mid === m.keepId || !exists(mid) || goneIds.has(mid)) continue;
      try {
        mergeEntities(m.keepId, mid);
        goneIds.add(mid);
        merged++;
      } catch (e) {
        console.error('[CRM organize] merge failed', m.keepId, mid, e);
      }
    }
  }

  for (const h of parsed.hierarchy ?? []) {
    if (!exists(h.parentId) || !exists(h.childId)) continue;
    if (goneIds.has(h.parentId) || goneIds.has(h.childId)) continue;
    if (h.parentId === h.childId) continue;
    try {
      setEntityParent(h.childId, h.parentId);
      parented++;
    } catch (e) {
      console.error('[CRM organize] setParent failed', h, e);
    }
  }

  return { merged, parented };
}
