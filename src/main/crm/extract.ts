// Generic screen -> observation. The capture layer already extracts text for
// EVERY focused app (not just chat apps); this turns that raw text into a
// distilled observation tagged with surface + entities, or skips it as noise.
// This is the relevance/salience gate: behavioral pre-filters (length, dedupe,
// per-app interval) keep the firehose down, then the LLM judges signal vs noise.

import { llm } from '../llm';
import { vision, windowRegionOnDisplay } from '../vision';
import { runOCR } from '../ocr';
import { getLayout, learnLayout, cropToRegion } from './layout';
import { recordObservation } from './observations';
import { extractActionItems } from './actions';
import { isCalendarSurface, extractCalendarEvents } from './calendar';
import { getDB } from '../database';
import { noiseReason } from './noise';
import { getSelfView } from '../focus';

// Behavioral pre-filters (cheap, before any LLM call). We gate on title+content
// combined, since for many apps the window TITLE is the richest entity signal
// ("Praveen (DM) — Slack") until full AX-body extraction lands.
const MIN_CHARS = 24;
const PER_APP_INTERVAL_MS = 20_000;
const lastByApp = new Map<string, number>();
const seenHashes = new Set<string>();

// Action-item extraction is a second LLM pass — throttle it globally so it never
// piles onto the capture distill load on the single local server.
const ACTION_SCAN_INTERVAL_MS = 45_000;
let lastActionScan = 0;

// Calendar harvest is a third (throttled) LLM pass — only when the user is
// actually looking at a calendar — to pull UPCOMING events for the "Ahead" view.
const CALENDAR_SCAN_INTERVAL_MS = 60_000;
let lastCalendarScan = 0;

// Off Grid now captures its OWN window too — your activity inside the app should
// be as searchable as everything else. (Kept as a set so genuinely-noisy apps can
// be excluded later.)
const IGNORED_APPS = new Set<string>([]);
// The names this app reports as (packaged / dev / legacy).
const SELF_APPS = new Set(['Off Grid AI Desktop', 'Electron', 'my-memories']);
// Off Grid screens that just RE-RENDER stored memory — OCR'ing them would feed
// the graph its own summaries (an echo loop), so we skip capture on these. Every
// other Off Grid screen (chat, models, connectors, settings, …) is captured.
const SELF_MIRROR_VIEWS = new Set(['day', 'replay', 'reflect', 'entities', 'graph', 'search', 'memories']);

function extractJsonObject(s: string): string {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return start >= 0 && end > start ? s.slice(start, end + 1) : '{}';
}

interface ExtractedEntity {
  name: string;
  type?: string;
  identifiers?: { kind: string; value: string }[];
  partOf?: string;
}

// JSON schema -> grammar so the small model can ONLY emit valid output. This is
// the "more than a prompt" reliability fix: no malformed/empty/partial JSON.
const OBSERVATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    skip: { type: 'boolean' },
    category: { type: 'string', enum: ['work', 'communication', 'consumption', 'other'] },
    summary: { type: 'string' },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['Person', 'Company', 'Project', 'Topic', 'Object', 'Place'] },
          partOf: { type: 'string' },
          identifiers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['email', 'handle', 'url', 'phone'] },
                value: { type: 'string' },
              },
              required: ['kind', 'value'],
            },
          },
        },
        required: ['name', 'type'],
      },
    },
  },
  required: ['skip', 'category', 'summary', 'entities'],
} as const;

const OBSERVATION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'observation', schema: OBSERVATION_SCHEMA, strict: true },
};

