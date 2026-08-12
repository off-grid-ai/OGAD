import { ipcMain, BrowserWindow, app, clipboard } from 'electron'
import { setupArtifactPreviewIpc } from './artifact-preview-ipc'
import {
  getDB,
  getChatSessions,
  upsertChatSummary,
  getMemoriesForSession,
  getMemoryRecordsForSession,
  getMasterMemory,
  addEntityFact,
  updateEntitySummary,
  getEntities,
  getEntityDetails,
  upsertEntitySession,
  deleteMemory,
  getEntitiesForSession,
  getDashboardStats,
  getUserProfile,
  saveUserProfile,
  UserProfile,
  createRagConversation,
  getRagConversations,
  getRagConversation,
  deleteRagConversation,
  addRagMessage,
  getRagMessages,
  updateRagConversationTitle,
  searchRagConversationIds,
  getSettings,
  saveSetting,
  getSetting
} from './database'
import { deleteEntityById, resolveEntityCandidate } from './entity-domain'
import { embeddings } from './embeddings'
import {
  getResidency,
  setResidencyMode,
  type Modality,
  type ResidencyMode
} from './runtime-residency'
import {
  requestAccessibilityPermission,
  requestScreenRecordingPermission,
  openAccessibilitySettings,
  openScreenRecordingSettings,
  openMicrophoneSettings,
  openLocalNetworkSettings
} from './permissions'
import { setupSystemStatusIpc } from './system-status-ipc'
import { CACHE_CLEANUP_CHANNEL } from '../shared/ipc-contracts'
import { toResponseGenerationResult, type ResponseGenerationResult } from './llm/response-result'
import { getAllPromptDefs } from './prompts'
import { getPrompt, getPromptTemplate, resetPrompt } from './prompt-store'
import { setupTtsIpc } from './tts-ipc'
import {
  safeParseJson,
  tokenizeQuery,
  clipText,
  isGenerativeRequest,
  isTrivialMessage,
  appNameLikeClause
} from './ipc-query-logic'
import { requestApplicationRelaunch } from './shutdown'
// import { llm } from './llm'; // Moved to dynamic import to support ESM

// Incrementally update master memory with a new conversation summary
// This approach keeps context bounded by only processing current master + new summary
async function updateMasterMemoryIncremental(_newSummary: string): Promise<string | null> {
  // Master memory (the consolidated "profile") is a retired My Memories feature —
  // no longer injected into chat. Don't regenerate it so it stays cleared.
  return null
}

// Full regeneration using map-reduce:
// Phase 1 (map): Split summaries into chunks, generate a partial summary for each
// Phase 2 (reduce): Merge all partial summaries into the final master memory
// This avoids the growing-prompt problem and minimizes LLM calls
async function regenerateMasterMemoryFull(): Promise<string | null> {
  // Retired feature — see updateMasterMemoryIncremental. Don't rebuild the profile.
  return null
}

// Main entry point - full regeneration
async function regenerateMasterMemory(): Promise<string | null> {
  return regenerateMasterMemoryFull()
}

// Generate the answer for a rag:chat turn. When a streamId + sender are present,
// stream tokens/reasoning to the renderer over the 'rag:stream' channel as they
// arrive (inline chain-of-thought); otherwise fall back to a single blocking call.
// Active streaming turns, keyed by streamId, so a renderer 'rag:cancel' can abort
// an in-flight generation and keep whatever was produced so far.
import {
  bindChatStream,
  endChatStream,
  noteChatStreamDelta
} from './chat-stream-state'

const streamControllers = new Map<string, AbortController>()

async function streamAnswer(
  event: { sender?: { send: (channel: string, payload: unknown) => void } } | undefined,
  streamId: string | undefined,
  prompt: string,
  thinking: boolean = false,
  images: string[] = []
): Promise<ResponseGenerationResult> {
  const { llm } = await import('./llm')
  const { modalityQueue, CHAT_JOB } = await import('./modality-queue/queue')

  // No-renderer fallback still uses the same streaming transport with a no-op
  // observer, so finish metadata and the configured cap cannot diverge by caller.
  if (!streamId || !event?.sender) {
    // Interactive chat is foreground work - Tier 2, a peer of image gen. During
    // image gen the LLM is evicted so this waits anyway (consistent); background
    // screen-replay (Tier 3) defers to it. Chat runs ON the 'llm' engine, so it
    // evicts nothing (evicting 'llm' would evict itself). run()'s finally releases
    // the slot even if fn throws, so we let errors propagate from inside.
    return modalityQueue.run(CHAT_JOB, async () =>
      toResponseGenerationResult(await llm.chatStream(prompt, images, () => {}, { thinking }))
    )
  }

  const sender = event.sender
  // Register the abort controller BEFORE queuing so a rag:cancel that arrives while
  // this turn is still WAITING in the queue is honored - the stream then starts with
  // an already-aborted signal (and resolves immediately) rather than running in full.
  const controller = new AbortController()
  streamControllers.set(streamId, controller)
  try {
    // Interactive streaming chat = Tier 2 (see above). Await the full stream inside
    // the run() callback so the queue slot is held for the whole generation; the
    // cancel path aborts via the controller registered above.
    return await modalityQueue.run(CHAT_JOB, async () => {
      const result = await llm.chatStream(
        prompt,
        images,
        (text, kind) => {
          noteChatStreamDelta(streamId, text, kind)
          try {
            sender.send('rag:stream', { streamId, type: kind, text })
          } catch {
            /* window gone */
          }
        },
        { thinking, signal: controller.signal }
      )
      return toResponseGenerationResult(result)
    })
  } finally {
    streamControllers.delete(streamId)
    endChatStream(streamId)
  }
}

type ChatIntent = { intent: 'build' | 'image' | 'chat'; urls: string[] }

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['build', 'image', 'chat'] },
    urls: { type: 'array', items: { type: 'string' } }
  },
  required: ['intent', 'urls'],
  additionalProperties: false
}

