import { ipcMain, BrowserWindow } from 'electron';
import { getDB, getChatSessions, upsertChatSummary, getMemoriesForSession, getMemoryRecordsForSession, getMasterMemory, updateMasterMemory, getAllChatSummaries, upsertEntity, addEntityFact, updateEntitySummary, getEntities, getEntityDetails, upsertEntitySession, rebuildEntityEdgesForSession, getEntityGraph, rebuildEntityEdgesForAllSessions, deleteEntity, deleteMemory, getEntitiesForSession, getDashboardStats, getUserProfile, saveUserProfile, UserProfile, createRagConversation, getRagConversations, getRagConversation, deleteRagConversation, addRagMessage, getRagMessages, updateRagConversationTitle, getSettings, saveSetting, getSetting } from './database';
import { embeddings } from './embeddings';
import { getPermissionStatus, requestAccessibilityPermission, requestScreenRecordingPermission, openAccessibilitySettings, openScreenRecordingSettings } from './permissions';
import { getPrompt, getAllPromptDefs, resetPrompt, getPromptTemplate } from './prompts';
// import { llm } from './llm'; // Moved to dynamic import to support ESM

// Incrementally update master memory with a new conversation summary
// This approach keeps context bounded by only processing current master + new summary
async function updateMasterMemoryIncremental(newSummary: string): Promise<string | null> {
    // Master memory (the consolidated "profile") is a retired My Memories feature —
    // no longer injected into chat. Don't regenerate it so it stays cleared.
    return null;
    // eslint-disable-next-line no-unreachable
    console.log('[IPC] Starting incremental master memory update...');
    const currentMasterData = getMasterMemory();
    const currentMaster: string = currentMasterData?.content ?? '';

    // If no existing master memory, create initial one from just this summary
    if (!currentMaster || currentMaster.trim().length === 0) {
        console.log('[IPC] No existing master memory, creating from new summary only');
        const prompt = getPrompt('masterMemory.initial', { SUMMARY: newSummary });

        try {
            const { llm } = await import('./llm');
            const initialMaster = await llm.chat(prompt, [], 600000, 4096);
            updateMasterMemory(initialMaster);
            console.log('[IPC] Initial master memory created');
            return initialMaster;
        } catch (e) {
            console.error('[IPC] Failed to create initial master memory:', e);
            return null;
        }
    }

    // Incremental update: merge new summary with existing master (no truncation - allow growth)
    const prompt = getPrompt('masterMemory.incremental', { CURRENT_MASTER: currentMaster, NEW_SUMMARY: newSummary });

    try {
        const { llm } = await import('./llm');
        const updatedMaster = await llm.chat(prompt, [], 600000, 4096);
        updateMasterMemory(updatedMaster);
        console.log('[IPC] Master memory updated incrementally');
        return updatedMaster;
    } catch (e) {
        console.error('[IPC] Failed to update master memory incrementally:', e);
        return null;
    }
}

// Full regeneration using map-reduce:
// Phase 1 (map): Split summaries into chunks, generate a partial summary for each
// Phase 2 (reduce): Merge all partial summaries into the final master memory
// This avoids the growing-prompt problem and minimizes LLM calls
async function regenerateMasterMemoryFull(): Promise<string | null> {
    // Retired feature — see updateMasterMemoryIncremental. Don't rebuild the profile.
    return null;
    // eslint-disable-next-line no-unreachable
    const summaries = getAllChatSummaries();
    console.log(`[IPC] regenerateMasterMemoryFull called, found ${summaries.length} summaries`);

    if (summaries.length === 0) {
        console.log('[IPC] No summaries found — clearing master memory');
        updateMasterMemory('');
        return null;
    }

    const { llm } = await import('./llm');

    const sendProgress = (current: number, total: number) => {
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('master-memory:progress', { current, total });
        });
    };

    // If few enough summaries, do it in one shot
    const allText = summaries.map((s, i) => `[Session ${i + 1}]\n${s.summary}`).join('\n\n---\n\n');
    if (allText.length < 60000) {
        console.log(`[IPC] All summaries fit in one prompt (${allText.length} chars), single-shot`);
        sendProgress(0, 1);
        const prompt = getPrompt('masterMemory.batchFirst', { BATCH_TEXT: allText });
        const master = await llm.chat(prompt, [], 600000, 4096);
        updateMasterMemory(master);
        sendProgress(1, 1);
        console.log(`[IPC] Master memory regenerated single-shot (${master.length} chars)`);
        return master;
    }

    // Map-reduce for large sets
    // Phase 1: split into chunks of ~50K chars each, generate partial summaries
    const CHUNK_MAX_CHARS = 50000;
    const chunks: string[][] = [[]];
    let currentChunkSize = 0;

    for (const s of summaries) {
        if (currentChunkSize + s.summary.length > CHUNK_MAX_CHARS && chunks[chunks.length - 1].length > 0) {
            chunks.push([]);
            currentChunkSize = 0;
        }
        chunks[chunks.length - 1].push(s.summary);
        currentChunkSize += s.summary.length;
    }

    const totalSteps = chunks.length + 1; // chunks + 1 merge step
    console.log(`[IPC] Map-reduce: ${chunks.length} chunks + 1 merge = ${totalSteps} steps`);
    sendProgress(0, totalSteps);

    const partials: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
        const batchText = chunks[i].map((s, j) => `[Session ${j + 1}]\n${s}`).join('\n\n---\n\n');
        const prompt = getPrompt('masterMemory.batchFirst', { BATCH_TEXT: batchText });
        console.log(`[IPC] Phase 1 chunk ${i + 1}/${chunks.length}: ${batchText.length} chars input, prompt ${prompt.length} chars`);

        try {
            const partial = await llm.chat(prompt, [], 600000, 2048);
            partials.push(partial);
            console.log(`[IPC] Chunk ${i + 1} done: ${partial.length} chars output`);
            sendProgress(i + 1, totalSteps);
        } catch (e) {
            console.error(`[IPC] Chunk ${i + 1} FAILED:`, e);
            throw e;
        }
    }

    // Phase 2: merge all partials into final master memory
    console.log(`[IPC] Phase 2: merging ${partials.length} partial summaries...`);
    const mergeInput = partials.map((p, i) => `[Part ${i + 1}]\n${p}`).join('\n\n---\n\n');
    const mergePrompt = getPrompt('masterMemory.merge', { PARTIAL_SUMMARIES: mergeInput });
    console.log(`[IPC] Merge prompt: ${mergePrompt.length} chars`);

    const finalMaster = await llm.chat(mergePrompt, [], 600000, 4096);
    updateMasterMemory(finalMaster);
    sendProgress(totalSteps, totalSteps);
    console.log(`[IPC] Master memory regenerated via map-reduce (${finalMaster.length} chars)`);
    return finalMaster;
}

// Main entry point - full regeneration
async function regenerateMasterMemory(): Promise<string | null> {
    return regenerateMasterMemoryFull();
}

function safeParseJson<T>(input: string, fallback: T): T {
    try {
        const clean = input.replace(/```json\n?|\n?```/g, '').trim();
        return JSON.parse(clean) as T;
    } catch {
        return fallback;
    }
}

const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'know', 'about', 'your', 'you', 'me', 'my', 'all', 'do',
    'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'will', 'would', 'should', 'could', 'can', 'may', 'might'
]);

function tokenizeQuery(query: string, maxTokens: number = 6): string[] {
    const tokens = query
        .toLowerCase()
        .split(/\s+/)
        .map(t => t.replace(/[^a-z0-9_-]/g, ''))
        .filter(t => t.length >= 3)
        .filter(t => !STOPWORDS.has(t));
    return Array.from(new Set(tokens)).slice(0, maxTokens);
}

// Generate the answer for a rag:chat turn. When a streamId + sender are present,
// stream tokens/reasoning to the renderer over the 'rag:stream' channel as they
// arrive (inline chain-of-thought); otherwise fall back to a single blocking call.
// Active streaming turns, keyed by streamId, so a renderer 'rag:cancel' can abort
// an in-flight generation and keep whatever was produced so far.
const streamControllers = new Map<string, AbortController>();

// In-flight model downloads, keyed by modelId, so 'models:cancel-download' can
// abort the fetch and clean up the partial file.
const downloadControllers = new Map<string, AbortController>();

async function streamAnswer(
    event: { sender?: { send: (channel: string, payload: unknown) => void } } | undefined,
    streamId: string | undefined,
    prompt: string,
    thinking: boolean = false,
    images: string[] = [],
): Promise<string> {
    const { llm } = await import('./llm');
    if (!streamId || !event?.sender) {
        return (await llm.chat(prompt, images, 300000, 2048, { disableThinking: !thinking })).trim();
    }
    const sender = event.sender;
    const controller = new AbortController();
    streamControllers.set(streamId, controller);
    try {
        const answer = await llm.chatStream(prompt, images, (text, kind) => {
            try { sender.send('rag:stream', { streamId, type: kind, text }); } catch { /* window gone */ }
        }, { thinking, signal: controller.signal });
        return answer.trim();
    } finally {
        streamControllers.delete(streamId);
    }
}