// The live entity roster — the CONTEXT the extractor was missing. Without it the
// model invents "OfflineAl"/"Local LLM app" instead of resolving to "Off Grid".
// We feed it the real, established entities (most-active first) so the model
// reuses EXACT names and can mark new things as `partOf` an existing project.
// Cached briefly (captures fire often; this query is cheap but not free).
let rosterCache = { text: '', at: 0 };
const ROSTER_TTL_MS = 30_000;
function entityRoster(): string {
  if (Date.now() - rosterCache.at < ROSTER_TTL_MS) return rosterCache.text;
  const rows = getDB()
    .prepare(
      `SELECT e.name, e.type, COUNT(oe.observation_id) AS c
         FROM entities e LEFT JOIN observation_entities oe ON oe.entity_id = e.id
        WHERE e.hidden = 0 AND e.parent_id IS NULL
        GROUP BY e.id ORDER BY c DESC, e.name LIMIT 60`
    )
    .all() as { name: string; type: string; c: number }[];
  const group = (t: string): string => rows.filter((r) => r.type === t).map((r) => r.name).join('; ');
  const lines = [
    ['Projects', group('Project')],
    ['People', group('Person')],
    ['Companies', group('Company')],
    ['Topics', group('Topic')],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  rosterCache = { text: lines, at: Date.now() };
  return lines;
}

/**
 * Distill an observation from on-screen text. Returns true if one was stored.
 * Now() is read for debounce only — fine in the main process (not a workflow).
 */
export async function extractObservationFromScreen(params: {
  appName: string;
  url?: string;
  windowTitle?: string;
  content: string;
  bounds?: { x: number; y: number; width: number; height: number };
}): Promise<boolean> {
  const app = (params.appName || '').trim();
  const title = (params.windowTitle || '').trim();
  const ax = (params.content || '').trim();
  if (!app || IGNORED_APPS.has(app)) return false;
  // Capture Off Grid itself, EXCEPT the screens that just re-render stored memory
  // (those would loop the graph onto its own summaries).
  if (SELF_APPS.has(app) && SELF_MIRROR_VIEWS.has(getSelfView())) return false;

  // Per-app interval gate FIRST — claim the slot before the expensive
  // screenshot/OCR so we capture at most once per interval per app.
  const now = Date.now();
  if (now - (lastByApp.get(app) ?? 0) < PER_APP_INTERVAL_MS) return false;
  lastByApp.set(app, now);

  // Screenshot the focused window and OCR it — the GROUND TRUTH of what's on
  // screen, properly scoped to the window. This avoids the AX-fragmentation that
  // conflated different conversations/people. Falls back to AX text if OCR fails.
  let shotPath: string | null = null;
  let ocrText = '';
  try {
    shotPath = await vision.captureAppWindow(app, params.windowTitle || undefined, params.bounds);
    if (shotPath) {
      // Step 1: crop the full-display screenshot to the FOCUSED WINDOW using its
      // real bounds (precise, free — isolates the active window even on a busy
      // multi-window screen). The stored frame stays the full screen (good for
      // the Replay "movie"); only the OCR target is narrowed.
      let windowShot = shotPath;
      const winRegion = windowRegionOnDisplay(params.bounds);
      if (winRegion) {
        const wc = await cropToRegion(shotPath, winRegion);
        if (wc) windowShot = wc;
      }
      // Step 2 (capture v2): within the window, crop to the learned content
      // region (drops sidebars/nav). Learned region is now a fraction OF THE
      // WINDOW, so we learn it from the window crop. Learn on first encounter.
      const layout = getLayout(app, now);
      let ocrTarget = windowShot;
      if (layout?.region) {
        const cropped = await cropToRegion(windowShot, layout.region);
        if (cropped) ocrTarget = cropped;
      }
      ocrText = await runOCR(ocrTarget);
      if (!layout) {
        learnLayout(app, windowShot, now).catch(() => {});
      }
    }
  } catch {
    /* ignore — fall back to AX */
  }

  const usingOcr = ocrText.trim().length >= MIN_CHARS;
  const material = (usingOcr ? ocrText : [title, ax].filter(Boolean).join('\n')).trim();
  console.log(`[extract] ${app}: ocr=${ocrText.length} ax=${ax.length} material=${material.length} shot=${shotPath ? 'y' : 'n'}`);
  if (material.length < MIN_CHARS) return false;

  const hash = `${app}:${material.slice(0, 300)}`;
  if (seenHashes.has(hash)) return false;
  seenHashes.add(hash);
  if (seenHashes.size > 800) seenHashes.clear();

  const prompt = `You log what the user is DOING on their computer, for a personal productivity record. Capture work, not just people. Be literal and concrete.

What counts (do NOT skip these): coding/terminal work, editing files, writing docs, browsing/researching a topic, messaging people, reading. For coding or terminal activity, name the project/repo and the concrete action — e.g. "Editing crm/extract.ts in the off-grid-ai desktop repo" or "Running npm build for Off Grid". Treat dev/terminal work as IMPORTANT signal, never as noise.

Classify the "category":
- "consumption" = passively consuming a feed/content: scrolling social media (Twitter/X, Instagram, LinkedIn feed), reading news, watching videos. The authors/accounts in a feed are NOT people you care about — do NOT list them as entities.
- "communication" = a real back-and-forth with specific people (DMs, email, a meeting).
- "work" = building/editing/researching something (coding, docs, terminal).
- "other" = anything else.

Entities to extract = the real things this work is ABOUT: people you actually interact with (Person), companies (Company), and projects (Project) like "Off Grid". For "consumption", leave entities empty (we don't want feed authors polluting the graph) — instead capture the TOPICS consumed in the summary.

REUSE EXISTING ENTITIES — this is critical. The KNOWN ENTITIES list below is everything that already exists. If the work is about one of them, you MUST output its name EXACTLY as written and do NOT invent a near-duplicate (e.g. if "Off Grid" exists, never output "OfflineAl", "Off Grid AI Desktop app", "Local LLM app", or "Personal AI OS" as new entities — they are all just "Off Grid"). Only introduce a genuinely NEW entity if it is a real, important, standalone thing that is clearly none of the known ones.

NEVER make an entity out of implementation detail: source files, modules, branches, PRs, code symbols, functions, or docs (e.g. "crm/extract.ts", "crm-ipc", "vectors.ts", "sd-cli", "mflux", "README.md", "EntitiesScreen.tsx", a function name). When you're editing files inside a repo, the entity is the PROJECT as a whole (almost always one already in KNOWN ENTITIES — usually "Off Grid"), NOT the file or module. If a thing genuinely is a sub-component of a known project, set its "partOf" to that project's exact name instead of leaving it as a top-level entity.

CRITICAL — extract ONLY the ACTIVE SUBJECT the user is engaged with right now: the OPEN conversation, the file/repo being edited, the specific thing in the MAIN content area. A messaging app shows a sidebar listing many chats AND one open conversation — extract ONLY the person whose conversation is actually OPEN (e.g. just "Udayan Adhye"), NEVER the whole list of names in the sidebar. IGNORE everything in sidebars, chat/conversation lists, navigation menus, suggestions, "who to follow", notifications, and other windows. Never dump every name on screen — prefer 1-2 entities, the ones in focus. Do not include the user themselves.


Hard rules:
- Be CONCRETE and SPECIFIC. Capture what was actually said or done, using the real words — quote short phrases verbatim when useful. Example good: \`Praveen: "it won't be easy, but it's alright"\`. Example BAD (too abstract — never do this): "Praveen is discussing a difficult task".
- Use ONLY what is explicitly present. NEVER infer who initiated, intent, motivation, feelings, topic, or outcome. No "to discuss…", no "about their well-being" unless those words literally appear.
- Ban vague filler: "a difficult task or situation", "recent changes", "various topics", "general discussion". If you'd write something that vague, you don't have enough — skip instead.
- If you only have a window title or a fragment, write a minimal literal note ("Slack DM with Praveen") rather than inventing a storyline.
- NEVER create entities for AI assistants / model names / tools themselves (e.g. "Claude", "ChatGPT", "GPT", "Opus 4.8", "Gemini", "Cursor", "VS Code") — those are HOW the work is done, not WHAT it's about. Capture the actual subject/project instead.
- Prefer {"skip": true} over a guess.

KNOWN ENTITIES (reuse these EXACT names when the work is about them; never create a variant/duplicate of one; use "partOf" to attach a sub-component to one):
${entityRoster() || '(none yet)'}

Surface (app): ${app}${params.url ? `\nURL: ${params.url}` : ''}${params.windowTitle ? `\nWindow: ${params.windowTitle}` : ''}
Captured text:
"""
${material.slice(0, 4000)}
"""

If this is noise (navigation chrome, ads, boilerplate, app UI, empty, or too sparse to state a fact), reply exactly: {"skip": true}

Otherwise reply JSON only:
{"skip": false, "category": "work|communication|consumption|other", "summary": "<a literal factual note grounded only in the text>", "entities": [{"name": "<an exact KNOWN name, or a genuinely new real entity>", "type": "Person|Company|Project|Topic|Object|Place", "partOf": "<exact name of an existing project this is a component of, or omit>", "identifiers": [{"kind": "email|handle|url", "value": "..."}]}]}

Only include entities that literally appear. JSON only, no prose.`;

  try {
    const resp = await llm.chat(prompt, [], 120_000, 512, {
      responseFormat: OBSERVATION_RESPONSE_FORMAT,
      temperature: 0.2,
      disableThinking: true,
    });
    const parsed = JSON.parse(extractJsonObject(resp)) as {
      skip?: boolean;
      category?: string;
      summary?: string;
      entities?: ExtractedEntity[];
    };
    console.log(`[extract] ${app}: model -> ${parsed.skip ? 'SKIP' : `[${parsed.category}] "${(parsed.summary ?? '').slice(0, 70)}"`}`);
    if (parsed.skip || !parsed.summary || parsed.summary.trim().length < 8) return false;

    const category = parsed.category ?? 'work';
    // Consumption (scrolling a feed, news, video) must NOT spawn entities — the
    // feed authors aren't people you care about. Capture the topics in summary.
    const mentions =
      category === 'consumption'
        ? []
        : (parsed.entities ?? [])
            .filter((e) => e?.name && e.name.trim().length > 1)
            // Deterministic noise gate: reject code files/modules/PRs/domains/
            // symbols/self BEFORE they ever become an entity (the model still
            // proposes them sometimes; this is the hard backstop).
            .filter((e) => {
              const reason = noiseReason(e.name.trim());
              if (reason) console.log(`[extract] dropped entity "${e.name.trim()}" (${reason})`);
              return !reason;
            })
            .map((e) => ({
              name: e.name.trim(),
              type: e.type,
              partOf: e.partOf?.trim() || undefined,
              identifiers: (e.identifiers ?? [])
                .filter((i) => i?.value)
                .map((i) => ({ kind: (i.kind as any) ?? 'name', value: i.value })),
            }));

    recordObservation({
      summary: parsed.summary.trim(),
      surface: app,
      surfaceApp: app,
      url: params.url,
      category,
      engagement: 0.6,
      salience: 0.7,
      mentions,
      frames: [
        {
          app,
          url: params.url,
          windowTitle: params.windowTitle,
          imagePath: shotPath ?? undefined,
          text: material.slice(0, 6000),
          source: usingOcr ? 'ocr' : 'ax',
        },
      ],
    });

    // Action items: communication is where asks/commitments live. Run a separate
    // (throttled) extraction in the background — never blocks capture, and the
    // global throttle keeps it from doubling LLM load on the single local server.
    if (category === 'communication' && now - lastActionScan >= ACTION_SCAN_INTERVAL_MS) {
      lastActionScan = now;
      extractActionItems({
        material,
        app,
        summary: parsed.summary.trim(),
        entityName: mentions[0]?.name,
        ts: Math.floor(now / 1000),
      }).catch(() => {});
    }

    // Calendar harvest: when the user is looking at a calendar, pull UPCOMING
    // events for the prospective "Ahead" view — on-device, no OAuth client.
    if (
      isCalendarSurface(app, params.url ?? '', params.windowTitle ?? '') &&
      now - lastCalendarScan >= CALENDAR_SCAN_INTERVAL_MS
    ) {
      lastCalendarScan = now;
      extractCalendarEvents(material, app, Math.floor(now / 1000)).catch(() => {});
    }
    return true;
  } catch (e) {
    console.error('[CRM extract] failed:', e);
    return false;
  }
}