// Decide the output format for a turn with the model itself (grammar-constrained
// JSON), instead of brittle keyword matching: build (runnable artifact), image
// (generate a picture), or chat. Also pulls out any URLs the user wants read.
// Falls back to the keyword heuristic if the classifier call fails.
async function classifyIntent(
  query: string,
  history?: { role: string; content: string }[],
  streamId?: string
): Promise<ChatIntent> {
  const regexUrls = (query.match(/https?:\/\/[^\s)<>"']+/g) || []).slice(0, 3)
  // Register a controller for this pre-stream classify so a rag:cancel during the
  // "Searching your memory…" window actually aborts the model call (D11) — without
  // it the classify ran to completion after Stop, holding the model + the next turn.
  const controller = streamId ? new AbortController() : undefined
  if (streamId && controller) streamControllers.set(streamId, controller)
  try {
    const { llm } = await import('./llm')
    const hist = (history ?? [])
      .slice(-4)
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${clipText(m.content, 200)}`)
      .join('\n')
    const prompt = [
      'You route a request for an on-device assistant. Decide the OUTPUT FORMAT:',
      '- "build": the user wants runnable code / a UI created — an app, component, page, playground, dashboard, form, diagram, chart, visualization, game, etc. (rendered live in a canvas).',
      '- "image": the user wants a picture/photo/logo/illustration/art generated.',
      '- "chat": anything else — questions, explanations, writing, discussion.',
      'Also list any http(s) URLs the user wants you to read or build from.',
      'Reply with ONLY JSON: {"intent":"build|image|chat","urls":[]}.',
      hist ? `Recent conversation:\n${hist}` : '',
      `User: ${query}`
    ]
      .filter(Boolean)
      .join('\n\n')
    const raw = await llm.chat(prompt, [], 60000, 200, {
      disableThinking: true,
      responseFormat: {
        type: 'json_schema',
        json_schema: { name: 'intent', schema: INTENT_SCHEMA, strict: true }
      },
      signal: controller?.signal
    })
    const j = JSON.parse(raw) as Partial<ChatIntent>
    const intent = j.intent === 'build' || j.intent === 'image' ? j.intent : 'chat'
    const urls = Array.isArray(j.urls) ? j.urls.filter((u) => /^https?:\/\//i.test(u)) : []
    return { intent, urls: urls.length ? urls.slice(0, 3) : regexUrls }
  } catch (e) {
    console.warn('[intent] classifier failed, falling back to heuristic', (e as Error).message)
    return { intent: isGenerativeRequest(query) ? 'build' : 'chat', urls: regexUrls }
  } finally {
    // Only remove OUR entry — streamAnswer re-registers its own controller under
    // the same streamId for the streaming phase.
    if (streamId && controller && streamControllers.get(streamId) === controller)
      streamControllers.delete(streamId)
  }
}

async function insertMemoryRecord(params: {
  content: string
  name?: string | null
  rawText?: string | null
  sourceApp?: string | null
  sessionId?: string | null
  messageId?: number | null
}): Promise<number | null> {
  const db = getDB()
  const content = (params.content || '').trim()
  if (!content) return null

  if (params.messageId) {
    const existing = db
      .prepare('SELECT id FROM memories WHERE message_id = ? LIMIT 1')
      .get(params.messageId) as { id: number } | undefined
    if (existing?.id) return existing.id
  }

  if (params.sessionId) {
    const existing = db
      .prepare('SELECT id FROM memories WHERE session_id = ? AND content = ? LIMIT 1')
      .get(params.sessionId, content) as { id: number } | undefined
    if (existing?.id) return existing.id
  }

  let vectorJson = '[]'
  try {
    const vector = await embeddings.generateEmbedding(content)
    vectorJson = JSON.stringify(vector)
  } catch (e) {
    console.error('Failed to generate embedding for memory record:', e)
  }

  const stmt = db.prepare(
    'INSERT INTO memories (content, name, raw_text, source_app, session_id, embedding, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const info = stmt.run(
    content,
    params.name || null,
    params.rawText || null,
    params.sourceApp || null,
    params.sessionId || null,
    vectorJson,
    params.messageId || null
  )
  const memoryId = Number(info.lastInsertRowid || 0) || null

  // Send notification about new memory
  if (memoryId) {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('notification:new-memory', {
        sessionId: params.sessionId || null,
        memoryContent: content.slice(0, 100) + (content.length > 100 ? '...' : '')
      })
    })
  }

  return memoryId
}

export async function evaluateAndStoreMemoryForMessage(params: {
  sessionId: string
  appName: string
  role: string
  content: string
  messageId?: number | null
}): Promise<void> {
  const role = (params.role || 'unknown').toLowerCase()
  const text = (params.content || '').trim()
  if (!text || isTrivialMessage(text)) return

  // Get strictness setting
  const strictness = getSetting<'lenient' | 'balanced' | 'strict'>('memoryStrictness', 'balanced')

  const prompt = getPrompt(`memoryFilter.${strictness}`, { ROLE: role, MESSAGE: text })

  // Minimum content length filter: skip very short messages
  if (role === 'user' && text.length < 30) return
  if (role === 'assistant' && text.length < 50) return

  try {
    const { llm } = await import('./llm')
    const response = await llm.chat(prompt)
    const parsed = safeParseJson<{ store: boolean; name?: string; memory?: string }>(response, {
      store: false
    })
    if (!parsed.store) return
    const memoryText = (parsed.memory || '').trim()
    const memoryName = (parsed.name || '').trim() || null
    if (!memoryText) return
    if (memoryText.split(/\s+/).length < 4) return
    if (memoryText.length > 280) return

    // Post-LLM filter: skip memories matching generic / low-value patterns
    const genericPatterns = [
      /^the user (asked|said|mentioned|wanted|is|was|has|had)\b/i,
      /^(this|that|it) (is|was|seems|appears|looks)\b/i,
      /^(a|an|the) (good|great|nice|common|typical|standard|normal)\b/i,
      /\b(in general|generally speaking|as usual|as always)\b/i
    ]
    if (genericPatterns.some((p) => p.test(memoryText))) return

    // Post-LLM filter: skip near-duplicates via substring check against existing session memories
    if (params.sessionId) {
      const existingMemories = getMemoryRecordsForSession(params.sessionId)
      const memLower = memoryText.toLowerCase()
      const isDuplicate = existingMemories.some((m: any) => {
        const existing = (m.content || '').toLowerCase()
        return existing === memLower || existing.includes(memLower) || memLower.includes(existing)
      })
      if (isDuplicate) return
    }

    await insertMemoryRecord({
      content: memoryText,
      name: memoryName,
      rawText: text,
      sourceApp: params.appName,
      sessionId: params.sessionId,
      messageId: params.messageId || null
    })
  } catch (e) {
    console.error('[IPC] Memory evaluation failed:', e)
  }
}

async function extractEntitiesForSession(sessionId: string): Promise<void> {
  const memories = getMemoryRecordsForSession(sessionId)
  if (memories.length === 0) return

  // Get strictness setting
  const strictness = getSetting<'lenient' | 'balanced' | 'strict'>('entityStrictness', 'balanced')

  const memoryText = memories.map((m: any) => `- ${m.content}`).join('\n')

  const prompt = getPrompt(`entityExtraction.${strictness}`, { MEMORY_TEXT: memoryText })

  try {
    const { llm } = await import('./llm')
    const response = await llm.chat(prompt)
    const parsed = safeParseJson<{ entities: { name: string; type?: string; facts?: string[] }[] }>(
      response,
      { entities: [] }
    )

    if (parsed.entities.length === 0) return

    for (const entity of parsed.entities) {
      const name = (entity.name || '').trim()
      if (!name) continue
      const type = (entity.type || 'Unknown').trim() || 'Unknown'
      const facts = Array.isArray(entity.facts)
        ? entity.facts
            .filter(Boolean)
            .map((f) => f.trim())
            .filter(Boolean)
        : []

      if (facts.length === 0) continue

      const resolution = resolveEntityCandidate({ name, type })
      if (!resolution.admitted) continue
      const entityId = resolution.entityId
      if (!entityId) continue
      upsertEntitySession(entityId, sessionId)

      const newFacts: string[] = []
      for (const fact of facts) {
        const inserted = addEntityFact(entityId, fact, sessionId)
        if (inserted) newFacts.push(fact)
      }

      // Send notification about new entity with facts
      if (newFacts.length > 0) {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('notification:new-entity', {
            entityId,
            entityName: name,
            entityType: type,
            factsCount: newFacts.length
          })
        })
      }

      if (newFacts.length === 0) continue

      const details = getEntityDetails(entityId) as { entity?: { summary?: string } } | null
      const existingSummary = details?.entity?.summary || ''

      const summaryPrompt = getPrompt('entitySummary', {
        NAME: name,
        TYPE: type,
        EXISTING_SUMMARY: existingSummary || '(none)',
        NEW_FACTS: '- ' + newFacts.join('\n- ')
      })

      try {
        const updatedSummary = await llm.chat(summaryPrompt)
        if (updatedSummary && updatedSummary.trim()) {
          updateEntitySummary(entityId, updatedSummary.trim())
        }
      } catch (e) {
        console.error('[IPC] Failed to update entity summary:', e)
      }
    }

  } catch (e) {
    console.error('[IPC] Entity extraction failed:', e)
  }
}

export async function summarizeSession(sessionId: string): Promise<string | null> {
  const memories = getMemoriesForSession(sessionId)
  if (memories.length === 0) return null

  const conversationText = memories
    .map((m: any) => `[${m.role || 'unknown'}]: ${m.content}`)
    .join('\n')
  const prompt = getPrompt('sessionSummary', { CONVERSATION_TEXT: conversationText })

  try {
    const { llm } = await import('./llm')
    const summary = await llm.chat(prompt, [], 120000, 2048)
    upsertChatSummary(sessionId, summary)

    // Extract and update entity memory (non-blocking — don't fail the summary if these error)
    try {
      await extractEntitiesForSession(sessionId)
    } catch (entityErr) {
      console.error('[IPC] Entity extraction failed (non-fatal):', entityErr)
    }

    // Incrementally update master memory with the new summary
    try {
      await updateMasterMemoryIncremental(summary)
    } catch (masterErr) {
      console.error('[IPC] Master memory incremental update failed (non-fatal):', masterErr)
    }

    return summary
  } catch (e) {
    console.error('Failed to summarize session:', e)
    throw e
  }
}

export function setupIPC() {
  const db = getDB()
  setupTtsIpc()
  setupSystemStatusIpc(ipcMain)

  ipcMain.handle('db:get-memories', (_, limit: number = 50, appName?: string) => {
    let query = 'SELECT * FROM memories '
    const params: any[] = []

    const memFilter = appNameLikeClause(appName, 'source_app')
    if (memFilter) {
      query += `WHERE ${memFilter.clause} `
      params.push(memFilter.param)
    }

    query += 'ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    const stmt = db.prepare(query)
    // SQLite stores timestamps as UTC strings "YYYY-MM-DD HH:MM:SS" by default with CURRENT_TIMESTAMP
    // To ensure JS treats them as UTC, we might need to append 'Z' or standardise.
    // However, simplest is to let frontend handle "UTC" assumption.
    return stmt.all(...params)
  })

  ipcMain.handle(
    'db:add-memory',
    async (_, content: string, source: string = 'user-input', sessionId?: string) => {
      // Generate embedding
      let vectorJson = '[]'
      try {
        const vector = await embeddings.generateEmbedding(content)
        vectorJson = JSON.stringify(vector)
      } catch (e) {
        console.error('Failed to generate embedding:', e)
      }

      // Check if we can update an existing session
      if (sessionId) {
        // Look for a recent memory (e.g. last 12 hours) with this session_id
        const existing = db
          .prepare(
            'SELECT id FROM memories WHERE session_id = ? AND created_at > datetime("now", "-12 hours") ORDER BY id DESC LIMIT 1'
          )
          .get(sessionId) as { id: number } | undefined

        if (existing) {
          console.log(`Updating existing memory session ${sessionId} (ID: ${existing.id})`)
          const stmt = db.prepare(
            'UPDATE memories SET content = ?, embedding = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?'
          )
          stmt.run(content, vectorJson, existing.id)
          return { id: existing.id, updated: true }
        }
      }

      const stmt = db.prepare(
        'INSERT INTO memories (content, source_app, session_id, embedding) VALUES (?, ?, ?, ?)'
      )
      const info = stmt.run(content, source, sessionId || null, vectorJson)
      return { id: info.lastInsertRowid }
    }
  )

  ipcMain.handle('db:search-memories', async (_, query: string) => {
    try {
      const queryVector = await embeddings.generateEmbedding(query)
      const vecStr = JSON.stringify(queryVector)

      const stmt = db.prepare(`
          SELECT *, cosine_similarity(embedding, ?) as score 
          FROM memories 
          WHERE embedding IS NOT NULL AND embedding != '[]'
          ORDER BY score DESC 
          LIMIT 20
        `)
      return stmt.all(vecStr)
    } catch (e) {
      console.error('Vector search failed, falling back to FTS', e)
      const stmt = db.prepare(`
          SELECT memories.* 
          FROM memories 
          JOIN memory_fts ON memories.id = memory_fts.rowid 
          WHERE memory_fts MATCH ? 
          LIMIT 20
        `)
      return stmt.all(query)
    }
  })

  ipcMain.handle('db:get-stats', () => {
    const count = db.prepare('SELECT COUNT(*) as count FROM memories').get()
    return count
  })

  ipcMain.handle('db:get-dashboard-stats', () => {
    return getDashboardStats()
  })

  ipcMain.handle('llm:extract', async (_, text: string) => {
    try {
      const { llm } = await import('./llm')
      const response = await llm.chat(
        `Analyze the following text and extract a summary and key topics. Return JSON only with keys: summary, topic, entities. Text: "${text}"`
      )

      // Basic cleanup if the model returns markdown code blocks
      const cleanJson = response.replace(/```json\n?|\n?```/g, '').trim()

      return JSON.parse(cleanJson)
    } catch (e) {
      console.error('LLM Extraction failed:', e)
      // Fallback
      return {
        summary: text.slice(0, 50) + '...',
        topic: 'General (Fallback)',
        entities: []
      }
    }
  })

  // Cancel an in-flight streaming turn; chatStream resolves with the partial answer.
  ipcMain.on('rag:cancel', (_evt, streamId: string) => {
    streamControllers.get(streamId)?.abort()
  })

  ipcMain.handle(
    'rag:chat',
    async (
      event,
      query: string,
      appName?: string,
      conversationHistory?: { role: string; content: string }[],
      projectId?: string | null,
      conversationId?: string,
      noMemory?: boolean,
      streamId?: string,
      thinking?: boolean,
      images?: string[]
    ) => {
      const imgs = images || []
      // Before the classifier, so the whole turn - including its thinking - is attributable to the
      // conversation it belongs to.
      bindChatStream(streamId, conversationId)
      // Intelligence layer: a grammar-constrained classifier picks the output
      // format (build / image / chat) and extracts URLs to read — replacing the
      // brittle keyword gate. Skip it in project mode (that path is its own thing).
      const { intent, urls: intentUrls } = projectId
        ? { intent: 'chat' as const, urls: [] as string[] }
        : await classifyIntent(query, conversationHistory, streamId)

      // Image request → have the model write a vivid prompt, then the renderer
      // generates it (it already detects an ```image block).
      if (intent === 'image') {
        const imgPrompt = `Write ONE vivid, detailed image-generation prompt (visual description only, no preamble) for this request:\n${query}`
        const desc = (
          await (
            await import('./llm')
          ).llm.chat(imgPrompt, [], 60000, 200, { disableThinking: true })
        )
          .trim()
          .replace(/^["']|["']$/g, '')
        return { answer: '```image\n' + (desc || query) + '\n```', context: undefined }
      }

      // Build request → artifact prompt (even in No-memory mode), with any URLs
      // fetched for us so the small model never has to chain tools.
      if (intent === 'build') {
        let historyBlock = ''
        if (conversationHistory && conversationHistory.length > 0) {
          const historyLines = conversationHistory
            .map(
              (msg) =>
                `${msg.role === 'user' ? 'User' : 'Assistant'}: ${clipText(msg.content, 400)}`
            )
            .join('\n')
          historyBlock = `Conversation so far:\n${historyLines}`
        }
        // read_url → build: fetch the classifier's URLs (deterministic).
        let referenceBlock = ''
        const urls = intentUrls
        if (urls.length) {
          if (streamId)
            event.sender.send('rag:stream', {
              streamId,
              type: 'step',
              step: { kind: 'reading', counts: { urls: urls.length } }
            })
          const { readUrlText } = await import('./tools')
          const parts: string[] = []
          for (const u of urls) {
            try {
              parts.push(
                `--- Content fetched from ${u} ---\n${clipText(await readUrlText(u), 5000)}`
              )
            } catch (e) {
              parts.push(`--- Could not fetch ${u}: ${(e as Error).message} ---`)
            }
          }
          referenceBlock = `REFERENCE — the user pointed you at these page(s); BUILD using this content (e.g. if it's API docs, build a UI that actually calls those endpoints):\n${parts.join('\n\n')}`
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
          'Assistant:'
        ]
          .filter(Boolean)
          .join('\n\n')
        const completion = await streamAnswer(event, streamId, prompt, thinking, imgs)
        return { ...completion, context: undefined }
      }

      // No-memory mode: a plain on-device assistant — no retrieval at all.
      if (noMemory) {
        const { llm } = await import('./llm')
        const hist = (conversationHistory ?? [])
          .slice(-10)
          .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
          .join('\n')
        const prompt = [
          'You are Off Grid, a private, on-device assistant.',
          'You can generate images on-device. If (and only if) the user is asking for a picture/image/logo/art to be CREATED, respond with ONLY a fenced block ```image\\n<a detailed image prompt>\\n``` and nothing else. For everything else, answer normally in text.',
          hist ? `Conversation so far:\n${hist}` : '',
          `User: ${query}`,
          'Assistant:'
        ]
          .filter(Boolean)
          .join('\n\n')
        void llm // retained for non-stream fallback inside streamAnswer
        const completion = await streamAnswer(event, streamId, prompt, thinking, imgs)
        return { ...completion, context: undefined }
      }

      // Project-scoped chat: retrieve from the project's knowledge base (uploaded
      // docs + optionally captured memory) AND reference sibling chats in the project.
      if (projectId) {
        const { ragService } = await import('./rag')
        const { listProjects } = await import('./rag/store')
        const { getProjectChatHistory } = await import('./database')
        const { formatForPrompt } = await import('@offgrid/rag')
        const { llm } = await import('./llm')
        const project = listProjects().find((p) => p.id === projectId)
        const sys = project?.systemPrompt.trim() || 'You are a helpful assistant for this project.'
        const search = await ragService.searchProject(projectId, query, {
          topK: 6,
          contextLength: 4096
        })
        const ctx = formatForPrompt(search)
        // Cross-chat memory: recent messages from other chats in this project.
        const siblings = getProjectChatHistory(projectId, conversationId ?? '', 12)
        const siblingCtx = siblings.length
          ? 'Related discussion from other chats in this project:\n' +
            siblings
              .map(
                (m) =>
                  `${m.role === 'assistant' ? 'Assistant' : 'User'}${m.title ? ` (${m.title})` : ''}: ${m.content}`
              )
              .join('\n')
          : ''
        const hist = (conversationHistory ?? [])
          .slice(-8)
          .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
          .join('\n')
        const prompt = [
          sys,
          ctx,
          siblingCtx,
          hist ? `Conversation so far:\n${hist}` : '',
          `User: ${query}`,
          'Assistant:'
        ]
          .filter(Boolean)
          .join('\n\n')
        void llm // retained for non-stream fallback inside streamAnswer
        if (streamId)
          event.sender.send('rag:stream', {
            streamId,
            type: 'step',
            step: {
              kind: 'project',
              counts: { sources: search.chunks.length, projectChats: siblings.length }
            }
          })
        const completion = await streamAnswer(event, streamId, prompt, thinking, imgs)
        return {
          ...completion,
          context: {
            sources: search.chunks.map((c) => ({
              name: c.name,
              position: c.position,
              score: c.score
            })),
            projectChats: siblings.length
          }
        }
      }

      if (streamId)
        event.sender.send('rag:stream', { streamId, type: 'step', step: { kind: 'searching' } })
      const db = getDB()
      const tokens = tokenizeQuery(query)
      const ftsQuery = tokens.length > 0 ? tokens.join(' OR ') : query

      let memories: any[] = []
      try {
        const queryVector = await embeddings.generateEmbedding(query)
        const vecStr = JSON.stringify(queryVector)
        const params: any[] = [vecStr]
        let memoryQuery = `
            SELECT *, cosine_similarity(embedding, ?) as score
            FROM memories
            WHERE embedding IS NOT NULL AND embedding != '[]'
          `
        const vecFilter = appNameLikeClause(appName, 'source_app')
        if (vecFilter) {
          memoryQuery += ` AND ${vecFilter.clause} `
          params.push(vecFilter.param)
        }
        memoryQuery += ` ORDER BY score DESC LIMIT 12`
        memories = db.prepare(memoryQuery).all(...params)
        memories = memories.filter((m: any) => typeof m.score !== 'number' || m.score >= 0.2)
      } catch (e) {
        console.error('[RAG] Vector search failed, falling back to FTS', e)
        const params: any[] = []
        let fallbackQuery = `
            SELECT memories.*
            FROM memories
            JOIN memory_fts ON memories.id = memory_fts.rowid
            WHERE memory_fts MATCH ?
          `
        params.push(query)
        const ftsFilter = appNameLikeClause(appName, 'memories.source_app')
        if (ftsFilter) {
          fallbackQuery += ` AND ${ftsFilter.clause} `
          params.push(ftsFilter.param)
        }
        fallbackQuery += ` LIMIT 12`
        memories = db.prepare(fallbackQuery).all(...params)
      }

      const messageParams: any[] = [ftsQuery]
      let messageQuery = `
                SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title, c.app_name,
                             bm25(message_fts) as score
                FROM message_fts
                JOIN messages m ON message_fts.rowid = m.id
                JOIN conversations c ON c.id = m.conversation_id
                WHERE message_fts MATCH ?
            `
      const msgFilter = appNameLikeClause(appName, 'c.app_name')
      if (msgFilter) {
        messageQuery += ` AND ${msgFilter.clause} `
        messageParams.push(msgFilter.param)
      }
      messageQuery += ` ORDER BY score ASC LIMIT 12`
      const messages = db.prepare(messageQuery).all(...messageParams)

      const summaryParams: any[] = [ftsQuery]
      let summaryQuery = `
                SELECT cs.session_id, cs.summary, c.title, c.app_name, c.updated_at,
                             bm25(summary_fts) as score
                FROM summary_fts
                JOIN chat_summaries cs ON summary_fts.rowid = cs.rowid
                JOIN conversations c ON c.id = cs.session_id
                WHERE summary_fts MATCH ?
            `
      const sumFilter = appNameLikeClause(appName, 'c.app_name')
      if (sumFilter) {
        summaryQuery += ` AND ${sumFilter.clause} `
        summaryParams.push(sumFilter.param)
      }
      summaryQuery += ` ORDER BY score ASC LIMIT 8`
      const summaries = db.prepare(summaryQuery).all(...summaryParams)

      const entityParams: any[] = [ftsQuery]
      let entityQuery = `
                SELECT e.id, e.name, e.type, e.summary, e.updated_at,
                             bm25(entity_fts) as score
                FROM entity_fts
                JOIN entities e ON entity_fts.rowid = e.id
                WHERE entity_fts MATCH ?
            `
      const entFilter = appNameLikeClause(appName, 'c.app_name')
      if (entFilter) {
        entityQuery += `
                        AND e.id IN (
                            SELECT es.entity_id
                            FROM entity_sessions es
                            JOIN conversations c ON c.id = es.session_id
                            WHERE ${entFilter.clause}
                        )
                    `
        entityParams.push(entFilter.param)
      }
      entityQuery += ` ORDER BY score ASC LIMIT 8`
      const entities = db.prepare(entityQuery).all(...entityParams)

      const factParams: any[] = [ftsQuery]
      let factQuery = `
                SELECT f.fact, f.created_at, f.source_session_id, e.name, e.type,
                             bm25(entity_fact_fts) as score
                FROM entity_fact_fts
                JOIN entity_facts f ON entity_fact_fts.rowid = f.id
                JOIN entities e ON e.id = f.entity_id
                WHERE entity_fact_fts MATCH ?
            `
      const factFilter = appNameLikeClause(appName, 'app_name')
      if (factFilter) {
        factQuery += ` AND f.source_session_id IN (SELECT id FROM conversations WHERE ${factFilter.clause}) `
        factParams.push(factFilter.param)
      }
      factQuery += ` ORDER BY score ASC LIMIT 8`
      const entityFacts = db.prepare(factQuery).all(...factParams)

      // Supplementary context (no bracket labels — the ONLY citeable tags are the
      // numbered [S#] SOURCES below, so the model can't invent uncited labels).
      const memoryLines = memories
        .slice(0, 6)
        .map(
          (m: any) =>
            `- (${m.source_app || 'Unknown'} | ${m.created_at}): ${clipText(m.content, 500)}`
        )
        .join('\n')

      const messageLines = messages
        .slice(0, 6)
        .map(
          (m: any) =>
            `- (${m.app_name || 'Unknown'} | ${m.title || 'Untitled'} | ${m.created_at}) ${m.role}: ${clipText(m.content, 400)}`
        )
        .join('\n')

      const summaryLines = summaries
        .slice(0, 6)
        .map(
          (s: any) =>
            `- (${s.app_name || 'Unknown'} | ${s.title || 'Untitled'}): ${clipText(s.summary, 600)}`
        )
        .join('\n')

      const entityLines = entities
        .slice(0, 6)
        .map((e: any) => `- (${e.type || 'Unknown'}) ${e.name}: ${clipText(e.summary || '', 400)}`)
        .join('\n')

      const factLines = entityFacts
        .slice(0, 6)
        .map((f: any) => `- (${f.type || 'Unknown'}) ${f.name}: ${clipText(f.fact, 400)}`)
        .join('\n')

      const contextBlock = `RELEVANT MEMORIES:\n${memoryLines || '(none)'}\n\nRELEVANT MESSAGES:\n${messageLines || '(none)'}\n\nRELEVANT SUMMARIES:\n${summaryLines || '(none)'}\n\nRELEVANT ENTITIES:\n${entityLines || '(none)'}\n\nRELEVANT ENTITY FACTS:\n${factLines || '(none)'}`

      // Unified search: fuse in the best-ranked hits across screens, meetings,
      // memories, entities and facts (hybrid FTS + vectors with RRF) — the same
      // engine as the search screen, so the chat gets the right context too.
      let unifiedBlock = ''
      let unifiedHits: {
        kind: string
        title: string
        snippet: string
        surface: string
        ts: number
        refId: number
        imagePath: string | null
      }[] = []
      try {
        const { universalSearch } = await import('./search')
        unifiedHits = await universalSearch(query, { limit: 12, semantic: true })
        if (unifiedHits.length) {
          unifiedBlock =
            '\n\nSOURCES — every factual claim must cite the source it came from using its tag in square brackets, e.g. [S2]. Cite ONLY sources you actually used; never invent a citation:\n' +
            unifiedHits
              .map((h, i) => {
                const when = h.ts ? ` · ${new Date(h.ts).toISOString().slice(0, 10)}` : ''
                return `[S${i + 1}] (${h.kind} · ${h.surface || 'unknown'}${when})${h.title ? ` ${h.title} —` : ''} ${clipText(h.snippet || '', 350)}`
              })
              .join('\n')
        }
      } catch (e) {
        console.error('[RAG] universalSearch failed', e)
      }

      // Build conversation history block if provided
      let historyBlock = ''
      if (conversationHistory && conversationHistory.length > 0) {
        const historyLines = conversationHistory
          .map(
            (msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${clipText(msg.content, 500)}`
          )
          .join('\n\n')
        historyBlock = `\nCONVERSATION HISTORY:\n${historyLines}\n`
      }

      let skillsBlock = 'None installed.'
      try {
        const { listSkills } = await import('./skills')
        const sk = listSkills()
        if (sk.length) skillsBlock = sk.map((s) => `- /${s.name}: ${s.description}`).join('\n')
      } catch {
        /* skills optional */
      }

      const prompt = getPrompt('ragChat', {
        HISTORY_BLOCK: historyBlock,
        QUERY: query,
        CONTEXT_BLOCK: contextBlock + unifiedBlock,
        SKILLS_BLOCK: skillsBlock
      })

      try {
        if (streamId)
          event.sender.send('rag:stream', {
            streamId,
            type: 'step',
            step: {
              kind: 'memory',
              counts: {
                memories: memories.length,
                messages: messages.length,
                summaries: summaries.length,
                entities: entities.length,
                facts: entityFacts.length,
                unified: unifiedHits.length
              }
            }
          })
        const completion = await streamAnswer(event, streamId, prompt, thinking, imgs)
        return {
          ...completion,
          context: {
            masterMemory: null,
            memories,
            messages,
            summaries,
            entities,
            entityFacts,
            unified: unifiedHits
          }
        }
      } catch (e) {
        console.error('[RAG] LLM chat failed:', e)
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
        }
      }
    }
  )

  ipcMain.handle('db:get-chat-sessions', (_, appName?: string) => {
    return getChatSessions(appName)
  })
  ipcMain.handle('db:get-memories-for-session', (_, sessionId: string) => {
    // Need to export this from database.ts first or import it
    return getMemoriesForSession(sessionId)
  })
  ipcMain.handle('db:get-entities', (_, appName?: string) => {
    return getEntities(appName)
  })
  ipcMain.handle('db:get-entity-details', (_, entityId: number, appName?: string) => {
    return getEntityDetails(entityId, appName)
  })
  ipcMain.handle('db:get-entities-for-session', (_, sessionId: string) => {
    return getEntitiesForSession(sessionId)
  })
  ipcMain.handle('db:get-memory-records-for-session', (_, sessionId: string) => {
    return getMemoryRecordsForSession(sessionId)
  })

  ipcMain.handle('db:delete-session', async (_, sessionId: string) => {
    const db = getDB()
    // Delete from new tables (messages will cascade due to foreign key)
    db.prepare('DELETE FROM conversations WHERE id = ?').run(sessionId)
    // Also delete from legacy tables for cleanup
    db.prepare('DELETE FROM memories WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM chat_summaries WHERE session_id = ?').run(sessionId)
    console.log(`Deleted session: ${sessionId}`)

    // Regenerate master memory after deletion
    await regenerateMasterMemory()

    return true
  })

  ipcMain.handle('llm:summarize-session', async (_, sessionId: string) => {
    return await summarizeSession(sessionId)
  })

  ipcMain.handle('db:get-master-memory', () => {
    return getMasterMemory()
  })

  ipcMain.handle('db:delete-entity', (_, entityId: number) => {
    const result = deleteEntityById(entityId)
    console.log(`[IPC] Deleted entity ${entityId}: ${result}`)
    return result
  })

  ipcMain.handle('db:delete-memory', (_, memoryId: number) => {
    const result = deleteMemory(memoryId)
    console.log(`[IPC] Deleted memory ${memoryId}: ${result}`)
    return result
  })

  ipcMain.handle('db:regenerate-master-memory', async () => {
    return await regenerateMasterMemory()
  })

  // User Profile handlers
  ipcMain.handle('db:get-user-profile', () => {
    return getUserProfile()
  })

  ipcMain.handle('db:save-user-profile', (_, profile: UserProfile) => {
    saveUserProfile(profile)
    console.log('[IPC] User profile saved:', profile)
    return true
  })

  // Permission handlers
  ipcMain.handle('permissions:request-accessibility', () => {
    return requestAccessibilityPermission()
  })

  ipcMain.handle('permissions:open-accessibility-settings', () => {
    openAccessibilitySettings()
    return true
  })

  ipcMain.handle('permissions:open-screen-recording-settings', () => {
    openScreenRecordingSettings()
    return true
  })

  ipcMain.handle('permissions:open-microphone-settings', () => {
    openMicrophoneSettings()
    return true
  })

  ipcMain.handle('permissions:open-local-network-settings', () => {
    openLocalNetworkSettings()
    return true
  })

  ipcMain.handle('permissions:request-screen-recording', async () => {
    return await requestScreenRecordingPermission()
  })

  ipcMain.handle('permissions:relaunch', () => {
    requestApplicationRelaunch(app)
    return true
  })

  // === RAG CONVERSATION HANDLERS ===

  ipcMain.handle(
    'rag:create-conversation',
    (_, id: string, title?: string, projectId?: string | null) => {
      return createRagConversation(id, title, projectId)
    }
  )

  ipcMain.handle('rag:get-conversations', (_, projectId?: string | null) => {
    return getRagConversations(projectId)
  })

  ipcMain.handle('rag:search-conversation-ids', (_, query: string) =>
    searchRagConversationIds(query)
  )

  ipcMain.handle(
    'rag:set-conversation-project',
    async (_, id: string, projectId: string | null) => {
      const { setRagConversationProject } = await import('./database')
      setRagConversationProject(id, projectId)
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('rag:conversations-changed', { conversationId: id, projectId })
      }
      return true
    }
  )

  ipcMain.handle('rag:get-conversation', (_, id: string) => {
    return getRagConversation(id)
  })

  ipcMain.handle('rag:get-messages', (_, conversationId: string) => {
    return getRagMessages(conversationId)
  })

  ipcMain.handle('rag:truncate-messages', async (_e, conversationId: string, keepCount: number) => {
    const { truncateRagMessages } = await import('./database')
    return truncateRagMessages(conversationId, keepCount)
  })
  ipcMain.handle(
    'rag:add-message',
    (_, conversationId: string, role: 'user' | 'assistant', content: string, context?: any) => {
      return addRagMessage(conversationId, role, content, context)
    }
  )

  ipcMain.handle('rag:update-conversation-title', (_, id: string, title: string) => {
    return updateRagConversationTitle(id, title)
  })

  ipcMain.handle('rag:delete-conversation', async (_, id: string) => {
    // Clean the conversation's generated artifacts too, so they don't orphan in
    // the library (D23) — same lifecycle tie deleteProject has for a project.
    const { deleteArtifactsForConversation } = await import('./artifacts')
    deleteArtifactsForConversation(id)
    return deleteRagConversation(id)
  })

  // === SETTINGS HANDLERS ===

  ipcMain.handle('settings:get', () => {
    return getSettings()
  })

  // App version (for the Settings footer — so users know what build they're on).
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('settings:save', (_, key: string, value: any) => {
    saveSetting(key, value)
    console.log(`[IPC] Setting saved: ${key} =`, value)
    return true
  })

  // Per-modality runtime residency (on-demand vs in-memory/resident). The full map
  // drives the queue's mode-aware re-warm and each engine's job path.
  ipcMain.handle('runtime:residency:get', () => getResidency())
  ipcMain.handle('runtime:residency:set', (_e, modality: Modality, mode: ResidencyMode) =>
    setResidencyMode(modality, mode)
  )
  // Unload one modality's model from memory now (the "free RAM" button). Goes through
  // the same evict() seam as residency/shutdown; the engine reloads on next use.
  ipcMain.handle('runtime:unload', async (_e, modality: Modality) => {
    const { unloadRuntime } = await import('./runtime-manager')
    const freed = await unloadRuntime(modality)
    console.log(`[runtime] unload ${modality}: ${freed ? 'freed' : 'nothing registered'}`)
    return freed
  })

  // Pipeline queue config — the user-facing controls for the shared scheduler.
  // Reads/writes go through modality-queue/config (single source for the keys) and
  // apply to the live queue immediately, so a toggle takes effect without a restart.
  ipcMain.handle('queue:config:get', async () => {
    const { readQueueConfig } = await import('./modality-queue/config')
    return readQueueConfig(getSetting)
  })
  ipcMain.handle(
    'queue:config:set',
    async (_e, patch: { enabled?: boolean; tier1Coexists?: boolean }) => {
      const { readQueueConfig, applyQueueConfig, QUEUE_ENABLED_KEY, TIER1_COEXIST_KEY } =
        await import('./modality-queue/config')
      const { modalityQueue } = await import('./modality-queue/queue')
      if (typeof patch.enabled === 'boolean') {
        saveSetting(QUEUE_ENABLED_KEY, patch.enabled)
      }
      if (typeof patch.tier1Coexists === 'boolean') {
        saveSetting(TIER1_COEXIST_KEY, patch.tier1Coexists)
      }
      const cfg = readQueueConfig(getSetting)
      applyQueueConfig(modalityQueue, cfg)
      return cfg
    }
  )
  // Live queue activity (running + queued jobs) for a status indicator.
  ipcMain.handle('queue:state', async () => {
    const { modalityQueue } = await import('./modality-queue/queue')
    return modalityQueue.getState()
  })

  // Fleet console IPC (console:*) is a pro feature — registered by pro's
  // activateMain, not here, so the open build doesn't ship it.

  // === PROMPT HANDLERS ===

  ipcMain.handle('prompts:get-all', () => {
    const defs = getAllPromptDefs()
    return defs.map((def) => ({
      ...def,
      currentTemplate:
        getPromptTemplate(def.key) !== def.defaultTemplate ? getPromptTemplate(def.key) : null
    }))
  })

  ipcMain.handle('prompts:save', (_, key: string, value: string) => {
    saveSetting(`prompt:${key}`, value)
    console.log(`[IPC] Prompt saved: ${key}`)
    return true
  })

  ipcMain.handle('prompts:reset', (_, key: string) => {
    resetPrompt(key)
    console.log(`[IPC] Prompt reset: ${key}`)
    return true
  })

  // === REPROCESS ALL SESSIONS ===

  ipcMain.handle('db:reprocess-all-sessions', async (_, clean: boolean = false) => {
    const db = getDB()
    const sessions = db.prepare('SELECT id FROM conversations').all() as { id: string }[]
    let processed = 0

    if (clean) {
      // Clean reprocess: delete all old data and rebuild from scratch
      console.log('[IPC] Clean reprocess: clearing all entities, facts, edges, and memories...')

      // Drop FTS AFTER DELETE triggers first — if the FTS index is out of sync
      // with the source tables, the delete triggers will error and silently
      // prevent rows from being deleted. We recreate them after.
      db.exec('DROP TRIGGER IF EXISTS memories_ad')
      db.exec('DROP TRIGGER IF EXISTS entities_ad')
      db.exec('DROP TRIGGER IF EXISTS entity_facts_ad')

      // Delete only strictness-dependent data (children first)
      // Conversations, messages, chat_summaries, and master_memory are NOT touched
      db.prepare('DELETE FROM entity_edges').run()
      db.prepare('DELETE FROM entity_facts').run()
      db.prepare('DELETE FROM entity_sessions').run()
      db.prepare('DELETE FROM entities').run()
      db.prepare('DELETE FROM memories').run()

      // Recreate the delete triggers
      db.exec(`CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
              INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.id, old.content);
          END;`)
      db.exec(`CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
              INSERT INTO entity_fts(entity_fts, rowid, name, summary, type) VALUES('delete', old.id, old.name, old.summary, old.type);
          END;`)
      db.exec(`CREATE TRIGGER IF NOT EXISTS entity_facts_ad AFTER DELETE ON entity_facts BEGIN
              INSERT INTO entity_fact_fts(entity_fact_fts, rowid, fact, entity_id) VALUES('delete', old.id, old.fact, old.entity_id);
          END;`)

      // Rebuild FTS indexes so they reflect the now-empty source tables
      try {
        db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')")
        db.exec("INSERT INTO entity_fts(entity_fts) VALUES('rebuild')")
        db.exec("INSERT INTO entity_fact_fts(entity_fact_fts) VALUES('rebuild')")
      } catch (e) {
        console.error('[IPC] FTS rebuild during clean reprocess failed (non-fatal):', e)
      }

      const deletedCounts = {
        entities: (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c,
        memories: (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c,
        facts: (db.prepare('SELECT COUNT(*) as c FROM entity_facts').get() as { c: number }).c
      }
      console.log('[IPC] Post-delete counts (should all be 0):', deletedCounts)

      // Notify frontend to refresh immediately after clearing
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('reprocess:progress', {
          phase: 'cleared',
          processed: 0,
          total: sessions.length
        })
      })

      for (const session of sessions) {
        try {
          // Re-evaluate memories for each message in the session
          const msgs = db
            .prepare(
              'SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
            )
            .all(session.id) as { id: number; role: string; content: string }[]
          const conv = db
            .prepare('SELECT app_name FROM conversations WHERE id = ?')
            .get(session.id) as { app_name: string } | undefined
          const appName = conv?.app_name || 'Unknown'

          for (const msg of msgs) {
            await evaluateAndStoreMemoryForMessage({
              sessionId: session.id,
              appName,
              role: msg.role,
              content: msg.content,
              messageId: msg.id
            })
          }

          // Re-extract entities from the newly created memories
          await extractEntitiesForSession(session.id)
          processed++

          // Send progress updates
          BrowserWindow.getAllWindows().forEach((win) => {
            win.webContents.send('reprocess:progress', {
              phase: 'processing',
              processed,
              total: sessions.length
            })
          })
        } catch (e) {
          console.error(`[IPC] Failed to reprocess session ${session.id}:`, e)
        }
      }

    } else {
      // Additive reprocess: keep existing data, just re-run entity extraction on top
      console.log(
        '[IPC] Additive reprocess: re-extracting entities with current settings (keeping existing data)...'
      )
      for (const session of sessions) {
        try {
          await extractEntitiesForSession(session.id)
          processed++
        } catch (e) {
          console.error(`[IPC] Failed to reprocess session ${session.id}:`, e)
        }
      }
    }

    console.log(
      `[IPC] Reprocessed ${processed} sessions (clean=${clean}) with current strictness settings`
    )
    return { processed, total: sessions.length }
  })

  // === MODEL DOWNLOAD HANDLERS ===

  ipcMain.handle('model:check-status', async () => {
    const { llm } = await import('./llm')
    return {
      downloaded: llm.modelsExist(),
      modelsDir: llm.getModelsDir()
    }
  })

  ipcMain.handle('model:download', async () => {
    const { llm } = await import('./llm')
    const modelsDir = llm.getModelsDir()
    const fs = await import('fs')
    const path = await import('path')
    const https = await import('https')

    // Ensure models directory exists
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true })
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
    ]

    const downloadFile = (url: string, destPath: string, modelName: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath)

        const request = (redirectUrl: string) => {
          https
            .get(redirectUrl, (response) => {
              if (
                response.statusCode &&
                response.statusCode >= 300 &&
                response.statusCode < 400 &&
                response.headers.location
              ) {
                request(response.headers.location)
                return
              }

              if (response.statusCode !== 200) {
                fs.unlink(destPath, () => {})
                reject(new Error(`HTTP ${response.statusCode}`))
                return
              }

              const totalSize = parseInt(response.headers['content-length'] || '0', 10)
              let downloaded = 0

              response.pipe(file)

              response.on('data', (chunk: Buffer) => {
                downloaded += chunk.length
                const percent = totalSize ? Math.round((downloaded / totalSize) * 100) : 0

                // Send progress to renderer
                BrowserWindow.getAllWindows().forEach((win) => {
                  win.webContents.send('model:download-progress', {
                    modelName,
                    percent,
                    downloadedMB: (downloaded / 1024 / 1024).toFixed(1),
                    totalMB: totalSize ? (totalSize / 1024 / 1024).toFixed(1) : '?'
                  })
                })
              })

              file.on('finish', () => {
                file.close()
                resolve()
              })
            })
            .on('error', (err) => {
              fs.unlink(destPath, () => {})
              reject(err)
            })
        }

        request(url)
      })
    }

    try {
      for (const model of models) {
        const destPath = path.join(modelsDir, model.name)

        if (fs.existsSync(destPath)) {
          console.log(`[Model] ${model.name} already exists, skipping`)
          continue
        }

        console.log(`[Model] Downloading ${model.name}...`)
        await downloadFile(model.url, destPath, model.name)
        console.log(`[Model] ${model.name} downloaded`)
      }

      return { success: true }
    } catch (err: any) {
      console.error('[Model] Download failed:', err)
      return { success: false, error: err.message }
    }
  })

  // === OFF GRID MODEL CATALOG (text, vision, image, voice, transcription) ===

  // Model management lives in ./models-manager (one source of truth, shared with
  // the headless gateway HTTP admin endpoints). These IPC handlers are thin
  // wrappers; the download one adds a renderer progress broadcast.
  ipcMain.handle('models:catalog', () => import('./models-manager').then((m) => m.getCatalog()))
  ipcMain.handle('models:vision-status', () =>
    import('./models-manager').then((m) => m.getVisionStatuses())
  )
  ipcMain.handle('models:installed', () =>
    import('./models-manager').then((m) => m.listInstalled())
  )
  ipcMain.handle('models:search', (_, query: string, kind?: string) =>
    import('./models-manager').then((m) => m.searchModels(query, kind))
  )

  ipcMain.handle('models:download', async (_, modelId: string) => {
    const { downloadModel } = await import('./models-manager')
    return downloadModel(modelId, (p) =>
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('model:download-progress', p))
    )
  })
  ipcMain.handle('models:cancel-download', (_evt, modelId: string) =>
    import('./models-manager').then((m) => m.cancelDownload(modelId))
  )
  ipcMain.handle('models:delete', (_, modelId: string) =>
    import('./models-manager').then((m) => m.deleteModel(modelId))
  )

  ipcMain.handle('models:set-active', (_, modelId: string) =>
    import('./models-manager').then((m) => m.setActiveModel(modelId))
  )
  // Single activation seam: route any model to the right backend by its kind.
  ipcMain.handle('models:activate', (_, modelId: string) =>
    import('./models-manager').then((m) => m.activateModel(modelId))
  )
  ipcMain.handle('models:get-active', () =>
    import('./models-manager').then((m) => m.getActiveModel())
  )
  // Active model ids across ALL modalities — the UI's single "what's active" source.
  ipcMain.handle('models:active-ids', () =>
    import('./models-manager').then((m) => m.getActiveModelIds())
  )
  ipcMain.handle('models:set-active-modal', (_, kind: string, modelId: string | null) =>
    import('./models-manager').then((m) => m.setActiveModalChoice(kind, modelId))
  )
  ipcMain.handle('models:active-modalities', () =>
    import('./models-manager').then((m) => m.getActiveModalities())
  )

  // Storage + download manager
  ipcMain.handle('models:storage', () => import('./models-manager').then((m) => m.getStorageInfo()))
  ipcMain.handle('models:delete-orphans', () =>
    import('./models-manager').then((m) => m.deleteOrphans())
  )
  ipcMain.handle('models:downloads', () =>
    import('./models-manager').then((m) => m.listDownloads())
  )
  ipcMain.handle('models:retry-download', async (_, modelId: string) => {
    const { retryDownload } = await import('./models-manager')
    return retryDownload(modelId, (p) =>
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('model:download-progress', p))
    )
  })
  ipcMain.handle('models:clear-download', (_, modelId: string) =>
    import('./models-manager').then((m) => m.clearDownload(modelId))
  )
  ipcMain.handle('models:clear-downloads', () =>
    import('./models-manager').then((m) => m.clearInactiveDownloads())
  )
  ipcMain.handle(CACHE_CLEANUP_CHANNEL, () =>
    import('./cache-cleanup').then((m) => m.clearEphemeralCache())
  )
  // Import a local .gguf from disk (file picker → validate → copy → register).
  ipcMain.handle('models:import', async () => {
    const { dialog } = await import('electron')
    const r = await dialog.showOpenDialog({
      title: 'Import a local model',
      properties: ['openFile'],
      filters: [{ name: 'GGUF model', extensions: ['gguf'] }]
    })
    if (r.canceled || !r.filePaths[0]) return { canceled: true }
    const { importLocalModel } = await import('./models-manager')
    return importLocalModel(r.filePaths[0], (p) =>
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('model:download-progress', p))
    )
  })

  // --- Setup + system health -----------------------------------------------
  // One aggregated snapshot of every local component (chat LLM, gateway, vision,
  // embeddings, STT, TTS, image gen) for the Settings → Health panel.
  // Preview what "Configure for me" would pick for a mode (no side effects).
  ipcMain.handle('setup:recommendation', (_e, mode?: string) =>
    import('./setup').then((m) =>
      m.getRecommendation(mode as 'conservative' | 'balanced' | 'extreme' | undefined)
    )
  )
  // Full setup plan (chat + STT + TTS + image) for a mode, so the UI can list every
  // model "Configure for me" will download before the user commits.
  ipcMain.handle('setup:plan', (_e, mode?: string) =>
    import('./setup').then((m) =>
      m.getSetupPlan(mode as 'conservative' | 'balanced' | 'extreme' | undefined)
    )
  )
  // Whether the active chat model can read images (gate image attachments on this).
  ipcMain.handle('model:chat-vision', () => import('./llm').then((m) => m.llm.hasVision()))
  // Reliable text→clipboard (the renderer's navigator.clipboard is flaky in Electron).
  ipcMain.handle('clipboard:write-text', (_e, text?: string) => {
    try {
      clipboard.writeText(String(text ?? ''))
      return true
    } catch {
      return false
    }
  })
  // "Configure for me": pick a RAM-appropriate model, download, activate, start,
  // verify. Streams progress back to all windows via 'setup:progress'.
  ipcMain.handle('setup:auto-configure', async () => {
    const { autoConfigure } = await import('./setup')
    return autoConfigure((p) =>
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('setup:progress', p))
    )
  })
  // Restart a component. We only ever stop OUR OWN processes — never SIGKILL an
  // arbitrary PID holding the port (that could kill an unrelated user app, and the
  // handler is renderer-reachable). llm.restart() tears down our llama-server with
  // a command-name guard; the gateway just stops + restarts our own server.
  ipcMain.handle('system:restart', async (_e, id: string) => {
    if (id === 'chat') {
      const { llm } = await import('./llm')
      await llm.restart() // safely stops our llama-server (guarded) and respawns
      return { success: true }
    }
    if (id === 'gateway') {
      const { startModelServer, stopModelServer } = await import('./model-server')
      try {
        stopModelServer()
      } catch {
        /* not running */
      }
      // re-listens; falls back to a free port if the preferred one is held. Async, so catch a
      // rejection on the promise rather than leaving it unhandled.
      startModelServer().catch((e) => console.error('[model-server] restart failed', e))
      return { success: true }
    }
    return { success: false, error: `cannot restart "${id}"` }
  })
  // Pre-activate RAM fit estimate (for a warning before loading a big model).
  ipcMain.handle('system:estimate-fit', (_e, modelId: string) =>
    import('./setup').then((m) => m.estimateModelFit(modelId))
  )

  // Open an https link in the user's default browser (e.g. a model's HF page).
  ipcMain.handle('app:open-external', async (_e, url: string) => {
    if (!/^https:\/\//.test(url)) return { success: false }
    const { shell } = await import('electron')
    await shell.openExternal(url)
    return { success: true }
  })

  // Data & privacy — see and delete on-device data from one place.
  ipcMain.handle('data:summary', () => import('./data-privacy').then((m) => m.getDataSummary()))
  ipcMain.handle('data:clear', (_e, id: string, olderThanDays?: number) =>
    import('./data-privacy').then((m) =>
      m.clearCategory(
        id as 'chats' | 'memories' | 'captures' | 'meetings' | 'images',
        olderThanDays
      )
    )
  )
  ipcMain.handle('data:delete-all', () => import('./data-privacy').then((m) => m.deleteAllData()))

  // --- Image generation (stable-diffusion.cpp) ----------------------------
  ipcMain.handle('imagegen:status', async () => {
    const { imageGenStatus } = await import('./imagegen')
    return imageGenStatus()
  })

  const imageJobPublisher = (
    snapshot: import('../shared/image-generation-contract').ImageGenerationJobContract
  ): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send('imagegen:job-state', snapshot)
      if (snapshot.progress) window.webContents.send('imagegen:progress', snapshot.progress)
    }
  }
  const imageConversationPublisher = (conversationId: string): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send('imagegen:conversation-updated', conversationId)
    }
  }
  const imageJobPublisherReady = import('./imagegen/job-service').then(
    ({ imageGenerationJobs }) => {
      imageGenerationJobs.onChange(imageJobPublisher)
      imageGenerationJobs.onConversationUpdated(imageConversationPublisher)
      return imageGenerationJobs
    }
  )

  ipcMain.handle('imagegen:job-status', async () => {
    const imageGenerationJobs = await imageJobPublisherReady
    return imageGenerationJobs.status()
  })

  ipcMain.handle(
    'imagegen:generate',
    async (
      _e,
      params: import('./imagegen').ImageGenParams & {
        conversationId?: string
        projectId?: string | null
      }
    ) => {
      const imageGenerationJobs = await imageJobPublisherReady
      return imageGenerationJobs.start(params)
    }
  )

  ipcMain.handle('imagegen:cancel', async () => {
    const imageGenerationJobs = await imageJobPublisherReady
    return imageGenerationJobs.cancel()
  })

  ipcMain.handle(
    'imagegen:conversation-persisted',
    async (_event, conversationId: string, messageId?: string) => {
      const imageGenerationJobs = await imageJobPublisherReady
      return imageGenerationJobs.acknowledgeConversation(conversationId, messageId)
    }
  )

  ipcMain.handle(
    'imagegen:list',
    async (_e, scope?: { conversationId?: string; projectId?: string | null }) => {
      const { listGeneratedImages } = await import('./imagegen')
      return listGeneratedImages(scope)
    }
  )

  ipcMain.handle('imagegen:style-thumbs', async () => {
    const { listStyleThumbs } = await import('./imagegen')
    return listStyleThumbs()
  })
  ipcMain.handle('imagegen:make-style-thumb', async (_e, key: string, prompt: string) => {
    const { generateStyleThumb } = await import('./imagegen')
    return generateStyleThumb(key, prompt)
  })
  ipcMain.handle('imagegen:list-loras', async () => {
    const { listLoras } = await import('./imagegen')
    return listLoras()
  })
  ipcMain.handle('imagegen:reveal-loras', async () => {
    const { ensureLoraDir } = await import('./imagegen')
    const { shell } = await import('electron')
    const dir = ensureLoraDir()
    await shell.openPath(dir)
    return dir
  })
  ipcMain.handle('imagegen:download-lora', async (e, url: string, filename: string) => {
    const { downloadLora } = await import('./imagegen')
    return downloadLora(url, filename, (pct) => {
      try {
        e.sender.send('imagegen:lora-progress', { filename, pct })
      } catch {
        /* window gone */
      }
    })
  })

  ipcMain.handle('imagegen:delete', async (_e, p: string) => {
    const { deleteGeneratedImage } = await import('./imagegen')
    return deleteGeneratedImage(p)
  })

  ipcMain.handle('imagegen:export', async (e, srcPath: string, suggestedName?: string) => {
    const { dialog } = await import('electron')
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showSaveDialog(win!, {
      title: 'Save image',
      defaultPath: suggestedName || 'off-grid-image.png',
      filters: [{ name: 'PNG', extensions: ['png'] }]
    })
    if (res.canceled || !res.filePath) return false
    const { exportGeneratedImage } = await import('./imagegen')
    await exportGeneratedImage(srcPath, res.filePath)
    return true
  })

  // --- Agentic tool-calling (isolated, opt-in) ----------------------------
  ipcMain.handle('tools:list', async () => {
    const { listTools } = await import('./tools')
    return listTools()
  })
  ipcMain.handle('tools:set-enabled', async (_e, name: string, enabled: boolean) => {
    const { setToolEnabled } = await import('./tools')
    setToolEnabled(name, enabled)
  })
  ipcMain.handle(
    'tools:chat',
    async (
      event,
      query: string,
      history?: { role: string; content: string }[],
      opts?: {
        connectors?: boolean
        conversationId?: string
        projectId?: string
        allMemory?: boolean
        images?: string[]
        imageAvailable?: boolean
        streamId?: string
        thinking?: boolean
      }
    ) => {
      const { toolChat } = await import('./tools')
      const { modalityQueue, CHAT_JOB } = await import('./modality-queue/queue')
      const streamId = opts?.streamId
      const sender = event.sender
      // Non-stream fallback (no streamId): buffer, no live deltas (matches streamAnswer).
      if (!streamId) {
        return modalityQueue.run(CHAT_JOB, () => toolChat(query, history || [], opts || {}))
      }
      // Streaming: same channel/queue/abort as streamAnswer, so a tools turn streams
      // thinking -> tool-call activity -> answer, and the stop button (rag:cancel) aborts it.
      const controller = new AbortController()
      streamControllers.set(streamId, controller)
      bindChatStream(streamId, opts?.conversationId)
      try {
        return await modalityQueue.run(CHAT_JOB, () =>
          toolChat(query, history || [], {
            ...opts,
            thinking: opts.thinking,
            signal: controller.signal,
            onDelta: (text, kind) => {
              noteChatStreamDelta(streamId, text, kind)
              try {
                sender.send('rag:stream', { streamId, type: kind, text })
              } catch {
                /* window gone */
              }
            },
            onStep: (call) => {
              try {
                sender.send('rag:stream', {
                  streamId,
                  type: 'step',
                  step: { kind: 'running_tool', name: call.name }
                })
              } catch {
                /* window gone */
              }
            },
            onToolResult: (call) => {
              try {
                sender.send('rag:stream', { streamId, type: 'tool_result', call })
              } catch {
                /* window gone */
              }
            }
          })
        )
      } finally {
        streamControllers.delete(streamId)
        endChatStream(streamId)
      }
    }
  )

  // --- LLM inference settings (temperature, context window) ---------------
  ipcMain.handle('llm:get-settings', async () => {
    const { llm } = await import('./llm')
    return llm.getSettings()
  })
  ipcMain.handle('llm:set-settings', async (_e, s: import('./llm').LlmSettings) => {
    const { llm } = await import('./llm')
    await llm.setSettings(s)
    return llm.getSettings()
  })
  // Cleanly unload the chat engine so it stops holding the model port (frees it for LM Studio /
  // another tool without force-quitting the app). Returns whether the port was actually freed.
  ipcMain.handle('llm:unload', async () => {
    const { llm } = await import('./llm')
    return llm.unload()
  })

  // --- Canvas / artifacts sandbox runtime ---------------------------------
  ipcMain.handle('artifacts:runtime', async (_e, kind: import('./artifacts').ArtifactKind) => {
    const { artifactRuntime } = await import('./artifacts')
    return artifactRuntime(kind)
  })
  setupArtifactPreviewIpc()
  ipcMain.handle(
    'artifacts:save',
    async (
      _e,
      a: {
        kind: import('./artifacts').ArtifactKind
        code: string
        title?: string
        conversationId?: string
        projectId?: string | null
      }
    ) => {
      const { saveArtifact } = await import('./artifacts')
      return saveArtifact(a)
    }
  )
  ipcMain.handle(
    'artifacts:list',
    async (_e, scope?: { conversationId?: string; projectId?: string | null }) => {
      const { listArtifacts } = await import('./artifacts')
      return listArtifacts(scope)
    }
  )
  ipcMain.handle('artifacts:delete', async (_e, id: string) => {
    const { deleteArtifact } = await import('./artifacts')
    return deleteArtifact(id)
  })

  // --- File attachments: any file -> text (read / parse / caption / transcribe) ---
  ipcMain.handle('files:process', async (_e, bytes: ArrayBuffer | Uint8Array, name: string) => {
    const { processUpload } = await import('./files')
    return processUpload(name, bytes)
  })
  // An on-disk uploaded file as a data URL, so the chat viewer can render a PDF
  // natively (Chromium's built-in viewer) instead of dumping parsed text.
  ipcMain.handle('files:data-url', async (_e, p?: string) => {
    try {
      const fs = await import('fs')
      const path = await import('path')
      const { app } = await import('electron')
      // Only ever serve files inside the app's uploads dir — this handler is
      // renderer-reachable, so reading an arbitrary path would be a file-read /
      // exfiltration primitive. Resolve + boundary-check before touching disk.
      const root = path.resolve(app.getPath('userData'), 'uploads')
      const resolved = path.resolve(p ?? '')
      if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
      const buf = await fs.promises.readFile(resolved)
      const ext = (resolved.split('.').pop() || '').toLowerCase()
      const mime =
        ext === 'pdf'
          ? 'application/pdf'
          : ext === 'png'
            ? 'image/png'
            : /^jpe?g$/.test(ext)
              ? 'image/jpeg'
              : 'application/octet-stream'
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })

  // --- Skills (.skills folder, invoked from chat with /skill-name) ---
  ipcMain.handle('skills:list', async () => {
    const { listSkills } = await import('./skills')
    return listSkills()
  })
  ipcMain.handle('skills:get', async (_e, name: string) => {
    const { getSkill } = await import('./skills')
    return getSkill(name)
  })
  ipcMain.handle('skills:save', async (_e, input: import('./skills').SkillSaveInput) => {
    const { saveSkill } = await import('./skills')
    return saveSkill(input)
  })
  ipcMain.handle('skills:delete', async (_e, name: string) => {
    const { deleteSkill } = await import('./skills')
    return deleteSkill(name)
  })
  ipcMain.handle('skills:dir', async () => {
    const { skillsDir } = await import('./skills')
    return skillsDir()
  })

  // Which STT engine + model would run right now (provenance) + the installed transcription
  // models a picker can switch to (via the existing models:set-active-modal — this only lists).
  ipcMain.handle('transcription:active-info', async () => {
    const { getActiveTranscriptionInfo, transcriptionModelOptions } =
      await import('./transcription/select')
    const { listInstalled } = await import('./models-manager')
    const { modelsByKind } = await import('@offgrid/models')
    const info = getActiveTranscriptionInfo()
    const installedIds = new Set(await listInstalled())
    const installed = (
      modelsByKind('transcription') as Array<{
        id: string
        name?: string
        files: Array<{ name: string }>
      }>
    ).filter((entry) => installedIds.has(entry.id))
    return { ...info, options: transcriptionModelOptions(info.modelId, installed) }
  })

  // --- Voice input (STT via the active engine: whisper default / Parakeet opt-in) ---
  ipcMain.handle('voice:transcribe', async (_e, audio: ArrayBuffer | Uint8Array, ext = 'webm') => {
    const fs = await import('fs')
    const path = await import('path')
    const os = await import('os')
    // Route through the active-model-implied engine so a Parakeet selection is honored
    // (falls back to whisper when Parakeet isn't installed).
    const { getActiveTranscription } = await import('./transcription/select')
    const transcriptionService = getActiveTranscription()
    // Respect a Uint8Array's view bounds (byteOffset/length) — Buffer.from on the
    // backing ArrayBuffer would copy the WHOLE buffer, corrupting a sliced view.
    const buf = ArrayBuffer.isView(audio)
      ? Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
      : Buffer.from(audio as ArrayBuffer)
    // ext is renderer-controlled — strip anything but alphanumerics so it can't
    // contain path separators / traversal sequences in the temp filename.
    const safeExt = (ext || 'webm').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'webm'
    const tmp = path.join(os.tmpdir(), `offgrid-mic-${Date.now()}.${safeExt}`)
    await fs.promises.writeFile(tmp, buf)
    try {
      return (await transcriptionService.transcribe({ path: tmp })).text
    } finally {
      fs.promises.unlink(tmp).catch(() => {})
    }
  })

  /**
   * Keep the image a generation will be based on, and give it a name the mesh can use.
   *
   * The user picks an init image from their own disk. Referring to it there is not enough for two
   * reasons: the file can move or be deleted the moment the turn ends, and its path means nothing on
   * any other device. So it is copied into the app's own storage and given a uuid, which is what lets
   * it travel as an ordinary attachment on the message that used it.
   */
  ipcMain.handle('imagegen:keep-init-image', async (_e, sourcePath: string) => {
    const { preserveGeneratedImageSource } = await import('./imagegen')
    const id = crypto.randomUUID()
    const kept = preserveGeneratedImageSource(id, sourcePath)
    return kept ? { id, path: kept } : null
  })

  ipcMain.handle('imagegen:pick-image', async (e) => {
    const { dialog } = await import('electron')
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose an init image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })
}