function clipText(text: string, maxLength: number): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.slice(0, Math.max(0, maxLength - 1)) + '…';
}

// Build/generate requests ("build a react app", "write an svg", "make a landing
// page") don't benefit from memory retrieval — pulling in unrelated SOURCES makes
// the model cite junk and second-guess itself. Detect them so we can answer with
// the artifact instructions only and skip the search.
function isGenerativeRequest(text: string): boolean {
    const q = (text || '').trim().toLowerCase();
    if (!q) return false;
    const hasNoun = /\b(react|next\.?js|vue|svelte|html|css|svg|website|web ?app|web ?page|landing page|component|widget|diagram|chart|flowchart|mermaid|game|canvas|prototype|mock-?up|ui|app|script|function|snippet|webpage|playground|frontend|front-end|dashboard|form|interface|page|tool|visualization|visualisation|simulator|editor|viewer|demo|site)\b/.test(q);
    const hasVerb = /\b(build|create|make|write|generate|code|implement|design|draw|render|scaffold|give me a|show me a)\b/.test(q);
    return hasNoun && hasVerb;
}

type ChatIntent = { intent: 'build' | 'image' | 'chat'; urls: string[] };

const INTENT_SCHEMA = {
    type: 'object',
    properties: {
        intent: { type: 'string', enum: ['build', 'image', 'chat'] },
        urls: { type: 'array', items: { type: 'string' } },
    },
    required: ['intent', 'urls'],
    additionalProperties: false,
};

// Decide the output format for a turn with the model itself (grammar-constrained
// JSON), instead of brittle keyword matching: build (runnable artifact), image
// (generate a picture), or chat. Also pulls out any URLs the user wants read.
// Falls back to the keyword heuristic if the classifier call fails.
async function classifyIntent(query: string, history?: { role: string; content: string }[]): Promise<ChatIntent> {
    const regexUrls = (query.match(/https?:\/\/[^\s)<>"']+/g) || []).slice(0, 3);
    try {
        const { llm } = await import('./llm');
        const hist = (history ?? []).slice(-4).map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${clipText(m.content, 200)}`).join('\n');
        const prompt = [
            'You route a request for an on-device assistant. Decide the OUTPUT FORMAT:',
            '- "build": the user wants runnable code / a UI created — an app, component, page, playground, dashboard, form, diagram, chart, visualization, game, etc. (rendered live in a canvas).',
            '- "image": the user wants a picture/photo/logo/illustration/art generated.',
            '- "chat": anything else — questions, explanations, writing, discussion.',
            'Also list any http(s) URLs the user wants you to read or build from.',
            'Reply with ONLY JSON: {"intent":"build|image|chat","urls":[]}.',
            hist ? `Recent conversation:\n${hist}` : '',
            `User: ${query}`,
        ].filter(Boolean).join('\n\n');
        const raw = await llm.chat(prompt, [], 60000, 200, {
            disableThinking: true,
            responseFormat: { type: 'json_schema', json_schema: { name: 'intent', schema: INTENT_SCHEMA, strict: true } },
        });
        const j = JSON.parse(raw) as Partial<ChatIntent>;
        const intent = j.intent === 'build' || j.intent === 'image' ? j.intent : 'chat';
        const urls = Array.isArray(j.urls) ? j.urls.filter((u) => /^https?:\/\//i.test(u)) : [];
        return { intent, urls: urls.length ? urls.slice(0, 3) : regexUrls };
    } catch (e) {
        console.warn('[intent] classifier failed, falling back to heuristic', (e as Error).message);
        return { intent: isGenerativeRequest(query) ? 'build' : 'chat', urls: regexUrls };
    }
}

function isTrivialMessage(text: string): boolean {
    const normalized = (text || '').trim();
    if (normalized.length === 0) return true;
    if (normalized.length < 20) {
        if (/^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|cool|great|nice|good|fine|bye|see ya|yep|nope)[!.]?$/i.test(normalized)) {
            return true;
        }
    }
    return false;
}

async function insertMemoryRecord(params: {
    content: string;
    name?: string | null;
    rawText?: string | null;
    sourceApp?: string | null;
    sessionId?: string | null;
    messageId?: number | null;
}): Promise<number | null> {
    const db = getDB();
    const content = (params.content || '').trim();
    if (!content) return null;

    if (params.messageId) {
        const existing = db.prepare('SELECT id FROM memories WHERE message_id = ? LIMIT 1').get(params.messageId) as { id: number } | undefined;
        if (existing?.id) return existing.id;
    }

    if (params.sessionId) {
        const existing = db.prepare('SELECT id FROM memories WHERE session_id = ? AND content = ? LIMIT 1').get(params.sessionId, content) as { id: number } | undefined;
        if (existing?.id) return existing.id;
    }

    let vectorJson = '[]';
    try {
        const vector = await embeddings.generateEmbedding(content);
        vectorJson = JSON.stringify(vector);
    } catch (e) {
        console.error('Failed to generate embedding for memory record:', e);
    }

    const stmt = db.prepare('INSERT INTO memories (content, name, raw_text, source_app, session_id, embedding, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const info = stmt.run(
        content,
        params.name || null,
        params.rawText || null,
        params.sourceApp || null,
        params.sessionId || null,
        vectorJson,
        params.messageId || null
    );
    const memoryId = Number(info.lastInsertRowid || 0) || null;
    
    // Send notification about new memory
    if (memoryId) {
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('notification:new-memory', {
                sessionId: params.sessionId || null,
                memoryContent: content.slice(0, 100) + (content.length > 100 ? '...' : '')
            });
        });
    }
    
    return memoryId;
}

export async function evaluateAndStoreMemoryForMessage(params: {
    sessionId: string;
    appName: string;
    role: string;
    content: string;
    messageId?: number | null;
}): Promise<void> {
    const role = (params.role || 'unknown').toLowerCase();
    const text = (params.content || '').trim();
    if (!text || isTrivialMessage(text)) return;

    // Get strictness setting
    const strictness = getSetting<'lenient' | 'balanced' | 'strict'>('memoryStrictness', 'balanced');

    const prompt = getPrompt(`memoryFilter.${strictness}`, { ROLE: role, MESSAGE: text });

    // Minimum content length filter: skip very short messages
    if (role === 'user' && text.length < 30) return;
    if (role === 'assistant' && text.length < 50) return;

    try {
        const { llm } = await import('./llm');
        const response = await llm.chat(prompt);
        const parsed = safeParseJson<{ store: boolean; name?: string; memory?: string }>(response, { store: false });
        if (!parsed.store) return;
        const memoryText = (parsed.memory || '').trim();
        const memoryName = (parsed.name || '').trim() || null;
        if (!memoryText) return;
        if (memoryText.split(/\s+/).length < 4) return;
        if (memoryText.length > 280) return;

        // Post-LLM filter: skip memories matching generic / low-value patterns
        const genericPatterns = [
            /^the user (asked|said|mentioned|wanted|is|was|has|had)\b/i,
            /^(this|that|it) (is|was|seems|appears|looks)\b/i,
            /^(a|an|the) (good|great|nice|common|typical|standard|normal)\b/i,
            /\b(in general|generally speaking|as usual|as always)\b/i,
        ];
        if (genericPatterns.some(p => p.test(memoryText))) return;

        // Post-LLM filter: skip near-duplicates via substring check against existing session memories
        if (params.sessionId) {
            const existingMemories = getMemoryRecordsForSession(params.sessionId);
            const memLower = memoryText.toLowerCase();
            const isDuplicate = existingMemories.some((m: any) => {
                const existing = (m.content || '').toLowerCase();
                return existing === memLower || existing.includes(memLower) || memLower.includes(existing);
            });
            if (isDuplicate) return;
        }

        await insertMemoryRecord({
            content: memoryText,
            name: memoryName,
            rawText: text,
            sourceApp: params.appName,
            sessionId: params.sessionId,
            messageId: params.messageId || null
        });
    } catch (e) {
        console.error('[IPC] Memory evaluation failed:', e);
    }
}

async function extractEntitiesForSession(sessionId: string): Promise<void> {
        const memories = getMemoryRecordsForSession(sessionId);
        if (!memories || memories.length === 0) return;

        // Get strictness setting
        const strictness = getSetting<'lenient' | 'balanced' | 'strict'>('entityStrictness', 'balanced');

        const memoryText = memories.map((m: any) => `- ${m.content}`).join('\n');
        
        const prompt = getPrompt(`entityExtraction.${strictness}`, { MEMORY_TEXT: memoryText });

    try {
        const { llm } = await import('./llm');
        const response = await llm.chat(prompt);
        const parsed = safeParseJson<{ entities: { name: string; type?: string; facts?: string[] }[] }>(response, { entities: [] });

        if (!parsed.entities || parsed.entities.length === 0) return;

        // Blocklist of very common short entity names that are too generic
        const ENTITY_BLOCKLIST = new Set([
            'api', 'app', 'web', 'url', 'css', 'sql', 'cli', 'ide', 'ui', 'ux',
            'html', 'http', 'json', 'xml', 'yaml', 'code', 'data', 'file', 'bug',
            'server', 'client', 'database', 'frontend', 'backend', 'website',
            'user', 'admin', 'test', 'dev', 'prod', 'staging'
        ]);

        const touchedEntityIds = new Set<number>();
        for (const entity of parsed.entities) {
            const name = (entity.name || '').trim();
            if (!name) continue;
            const type = (entity.type || 'Unknown').trim() || 'Unknown';
            const facts = Array.isArray(entity.facts) ? entity.facts.filter(Boolean).map(f => f.trim()).filter(Boolean) : [];

            // Min name length: 3 chars
            if (name.length < 3) continue;
            if (facts.length === 0) continue;
            // Skip blocklisted generic names
            if (ENTITY_BLOCKLIST.has(name.toLowerCase())) continue;

            const entityId = upsertEntity(name, type);
            if (!entityId) continue;
            touchedEntityIds.add(entityId);
            upsertEntitySession(entityId, sessionId);

            const newFacts: string[] = [];
            for (const fact of facts) {
                const inserted = addEntityFact(entityId, fact, sessionId);
                if (inserted) newFacts.push(fact);
            }

            // Send notification about new entity with facts
            if (newFacts.length > 0) {
                BrowserWindow.getAllWindows().forEach(win => {
                    win.webContents.send('notification:new-entity', {
                        entityId,
                        entityName: name,
                        entityType: type,
                        factsCount: newFacts.length
                    });
                });
            }

            if (newFacts.length === 0) continue;

            const details = getEntityDetails(entityId) as { entity?: { summary?: string } } | null;
            const existingSummary = details?.entity?.summary || '';

            const summaryPrompt = getPrompt('entitySummary', {
                NAME: name,
                TYPE: type,
                EXISTING_SUMMARY: existingSummary || '(none)',
                NEW_FACTS: '- ' + newFacts.join('\n- '),
            });

            try {
                const updatedSummary = await llm.chat(summaryPrompt);
                if (updatedSummary && updatedSummary.trim()) {
                    updateEntitySummary(entityId, updatedSummary.trim());
                }
            } catch (e) {
                console.error('[IPC] Failed to update entity summary:', e);
            }
        }

        if (touchedEntityIds.size > 1) {
            rebuildEntityEdgesForSession(sessionId);
        }
    } catch (e) {
        console.error('[IPC] Entity extraction failed:', e);
    }
}


export async function summarizeSession(sessionId: string): Promise<string | null> {
    const memories = getMemoriesForSession(sessionId);
    if (!memories || memories.length === 0) return null;

    const conversationText = memories.map((m: any) => `[${m.role || 'unknown'}]: ${m.content}`).join('\n');
    const prompt = getPrompt('sessionSummary', { CONVERSATION_TEXT: conversationText });

    try {
        const { llm } = await import('./llm');
        const summary = await llm.chat(prompt, [], 120000, 2048);
        upsertChatSummary(sessionId, summary);

        // Extract and update entity memory (non-blocking — don't fail the summary if these error)
        try {
            await extractEntitiesForSession(sessionId);
        } catch (entityErr) {
            console.error('[IPC] Entity extraction failed (non-fatal):', entityErr);
        }

        // Incrementally update master memory with the new summary
        try {
            await updateMasterMemoryIncremental(summary);
        } catch (masterErr) {
            console.error('[IPC] Master memory incremental update failed (non-fatal):', masterErr);
        }

        return summary;
    } catch (e) {
        console.error("Failed to summarize session:", e);
        throw e;
    }
}

export function setupIPC() {
  const db = getDB();

  ipcMain.handle('db:get-memories', (_, limit: number = 50, appName?: string) => {
    let query = 'SELECT * FROM memories ';
    const params: any[] = [];
    
    if (appName && appName !== 'All') {
        query += 'WHERE source_app LIKE ? ';
        params.push(`%${appName}%`);
    }
    
    query += 'ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    
    const stmt = db.prepare(query);
    // SQLite stores timestamps as UTC strings "YYYY-MM-DD HH:MM:SS" by default with CURRENT_TIMESTAMP
    // To ensure JS treats them as UTC, we might need to append 'Z' or standardise.
    // However, simplest is to let frontend handle "UTC" assumption.
    return stmt.all(...params);
  });

  ipcMain.handle('db:add-memory', async (_, content: string, source: string = 'user-input', sessionId?: string) => {
    // Generate embedding
    let vectorJson = '[]';
    try {
       const vector = await embeddings.generateEmbedding(content);
       vectorJson = JSON.stringify(vector);
    } catch (e) {
       console.error("Failed to generate embedding:", e);
    }
    
    // Check if we can update an existing session
    if (sessionId) {
        // Look for a recent memory (e.g. last 12 hours) with this session_id
        const existing = db.prepare('SELECT id FROM memories WHERE session_id = ? AND created_at > datetime("now", "-12 hours") ORDER BY id DESC LIMIT 1').get(sessionId) as {id: number} | undefined;
        
        if (existing) {
             console.log(`Updating existing memory session ${sessionId} (ID: ${existing.id})`);
             const stmt = db.prepare('UPDATE memories SET content = ?, embedding = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?');
             stmt.run(content, vectorJson, existing.id);
             return { id: existing.id, updated: true };
        }
    }

    const stmt = db.prepare('INSERT INTO memories (content, source_app, session_id, embedding) VALUES (?, ?, ?, ?)');
    const info = stmt.run(content, source, sessionId || null, vectorJson);
    return { id: info.lastInsertRowid };
  });

ipcMain.handle('db:search-memories', async (_, query: string) => {
    try {
        const queryVector = await embeddings.generateEmbedding(query);
        const vecStr = JSON.stringify(queryVector);
        
        const stmt = db.prepare(`
          SELECT *, cosine_similarity(embedding, ?) as score 
          FROM memories 
          WHERE embedding IS NOT NULL AND embedding != '[]'
          ORDER BY score DESC 
          LIMIT 20
        `);
        return stmt.all(vecStr);
    } catch (e) {
        console.error("Vector search failed, falling back to FTS", e);
        const stmt = db.prepare(`
          SELECT memories.* 
          FROM memories 
          JOIN memory_fts ON memories.id = memory_fts.rowid 
          WHERE memory_fts MATCH ? 
          LIMIT 20
        `);
        return stmt.all(query);
    }
  });
  
  ipcMain.handle('db:get-stats', () => {
      const count = db.prepare('SELECT COUNT(*) as count FROM memories').get();
      return count;
  });

  ipcMain.handle('db:get-dashboard-stats', () => {
      return getDashboardStats();
  });

  ipcMain.handle('llm:extract', async (_, text: string) => {
      try {
        const { llm } = await import('./llm');
        const response = await llm.chat(`Analyze the following text and extract a summary and key topics. Return JSON only with keys: summary, topic, entities. Text: "${text}"`);
        
        // Basic cleanup if the model returns markdown code blocks
        const cleanJson = response.replace(/```json\n?|\n?```/g, '').trim();
        
        return JSON.parse(cleanJson);
      } catch (e) {
         console.error("LLM Extraction failed:", e);
         // Fallback
         return {
            summary: text.slice(0, 50) + "...",
            topic: "General (Fallback)",
            entities: []
         };
      }
  });

  ipcMain.handle('llm:status', async () => {
      const { llm } = await import('./llm');
      return {
          ready: llm.isReady()
      };
  });

  // Cancel an in-flight streaming turn; chatStream resolves with the partial answer.
  ipcMain.on('rag:cancel', (_evt, streamId: string) => {
      streamControllers.get(streamId)?.abort();
  });

  ipcMain.handle('rag:chat', async (event, query: string, appName?: string, conversationHistory?: { role: string; content: string }[], projectId?: string | null, conversationId?: string, noMemory?: boolean, streamId?: string, thinking?: boolean, images?: string[]) => {
      const imgs = images || [];
      // Intelligence layer: a grammar-constrained classifier picks the output
      // format (build / image / chat) and extracts URLs to read — replacing the
      // brittle keyword gate. Skip it in project mode (that path is its own thing).
      const { intent, urls: intentUrls } = projectId ? { intent: 'chat' as const, urls: [] as string[] } : await classifyIntent(query, conversationHistory);

      // Image request → have the model write a vivid prompt, then the renderer
      // generates it (it already detects an ```image block).
      if (intent === 'image') {
          const imgPrompt = `Write ONE vivid, detailed image-generation prompt (visual description only, no preamble) for this request:\n${query}`;
          const desc = (await (await import('./llm')).llm.chat(imgPrompt, [], 60000, 200, { disableThinking: true })).trim().replace(/^["']|["']$/g, '');
          return { answer: '```image\n' + (desc || query) + '\n```', context: undefined };
      }

      // Build request → artifact prompt (even in No-memory mode), with any URLs
      // fetched for us so the small model never has to chain tools.
      if (intent === 'build') {
          let historyBlock = '';
          if (conversationHistory && conversationHistory.length > 0) {
              const historyLines = conversationHistory.map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${clipText(msg.content, 400)}`).join('\n');
              historyBlock = `Conversation so far:\n${historyLines}`;
          }
          // read_url → build: fetch the classifier's URLs (deterministic).
          let referenceBlock = '';
          const urls = intentUrls;
          if (urls.length) {
              if (streamId) event.sender?.send('rag:stream', { streamId, type: 'step', step: { kind: 'reading', counts: { urls: urls.length } } });
              const { readUrlText } = await import('./tools');
              const parts: string[] = [];
              for (const u of urls) {
                  try { parts.push(`--- Content fetched from ${u} ---\n${clipText(await readUrlText(u), 5000)}`); }
                  catch (e) { parts.push(`--- Could not fetch ${u}: ${(e as Error).message} ---`); }
              }
              referenceBlock = `REFERENCE — the user pointed you at these page(s); BUILD using this content (e.g. if it's API docs, build a UI that actually calls those endpoints):\n${parts.join('\n\n')}`;
          }
          const prompt = [
              'You are Off Grid, an on-device assistant with a LIVE, sandboxed code canvas built in.',
              'The user wants you to BUILD something. Output the FINISHED, self-contained code as ONE fenced block — it runs immediately in the canvas beside the chat:',
              '- React app/component -> ```jsx — write idiomatic React (you may `import React, { useState } from "react"` and `export default function App() {…}`; the sandbox handles imports/exports). Define the main component as `App` or a default export.',
              '- a plain web page / interactive UI (no React) -> ```html — one complete document, inline all CSS and JS.',
              '- a diagram -> ```mermaid.  a static graphic -> ```svg.',
              'You DO have a real execution sandbox — do NOT say "since I am on-device" or "copy this into a new project", do NOT give npm/Vite/Create-React-App setup steps, and do NOT split it into src/App.js + src/App.css instructions. Just write ONE runnable code block. At most one short sentence before it.',
              referenceBlock,
              historyBlock,
              `User: ${query}`,
              'Assistant:',
          ].filter(Boolean).join('\n\n');
          const answer = await streamAnswer(event, streamId, prompt, thinking, imgs);
          return { answer, context: undefined };
      }

      // No-memory mode: a plain on-device assistant — no retrieval at all.
      if (noMemory) {
          const { llm } = await import('./llm');
          const hist = (conversationHistory ?? [])
              .slice(-10)
              .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
              .join('\n');
          const prompt = [
              'You are Off Grid, a private, on-device assistant.',
              'You can generate images on-device. If (and only if) the user is asking for a picture/image/logo/art to be CREATED, respond with ONLY a fenced block ```image\\n<a detailed image prompt>\\n``` and nothing else. For everything else, answer normally in text.',
              hist ? `Conversation so far:\n${hist}` : '',
              `User: ${query}`,
              'Assistant:',
          ].filter(Boolean).join('\n\n');
          void llm; // retained for non-stream fallback inside streamAnswer
          const answer = await streamAnswer(event, streamId, prompt, thinking, imgs);
          return { answer, context: undefined };
      }

      // Project-scoped chat: retrieve from the project's knowledge base (uploaded
      // docs + optionally captured memory) AND reference sibling chats in the project.
      if (projectId) {
          const { ragService } = await import('./rag');
          const { listProjects } = await import('./rag/store');
          const { getProjectChatHistory } = await import('./database');
          const { formatForPrompt } = await import('@offgrid/rag');
          const { llm } = await import('./llm');
          const project = listProjects().find((p) => p.id === projectId);
          const sys = project?.systemPrompt?.trim() || 'You are a helpful assistant for this project.';
          const search = await ragService.searchProject(projectId, query, { topK: 6, contextLength: 4096 });
          const ctx = formatForPrompt(search);
          // Cross-chat memory: recent messages from other chats in this project.
          const siblings = getProjectChatHistory(projectId, conversationId ?? '', 12);
          const siblingCtx = siblings.length
              ? 'Related discussion from other chats in this project:\n' +
                siblings.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}${m.title ? ` (${m.title})` : ''}: ${m.content}`).join('\n')
              : '';
          const hist = (conversationHistory ?? [])
              .slice(-8)
              .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
              .join('\n');
          const prompt = [sys, ctx, siblingCtx, hist ? `Conversation so far:\n${hist}` : '', `User: ${query}`, 'Assistant:']
              .filter(Boolean)
              .join('\n\n');
          void llm; // retained for non-stream fallback inside streamAnswer
          if (streamId) event.sender?.send('rag:stream', { streamId, type: 'step', step: { kind: 'project', counts: { sources: search.chunks.length, projectChats: siblings.length } } });
          const answer = await streamAnswer(event, streamId, prompt, thinking, imgs);
          return {
              answer,
              context: {
                  sources: search.chunks.map((c) => ({ name: c.name, position: c.position, score: c.score })),
                  projectChats: siblings.length,
              },
          };
      }

      if (streamId) event.sender?.send('rag:stream', { streamId, type: 'step', step: { kind: 'searching' } });
      const db = getDB();
      const tokens = tokenizeQuery(query);
      const ftsQuery = tokens.length > 0 ? tokens.join(' OR ') : query;

      let memories: any[] = [];
      try {
          const queryVector = await embeddings.generateEmbedding(query);
          const vecStr = JSON.stringify(queryVector);
          const params: any[] = [vecStr];
          let memoryQuery = `
            SELECT *, cosine_similarity(embedding, ?) as score
            FROM memories
            WHERE embedding IS NOT NULL AND embedding != '[]'
          `;
          if (appName && appName !== 'All') {
              memoryQuery += ` AND source_app LIKE ? `;
              params.push(`%${appName}%`);
          }
          memoryQuery += ` ORDER BY score DESC LIMIT 12`;
          memories = db.prepare(memoryQuery).all(...params);
          memories = memories.filter((m: any) => typeof m.score !== 'number' || m.score >= 0.2);
      } catch (e) {
          console.error('[RAG] Vector search failed, falling back to FTS', e);
          const params: any[] = [];
          let fallbackQuery = `
            SELECT memories.*
            FROM memories
            JOIN memory_fts ON memories.id = memory_fts.rowid
            WHERE memory_fts MATCH ?
          `;
          params.push(query);
          if (appName && appName !== 'All') {
              fallbackQuery += ` AND memories.source_app LIKE ? `;
              params.push(`%${appName}%`);
          }
          fallbackQuery += ` LIMIT 12`;
          memories = db.prepare(fallbackQuery).all(...params);
      }

            const messageParams: any[] = [ftsQuery];
            let messageQuery = `
                SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title, c.app_name,
                             bm25(message_fts) as score
                FROM message_fts
                JOIN messages m ON message_fts.rowid = m.id
                JOIN conversations c ON c.id = m.conversation_id
                WHERE message_fts MATCH ?
            `;
            if (appName && appName !== 'All') {
                    messageQuery += ` AND c.app_name LIKE ? `;
                    messageParams.push(`%${appName}%`);
            }
            messageQuery += ` ORDER BY score ASC LIMIT 12`;
            const messages = db.prepare(messageQuery).all(...messageParams);

            const summaryParams: any[] = [ftsQuery];
            let summaryQuery = `
                SELECT cs.session_id, cs.summary, c.title, c.app_name, c.updated_at,
                             bm25(summary_fts) as score
                FROM summary_fts
                JOIN chat_summaries cs ON summary_fts.rowid = cs.rowid
                JOIN conversations c ON c.id = cs.session_id
                WHERE summary_fts MATCH ?
            `;
            if (appName && appName !== 'All') {
                    summaryQuery += ` AND c.app_name LIKE ? `;
                    summaryParams.push(`%${appName}%`);
            }
            summaryQuery += ` ORDER BY score ASC LIMIT 8`;
            const summaries = db.prepare(summaryQuery).all(...summaryParams);

            const entityParams: any[] = [ftsQuery];
            let entityQuery = `
                SELECT e.id, e.name, e.type, e.summary, e.updated_at,
                             bm25(entity_fts) as score
                FROM entity_fts
                JOIN entities e ON entity_fts.rowid = e.id
                WHERE entity_fts MATCH ?
            `;
            if (appName && appName !== 'All') {
                    entityQuery += `
                        AND e.id IN (
                            SELECT es.entity_id
                            FROM entity_sessions es
                            JOIN conversations c ON c.id = es.session_id
                            WHERE c.app_name LIKE ?
                        )
                    `;
                    entityParams.push(`%${appName}%`);
            }
            entityQuery += ` ORDER BY score ASC LIMIT 8`;
            const entities = db.prepare(entityQuery).all(...entityParams);

            const factParams: any[] = [ftsQuery];
            let factQuery = `
                SELECT f.fact, f.created_at, f.source_session_id, e.name, e.type,
                             bm25(entity_fact_fts) as score
                FROM entity_fact_fts
                JOIN entity_facts f ON entity_fact_fts.rowid = f.id
                JOIN entities e ON e.id = f.entity_id
                WHERE entity_fact_fts MATCH ?
            `;
            if (appName && appName !== 'All') {
                    factQuery += ` AND f.source_session_id IN (SELECT id FROM conversations WHERE app_name LIKE ?) `;
                    factParams.push(`%${appName}%`);
            }
            factQuery += ` ORDER BY score ASC LIMIT 8`;
            const entityFacts = db.prepare(factQuery).all(...factParams);

      // Supplementary context (no bracket labels — the ONLY citeable tags are the
      // numbered [S#] SOURCES below, so the model can't invent uncited labels).
      const memoryLines = memories.slice(0, 6).map((m: any) =>
          `- (${m.source_app || 'Unknown'} | ${m.created_at}): ${clipText(m.content, 500)}`
      ).join('\n');

      const messageLines = messages.slice(0, 6).map((m: any) =>
          `- (${m.app_name || 'Unknown'} | ${m.title || 'Untitled'} | ${m.created_at}) ${m.role}: ${clipText(m.content, 400)}`
      ).join('\n');

      const summaryLines = summaries.slice(0, 6).map((s: any) =>
          `- (${s.app_name || 'Unknown'} | ${s.title || 'Untitled'}): ${clipText(s.summary, 600)}`
      ).join('\n');

      const entityLines = entities.slice(0, 6).map((e: any) =>
          `- (${e.type || 'Unknown'}) ${e.name}: ${clipText(e.summary || '', 400)}`
      ).join('\n');

      const factLines = entityFacts.slice(0, 6).map((f: any) =>
          `- (${f.type || 'Unknown'}) ${f.name}: ${clipText(f.fact, 400)}`
      ).join('\n');

    const contextBlock = `RELEVANT MEMORIES:\n${memoryLines || '(none)'}\n\nRELEVANT MESSAGES:\n${messageLines || '(none)'}\n\nRELEVANT SUMMARIES:\n${summaryLines || '(none)'}\n\nRELEVANT ENTITIES:\n${entityLines || '(none)'}\n\nRELEVANT ENTITY FACTS:\n${factLines || '(none)'}`;

    // Unified search: fuse in the best-ranked hits across screens, meetings,
    // memories, entities and facts (hybrid FTS + vectors with RRF) — the same
    // engine as the search screen, so the chat gets the right context too.
    let unifiedBlock = '';
    let unifiedHits: { kind: string; title: string; snippet: string; surface: string; ts: number; refId: number; imagePath: string | null }[] = [];
    try {
        const { universalSearch } = await import('./search');
        unifiedHits = await universalSearch(query, { limit: 12, semantic: true });
        if (unifiedHits.length) {
            unifiedBlock = '\n\nSOURCES — every factual claim must cite the source it came from using its tag in square brackets, e.g. [S2]. Cite ONLY sources you actually used; never invent a citation:\n' +
                unifiedHits.map((h, i) => {
                    const when = h.ts ? ` · ${new Date(h.ts).toISOString().slice(0, 10)}` : '';
                    return `[S${i + 1}] (${h.kind} · ${h.surface || 'unknown'}${when})${h.title ? ` ${h.title} —` : ''} ${clipText(h.snippet || '', 350)}`;
                }).join('\n');
        }
    } catch (e) {
        console.error('[RAG] universalSearch failed', e);
    }

    // Build conversation history block if provided
    let historyBlock = '';
    if (conversationHistory && conversationHistory.length > 0) {
        const historyLines = conversationHistory.map(msg => 
            `${msg.role === 'user' ? 'User' : 'Assistant'}: ${clipText(msg.content, 500)}`
        ).join('\n\n');
        historyBlock = `\nCONVERSATION HISTORY:\n${historyLines}\n`;
    }

    let skillsBlock = 'None installed.';
    try {
        const { listSkills } = await import('./skills');
        const sk = listSkills();
        if (sk.length) skillsBlock = sk.map((s) => `- /${s.name}: ${s.description}`).join('\n');
    } catch { /* skills optional */ }

    const prompt = getPrompt('ragChat', {
        HISTORY_BLOCK: historyBlock,
        QUERY: query,
        CONTEXT_BLOCK: contextBlock + unifiedBlock,
        SKILLS_BLOCK: skillsBlock,
    });

      try {
          if (streamId) event.sender?.send('rag:stream', { streamId, type: 'step', step: { kind: 'memory', counts: { memories: memories.length, messages: messages.length, summaries: summaries.length, entities: entities.length, facts: entityFacts.length, unified: unifiedHits.length } } });
          const answer = await streamAnswer(event, streamId, prompt, thinking, imgs);
          return {
              answer,
              context: {
                  masterMemory: null,
                  memories,
                  messages,
                  summaries,
                  entities,
                  entityFacts,
                  unified: unifiedHits
              }
          };
      } catch (e) {
          console.error('[RAG] LLM chat failed:', e);
          return {
              answer: 'Sorry, I could not generate a response right now.',
              context: {
                  masterMemory: null,
                  memories,
                  messages,
                  summaries,
                  entities,
                  entityFacts,
                  unified: unifiedHits
              }
          };
      }
  });

  ipcMain.handle('db:get-chat-sessions', (_, appName?: string) => {
      return getChatSessions(appName);
  });
  ipcMain.handle('db:get-memories-for-session', (_, sessionId: string) => {
      // Need to export this from database.ts first or import it
      return getMemoriesForSession(sessionId);
  });
  ipcMain.handle('db:get-entities', (_, appName?: string) => {
      return getEntities(appName);
  });
  ipcMain.handle('db:get-entity-details', (_, entityId: number, appName?: string) => {
      return getEntityDetails(entityId, appName);
  });
  ipcMain.handle('db:get-entities-for-session', (_, sessionId: string) => {
      return getEntitiesForSession(sessionId);
  });
  ipcMain.handle('db:get-memory-records-for-session', (_, sessionId: string) => {
      return getMemoryRecordsForSession(sessionId);
  });

  ipcMain.handle('db:get-entity-graph', (_, appName?: string, focusEntityId?: number, edgeLimit: number = 200) => {
      return getEntityGraph(appName, focusEntityId, edgeLimit);
  });

  ipcMain.handle('db:rebuild-entity-graph', () => {
      rebuildEntityEdgesForAllSessions();
      return true;
  });
  ipcMain.handle('db:delete-session', async (_, sessionId: string) => {
      const db = getDB();
      // Delete from new tables (messages will cascade due to foreign key)
      db.prepare('DELETE FROM conversations WHERE id = ?').run(sessionId);
      // Also delete from legacy tables for cleanup
      db.prepare('DELETE FROM memories WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM chat_summaries WHERE session_id = ?').run(sessionId);
      console.log(`Deleted session: ${sessionId}`);
      
      // Regenerate master memory after deletion
      await regenerateMasterMemory();
      
      return true;
  });

  ipcMain.handle('llm:summarize-session', async (_, sessionId: string) => {
      return await summarizeSession(sessionId);
  });

  ipcMain.handle('db:get-master-memory', () => {
      return getMasterMemory();
  });

  ipcMain.handle('db:delete-entity', (_, entityId: number) => {
      const result = deleteEntity(entityId);
      console.log(`[IPC] Deleted entity ${entityId}: ${result}`);
      return result;
  });

  ipcMain.handle('db:delete-memory', (_, memoryId: number) => {
      const result = deleteMemory(memoryId);
      console.log(`[IPC] Deleted memory ${memoryId}: ${result}`);
      return result;
  });

  ipcMain.handle('db:regenerate-master-memory', async () => {
      return await regenerateMasterMemory();
  });

  // User Profile handlers
  ipcMain.handle('db:get-user-profile', () => {
      return getUserProfile();
  });

  ipcMain.handle('db:save-user-profile', (_, profile: UserProfile) => {
      saveUserProfile(profile);
      console.log('[IPC] User profile saved:', profile);
      return true;
  });

  // Permission handlers
  ipcMain.handle('permissions:get-status', () => {
      return getPermissionStatus();
  });

  ipcMain.handle('permissions:request-accessibility', () => {
      return requestAccessibilityPermission();
  });

  ipcMain.handle('permissions:open-accessibility-settings', () => {
      openAccessibilitySettings();
      return true;
  });

  ipcMain.handle('permissions:open-screen-recording-settings', () => {
      openScreenRecordingSettings();
      return true;
  });

  ipcMain.handle('permissions:request-screen-recording', async () => {
      return await requestScreenRecordingPermission();
  });

  // === RAG CONVERSATION HANDLERS ===
  
  ipcMain.handle('rag:create-conversation', (_, id: string, title?: string, projectId?: string | null) => {
      return createRagConversation(id, title, projectId);
  });

  ipcMain.handle('rag:get-conversations', (_, projectId?: string | null) => {
      return getRagConversations(projectId);
  });

  ipcMain.handle('rag:set-conversation-project', async (_, id: string, projectId: string | null) => {
      const { setRagConversationProject } = await import('./database');
      setRagConversationProject(id, projectId);
      return true;
  });

  ipcMain.handle('rag:get-conversation', (_, id: string) => {
      return getRagConversation(id);
  });

  ipcMain.handle('rag:get-messages', (_, conversationId: string) => {
      return getRagMessages(conversationId);
  });

  ipcMain.handle('rag:truncate-messages', async (_e, conversationId: string, keepCount: number) => {
      const { truncateRagMessages } = await import('./database');
      return truncateRagMessages(conversationId, keepCount);
  });
  ipcMain.handle('rag:add-message', (_, conversationId: string, role: 'user' | 'assistant', content: string, context?: any) => {
      return addRagMessage(conversationId, role, content, context);
  });

  ipcMain.handle('rag:update-conversation-title', (_, id: string, title: string) => {
      updateRagConversationTitle(id, title);
      return true;
  });

  ipcMain.handle('rag:delete-conversation', (_, id: string) => {
      return deleteRagConversation(id);
  });

  // === SETTINGS HANDLERS ===
  
  ipcMain.handle('settings:get', () => {
      return getSettings();
  });

  ipcMain.handle('settings:save', (_, key: string, value: any) => {
      saveSetting(key, value);
      console.log(`[IPC] Setting saved: ${key} =`, value);
      return true;
  });

  // Fleet console IPC (console:*) is a pro feature — registered by pro's
  // activateMain, not here, so the open build doesn't ship it.

  // === PROMPT HANDLERS ===

  ipcMain.handle('prompts:get-all', () => {
      const defs = getAllPromptDefs();
      return defs.map(def => ({
          ...def,
          currentTemplate: getPromptTemplate(def.key) !== def.defaultTemplate ? getPromptTemplate(def.key) : null,
      }));
  });

  ipcMain.handle('prompts:save', (_, key: string, value: string) => {
      saveSetting(`prompt:${key}`, value);
      console.log(`[IPC] Prompt saved: ${key}`);
      return true;
  });

  ipcMain.handle('prompts:reset', (_, key: string) => {
      resetPrompt(key);
      console.log(`[IPC] Prompt reset: ${key}`);
      return true;
  });

  // === REPROCESS ALL SESSIONS ===

  ipcMain.handle('db:reprocess-all-sessions', async (_, clean: boolean = false) => {
      const db = getDB();
      const sessions = db.prepare('SELECT id FROM conversations').all() as { id: string }[];
      let processed = 0;

      if (clean) {
          // Clean reprocess: delete all old data and rebuild from scratch
          console.log('[IPC] Clean reprocess: clearing all entities, facts, edges, and memories...');

          // Drop FTS AFTER DELETE triggers first — if the FTS index is out of sync
          // with the source tables, the delete triggers will error and silently
          // prevent rows from being deleted. We recreate them after.
          db.exec('DROP TRIGGER IF EXISTS memories_ad');
          db.exec('DROP TRIGGER IF EXISTS entities_ad');
          db.exec('DROP TRIGGER IF EXISTS entity_facts_ad');

          // Delete only strictness-dependent data (children first)
          // Conversations, messages, chat_summaries, and master_memory are NOT touched
          db.prepare('DELETE FROM entity_edges').run();
          db.prepare('DELETE FROM entity_facts').run();
          db.prepare('DELETE FROM entity_sessions').run();
          db.prepare('DELETE FROM entities').run();
          db.prepare('DELETE FROM memories').run();

          // Recreate the delete triggers
          db.exec(`CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
              INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.id, old.content);
          END;`);
          db.exec(`CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
              INSERT INTO entity_fts(entity_fts, rowid, name, summary, type) VALUES('delete', old.id, old.name, old.summary, old.type);
          END;`);
          db.exec(`CREATE TRIGGER IF NOT EXISTS entity_facts_ad AFTER DELETE ON entity_facts BEGIN
              INSERT INTO entity_fact_fts(entity_fact_fts, rowid, fact, entity_id) VALUES('delete', old.id, old.fact, old.entity_id);
          END;`);

          // Rebuild FTS indexes so they reflect the now-empty source tables
          try {
              db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
              db.exec("INSERT INTO entity_fts(entity_fts) VALUES('rebuild')");
              db.exec("INSERT INTO entity_fact_fts(entity_fact_fts) VALUES('rebuild')");
          } catch (e) {
              console.error('[IPC] FTS rebuild during clean reprocess failed (non-fatal):', e);
          }

          const deletedCounts = {
              entities: (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c,
              memories: (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c,
              facts: (db.prepare('SELECT COUNT(*) as c FROM entity_facts').get() as { c: number }).c,
          };
          console.log('[IPC] Post-delete counts (should all be 0):', deletedCounts);

          // Notify frontend to refresh immediately after clearing
          BrowserWindow.getAllWindows().forEach(win => {
              win.webContents.send('reprocess:progress', { phase: 'cleared', processed: 0, total: sessions.length });
          });

          for (const session of sessions) {
              try {
                  // Re-evaluate memories for each message in the session
                  const msgs = db.prepare('SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(session.id) as { id: number; role: string; content: string }[];
                  const conv = db.prepare('SELECT app_name FROM conversations WHERE id = ?').get(session.id) as { app_name: string } | undefined;
                  const appName = conv?.app_name || 'Unknown';

                  for (const msg of msgs) {
                      await evaluateAndStoreMemoryForMessage({
                          sessionId: session.id,
                          appName,
                          role: msg.role,
                          content: msg.content,
                          messageId: msg.id
                      });
                  }

                  // Re-extract entities from the newly created memories
                  await extractEntitiesForSession(session.id);
                  processed++;

                  // Send progress updates
                  BrowserWindow.getAllWindows().forEach(win => {
                      win.webContents.send('reprocess:progress', { phase: 'processing', processed, total: sessions.length });
                  });
              } catch (e) {
                  console.error(`[IPC] Failed to reprocess session ${session.id}:`, e);
              }
          }

          // Rebuild entity edges from mentions across all entities
          rebuildEntityEdgesForAllSessions();
      } else {
          // Additive reprocess: keep existing data, just re-run entity extraction on top
          console.log('[IPC] Additive reprocess: re-extracting entities with current settings (keeping existing data)...');
          for (const session of sessions) {
              try {
                  await extractEntitiesForSession(session.id);
                  processed++;
              } catch (e) {
                  console.error(`[IPC] Failed to reprocess session ${session.id}:`, e);
              }
          }
      }

      console.log(`[IPC] Reprocessed ${processed} sessions (clean=${clean}) with current strictness settings`);
      return { processed, total: sessions.length };
  });

  // === MODEL DOWNLOAD HANDLERS ===
  
  ipcMain.handle('model:check-status', async () => {
      const { llm } = await import('./llm');
      return {
          downloaded: llm.modelsExist(),
          modelsDir: llm.getModelsDir()
      };
  });

  ipcMain.handle('model:download', async () => {
      const { llm } = await import('./llm');
      const modelsDir = llm.getModelsDir();
      const fs = await import('fs');
      const path = await import('path');
      const https = await import('https');
      
      // Ensure models directory exists
      if (!fs.existsSync(modelsDir)) {
          fs.mkdirSync(modelsDir, { recursive: true });
      }

      const models = [
          {
              name: 'Qwen3-VL-4B-Instruct-Q4_K_M.gguf',
              url: 'https://huggingface.co/bartowski/Qwen_Qwen3-VL-4B-Instruct-GGUF/resolve/main/Qwen_Qwen3-VL-4B-Instruct-Q4_K_M.gguf'
          },
          {
              name: 'mmproj-Qwen3VL-4B-Instruct-F16.gguf',
              url: 'https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-4B-Instruct-F16.gguf'
          }
      ];

      const downloadFile = (url: string, destPath: string, modelName: string): Promise<void> => {
          return new Promise((resolve, reject) => {
              const file = fs.createWriteStream(destPath);
              
              const request = (redirectUrl: string) => {
                  https.get(redirectUrl, (response) => {
                      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                          request(response.headers.location);
                          return;
                      }
                      
                      if (response.statusCode !== 200) {
                          fs.unlink(destPath, () => {});
                          reject(new Error(`HTTP ${response.statusCode}`));
                          return;
                      }
                      
                      const totalSize = parseInt(response.headers['content-length'] || '0', 10);
                      let downloaded = 0;
                      
                      response.pipe(file);
                      
                      response.on('data', (chunk: Buffer) => {
                          downloaded += chunk.length;
                          const percent = totalSize ? Math.round((downloaded / totalSize) * 100) : 0;
                          
                          // Send progress to renderer
                          BrowserWindow.getAllWindows().forEach(win => {
                              win.webContents.send('model:download-progress', {
                                  modelName,
                                  percent,
                                  downloadedMB: (downloaded / 1024 / 1024).toFixed(1),
                                  totalMB: totalSize ? (totalSize / 1024 / 1024).toFixed(1) : '?'
                              });
                          });
                      });
                      
                      file.on('finish', () => {
                          file.close();
                          resolve();
                      });
                  }).on('error', (err) => {
                      fs.unlink(destPath, () => {});
                      reject(err);
                  });
              };
              
              request(url);
          });
      };

      try {
          for (const model of models) {
              const destPath = path.join(modelsDir, model.name);

              if (fs.existsSync(destPath)) {
                  console.log(`[Model] ${model.name} already exists, skipping`);
                  continue;
              }

              console.log(`[Model] Downloading ${model.name}...`);
              await downloadFile(model.url, destPath, model.name);
              console.log(`[Model] ${model.name} downloaded`);
          }

          return { success: true };
      } catch (err: any) {
          console.error('[Model] Download failed:', err);
          return { success: false, error: err.message };
      }
  });

  // === OFF GRID MODEL CATALOG (text, vision, image, voice, transcription) ===

  ipcMain.handle('models:catalog', async () => {
      const { CATALOG, MODEL_KINDS } = await import('@offgrid/models');
      return { kinds: MODEL_KINDS, models: CATALOG };
  });

  ipcMain.handle('models:installed', async () => {
      const { CATALOG } = await import('@offgrid/models');
      const { llm } = await import('./llm');
      const { isMfluxModelCached } = await import('./mflux');
      const fs = await import('fs');
      const path = await import('path');
      const dir = llm.getModelsDir();
      return CATALOG.filter((m) => {
          // MLX/mflux models have no files[] (mflux fetches its own weights) —
          // check the HF cache. Otherwise an empty files[] would always pass .every().
          if (m.runtime === 'mflux') return isMfluxModelCached(m.id);
          return m.files.length > 0 && m.files.every((f) => {
              try { return fs.statSync(path.join(dir, f.name)).size > 0; } catch { return false; }
          });
      }).map((m) => m.id);
  });

  // Search Hugging Face for GGUF models.
  ipcMain.handle('models:search', async (_, query: string, kind?: string) => {
      try {
          const { searchHuggingFace } = await import('@offgrid/models');
          const k = kind as undefined | 'text' | 'vision' | 'image' | 'voice' | 'transcription';
          return await searchHuggingFace(query, { limit: 30, kind: k });
      } catch (err: any) {
          console.error('[Models] HF search failed:', err);
          return [];
      }
  });

  // Download a model by id: a curated catalog entry, or any Hugging Face repo.
  ipcMain.handle('models:download', async (_, modelId: string) => {
      const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models');
      const { llm } = await import('./llm');
      const fs = await import('fs');
      const path = await import('path');
      const entry = CATALOG.find((m) => m.id === modelId) ?? (await resolveHuggingFaceModel(modelId));
      if (!entry) return { success: false, error: 'unknown model' };

      const dir = llm.getModelsDir();
      fs.mkdirSync(dir, { recursive: true });
      const send = (data: Record<string, unknown>) =>
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('model:download-progress', { modelId, ...data }));

      // Allow the renderer to cancel an in-flight download (models:cancel-download).
      const controller = new AbortController();
      downloadControllers.set(modelId, controller);

      // MLX/mflux models: fetch weights into the HF cache via the bundled python.
      if (entry.runtime === 'mflux') {
          try {
              const { downloadMfluxModel } = await import('./mflux');
              await downloadMfluxModel(modelId, (pct) => send({ percent: pct, status: 'downloading' }));
              send({ percent: 100, status: 'completed' });
              return { success: true };
          } catch (err: any) {
              send({ status: 'failed', error: err.message });
              return { success: false, error: err.message };
          }
      }

      try {
          for (const file of entry.files) {
              const dest = path.join(dir, file.name);
              if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
              const res = await fetch(file.url, { signal: controller.signal }); // fetch follows HF redirects
              if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${file.name}`);
              const total = Number(res.headers.get('content-length') ?? 0);
              const partPath = `${dest}.part`;
              const out = fs.createWriteStream(partPath);
              let written = 0;
              const reader = res.body.getReader();
              try {
                  for (;;) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      out.write(Buffer.from(value));
                      written += value.length;
                      send({
                          currentFile: file.name,
                          percent: total ? Math.round((written / total) * 100) : 0,
                          downloadedMB: (written / 1048576).toFixed(1),
                          totalMB: total ? (total / 1048576).toFixed(1) : '?',
                      });
                  }
              } finally {
                  out.end();
                  await new Promise<void>((r) => out.on('finish', () => r()));
              }
              // Cancelled mid-file: drop the partial and stop, leaving nothing behind.
              if (controller.signal.aborted) { fs.rmSync(partPath, { force: true }); break; }
              fs.renameSync(partPath, dest);
          }
          if (controller.signal.aborted) { send({ status: 'cancelled' }); return { success: false, error: 'cancelled' }; }
          send({ percent: 100, status: 'completed' });
          return { success: true };
      } catch (err: any) {
          // An abort surfaces as an AbortError — report it as cancelled, not failed.
          if (controller.signal.aborted || err?.name === 'AbortError') {
              send({ status: 'cancelled' });
              return { success: false, error: 'cancelled' };
          }
          send({ status: 'failed', error: err.message });
          return { success: false, error: err.message };
      } finally {
          downloadControllers.delete(modelId);
      }
  });

  // Cancel an in-flight model download.
  ipcMain.handle('models:cancel-download', (_evt, modelId: string) => {
      const c = downloadControllers.get(modelId);
      if (c) { c.abort(); return true; }
      return false;
  });

  // Set the active LLM (text/vision) model: resolve the catalog entry's files
  // and write active-model.json, then reload the llama-server.
  ipcMain.handle('models:set-active', async (_, modelId: string) => {
      const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models');
      const { llm } = await import('./llm');
      const fs = await import('fs');
      const path = await import('path');
      const entry = CATALOG.find((m) => m.id === modelId) ?? (await resolveHuggingFaceModel(modelId));
      if (!entry) return { success: false, error: 'unknown model' };
      if (entry.kind !== 'text' && entry.kind !== 'vision') {
          return { success: false, error: `${entry.kind} models are not loadable as the chat LLM` };
      }
      const primary = (entry.files.find((f) => f.role === 'primary') ?? entry.files[0])?.name;
      const mmproj = entry.files.find((f) => f.role === 'mmproj')?.name ?? null;
      fs.writeFileSync(
          path.join(llm.getModelsDir(), 'active-model.json'),
          JSON.stringify({ id: modelId, primary, mmproj }, null, 2)
      );
      llm.reloadModel();
      return { success: true };
  });

  ipcMain.handle('models:get-active', async () => {
      const { llm } = await import('./llm');
      const fs = await import('fs');
      const path = await import('path');
      try {
          const cfg = JSON.parse(fs.readFileSync(path.join(llm.getModelsDir(), 'active-model.json'), 'utf-8'));
          return cfg.id ?? null;
      } catch {
          return null;
      }
  });

  // Per-modality active model for the stateless runtimes (image / speech / STT).
  // The text/vision chat LLM keeps models:set-active (it reloads llama-server);
  // these just record the chosen id for the runtime to read on its next call.
  ipcMain.handle('models:set-active-modal', async (_, kind: string, modelId: string | null) => {
      const { setActiveModal } = await import('./active-models');
      if (kind === 'image' || kind === 'speech' || kind === 'transcription') {
          setActiveModal(kind as 'image' | 'speech' | 'transcription', modelId);
          return { success: true };
      }
      return { success: false, error: 'use models:set-active for the chat LLM (text/vision)' };
  });
  ipcMain.handle('models:active-modalities', async () => {
      const { getAllActiveModals } = await import('./active-models');
      const { llm } = await import('./llm');
      const fs = await import('fs');
      const path = await import('path');
      let text: string | null = null;
      try { text = JSON.parse(fs.readFileSync(path.join(llm.getModelsDir(), 'active-model.json'), 'utf-8')).id ?? null; } catch { /* none */ }
      return { text, ...getAllActiveModals() };
  });

  // --- Image generation (stable-diffusion.cpp) ----------------------------
  ipcMain.handle('imagegen:status', async () => {
      const { imageGenStatus } = await import('./imagegen');
      return imageGenStatus();
  });

  ipcMain.handle('imagegen:generate', async (e, params: import('./imagegen').ImageGenParams & { conversationId?: string; projectId?: string | null }) => {
      const { generateImage } = await import('./imagegen');
      const result = await generateImage(params, (p) => {
          try { e.sender.send('imagegen:progress', p); } catch { /* window gone */ }
      });
      // Write a scope sidecar so the gallery can filter images by chat/project.
      try {
          if (result?.path && (params.conversationId || params.projectId)) {
              const fsp = await import('fs');
              fsp.writeFileSync(`${result.path}.json`, JSON.stringify({ conversationId: params.conversationId, projectId: params.projectId ?? null }));
          }
      } catch { /* best effort */ }
      return result;
  });

  ipcMain.handle('imagegen:cancel', async () => {
      const { cancelImageGen } = await import('./imagegen');
      return cancelImageGen();
  });

  ipcMain.handle('imagegen:list', async (_e, scope?: { conversationId?: string; projectId?: string | null }) => {
      const { listGeneratedImages } = await import('./imagegen');
      return listGeneratedImages(scope);
  });

  ipcMain.handle('imagegen:style-thumbs', async () => {
      const { listStyleThumbs } = await import('./imagegen');
      return listStyleThumbs();
  });
  ipcMain.handle('imagegen:make-style-thumb', async (_e, key: string, prompt: string) => {
      const { generateStyleThumb } = await import('./imagegen');
      return generateStyleThumb(key, prompt);
  });
  ipcMain.handle('imagegen:list-loras', async () => {
      const { listLoras } = await import('./imagegen');
      return listLoras();
  });
  ipcMain.handle('imagegen:reveal-loras', async () => {
      const { ensureLoraDir } = await import('./imagegen');
      const { shell } = await import('electron');
      const dir = ensureLoraDir();
      await shell.openPath(dir);
      return dir;
  });
  ipcMain.handle('imagegen:download-lora', async (e, url: string, filename: string) => {
      const { downloadLora } = await import('./imagegen');
      return downloadLora(url, filename, (pct) => {
          try { e.sender.send('imagegen:lora-progress', { filename, pct }); } catch { /* window gone */ }
      });
  });

  ipcMain.handle('imagegen:delete', async (_e, p: string) => {
      const { deleteGeneratedImage } = await import('./imagegen');
      return deleteGeneratedImage(p);
  });

  ipcMain.handle('imagegen:export', async (e, srcPath: string, suggestedName?: string) => {
      const { dialog } = await import('electron');
      const fs = await import('fs');
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const res = await dialog.showSaveDialog(win!, {
          title: 'Save image',
          defaultPath: suggestedName || 'off-grid-image.png',
          filters: [{ name: 'PNG', extensions: ['png'] }],
      });
      if (res.canceled || !res.filePath) return false;
      await fs.promises.copyFile(srcPath, res.filePath);
      return true;
  });

  // --- Agentic tool-calling (isolated, opt-in) ----------------------------
  ipcMain.handle('tools:list', async () => {
      const { listTools } = await import('./tools');
      return listTools();
  });
  ipcMain.handle('tools:set-enabled', async (_e, name: string, enabled: boolean) => {
      const { setToolEnabled } = await import('./tools');
      setToolEnabled(name, enabled);
  });
  ipcMain.handle('tools:chat', async (_e, query: string, history?: { role: string; content: string }[], opts?: { connectors?: boolean }) => {
      const { toolChat } = await import('./tools');
      return toolChat(query, history || [], opts || {});
  });

  // --- LLM inference settings (temperature, context window) ---------------
  ipcMain.handle('llm:get-settings', async () => {
      const { llm } = await import('./llm');
      return llm.getSettings();
  });
  ipcMain.handle('llm:set-settings', async (_e, s: import('./llm').LlmSettings) => {
      const { llm } = await import('./llm');
      await llm.setSettings(s);
      return llm.getSettings();
  });

  // --- Canvas / artifacts sandbox runtime ---------------------------------
  ipcMain.handle('artifacts:runtime', async (_e, kind: import('./artifacts').ArtifactKind) => {
      const { artifactRuntime } = await import('./artifacts');
      return artifactRuntime(kind);
  });
  ipcMain.handle('artifacts:save', async (_e, a: { kind: import('./artifacts').ArtifactKind; code: string; title?: string; conversationId?: string; projectId?: string | null }) => {
      const { saveArtifact } = await import('./artifacts');
      return saveArtifact(a);
  });
  ipcMain.handle('artifacts:list', async (_e, scope?: { conversationId?: string; projectId?: string | null }) => {
      const { listArtifacts } = await import('./artifacts');
      return listArtifacts(scope);
  });
  ipcMain.handle('artifacts:delete', async (_e, id: string) => {
      const { deleteArtifact } = await import('./artifacts');
      return deleteArtifact(id);
  });

  // --- File attachments: any file -> text (read / parse / caption / transcribe) ---
  ipcMain.handle('files:process', async (_e, bytes: ArrayBuffer | Uint8Array, name: string) => {
      const { processUpload } = await import('./files');
      return processUpload(name, bytes);
  });

  // --- Skills (.skills folder, invoked from chat with /skill-name) ---
  ipcMain.handle('skills:list', async () => {
      const { listSkills } = await import('./skills');
      return listSkills();
  });
  ipcMain.handle('skills:get', async (_e, name: string) => {
      const { getSkill } = await import('./skills');
      return getSkill(name);
  });
  ipcMain.handle('skills:save', async (_e, input: import('./skills').SkillSaveInput) => {
      const { saveSkill } = await import('./skills');
      return saveSkill(input);
  });
  ipcMain.handle('skills:delete', async (_e, name: string) => {
      const { deleteSkill } = await import('./skills');
      return deleteSkill(name);
  });
  ipcMain.handle('skills:dir', async () => {
      const { skillsDir } = await import('./skills');
      return skillsDir();
  });

  // --- Voice output (TTS via Kokoro) --------------------------------------
  ipcMain.handle('tts:voices', async () => {
      const { listVoices } = await import('./tts');
      try { return await listVoices(); } catch (e) { console.error('[tts] voices failed', e); return []; }
  });

  ipcMain.handle('tts:speak', async (_e, text: string, voice?: string) => {
      const { synthesize } = await import('./tts');
      // Fall back to the user's saved voice (Settings → Voice) when none is passed.
      let chosen = voice;
      if (!chosen) { try { const v = getSetting<string>('ttsVoice', ''); if (v) chosen = v; } catch { /* default */ } }
      return synthesize(text, chosen);
  });

  // --- Voice input (STT via bundled whisper) ------------------------------
  ipcMain.handle('voice:transcribe', async (_e, audio: ArrayBuffer | Uint8Array, ext = 'webm') => {
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');
      const { desktopExtraction } = await import('./rag/extractors');
      if (!desktopExtraction.transcribeAudio) throw new Error('Transcription is not available.');
      const buf = Buffer.from(audio as ArrayBuffer);
      const tmp = path.join(os.tmpdir(), `offgrid-mic-${Date.now()}.${ext}`);
      await fs.promises.writeFile(tmp, buf);
      try {
          return await desktopExtraction.transcribeAudio(tmp);
      } finally {
          fs.promises.unlink(tmp).catch(() => {});
      }
  });

  ipcMain.handle('imagegen:pick-image', async (e) => {
      const { dialog } = await import('electron');
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const res = await dialog.showOpenDialog(win!, {
          title: 'Choose an init image',
          properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      return res.filePaths[0];
  });
}

