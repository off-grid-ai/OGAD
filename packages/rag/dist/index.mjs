// src/chunking.ts
function chunkText(text, opts = {}) {
  const chunkSize = opts.chunkSize ?? 500;
  const overlap = opts.overlap ?? 100;
  const minChunkLength = opts.minChunkLength ?? 20;
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buffer = "";
  const flush = () => {
    const t = buffer.trim();
    if (t.length >= minChunkLength) chunks.push(t);
    buffer = "";
  };
  for (const para of paragraphs) {
    if (para.length > chunkSize) {
      flush();
      const step = Math.max(1, chunkSize - overlap);
      for (let start = 0; start < para.length; start += step) {
        const slice = para.slice(start, start + chunkSize).trim();
        if (slice.length >= minChunkLength) chunks.push(slice);
        if (start + chunkSize >= para.length) break;
      }
    } else if (buffer && buffer.length + 2 + para.length > chunkSize) {
      flush();
      buffer = para;
    } else {
      buffer = buffer ? `${buffer}

${para}` : para;
    }
  }
  flush();
  if (chunks.length === 0) {
    return [{ content: clean, position: 0 }];
  }
  return chunks.map((content, position) => ({ content, position }));
}

// src/vectorMath.ts
function dotProduct(a, b) {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
function topKSimilar(query, candidates, k) {
  return candidates.map((c, index) => ({ index, score: cosineSimilarity(query, c) })).sort((a, b) => b.score - a.score).slice(0, k);
}

// src/retrieval.ts
function rankBySimilarity(queryVec, candidates, topK = 5) {
  return candidates.map((c) => ({
    docId: c.docId,
    name: c.name,
    content: c.content,
    position: c.position,
    score: cosineSimilarity(queryVec, c.embedding)
  })).sort((a, b) => b.score - a.score).slice(0, topK);
}
function estimateCharBudget(contextLengthTokens) {
  return Math.max(1e3, Math.floor(contextLengthTokens * 4 * 0.4));
}
function selectWithinBudget(chunks, charBudget) {
  const out = [];
  let total = 0;
  for (const c of chunks) {
    if (out.length > 0 && total + c.content.length > charBudget) break;
    out.push(c);
    total += c.content.length;
  }
  return out;
}
function formatForPrompt(result) {
  if (!result.chunks.length) return "";
  const body = result.chunks.map((c) => `[Source: ${c.name} (part ${c.position + 1})]
${c.content}`).join("\n---\n");
  return `<knowledge_base>
The following excerpts are from the user's project knowledge base. Use them to answer and cite the source filename when you do.
${body}
</knowledge_base>`;
}

// src/extract.ts
var AUDIO_EXT = /* @__PURE__ */ new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma"]);
var VIDEO_EXT = /* @__PURE__ */ new Set(["mp4", "mov", "mkv", "avi", "webm", "m4v", "mpg", "mpeg"]);
var IMAGE_EXT = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic"]);
function extensionOf(fileName) {
  return (fileName.split(".").pop() ?? "").toLowerCase();
}
function detectKind(fileName) {
  const ext = extensionOf(fileName);
  if (ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "doc") return "docx";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  return "text";
}
async function extractContent(path, fileName, bridges, opts = {}) {
  const kind = detectKind(fileName);
  const maxChars = opts.maxChars ?? 5e5;
  let text = "";
  switch (kind) {
    case "pdf":
      if (!bridges.extractPdf) throw new Error("PDF extraction is not available on this platform.");
      text = await bridges.extractPdf(path, maxChars);
      break;
    case "docx":
      if (!bridges.extractDocx)
        throw new Error("DOCX extraction is not available on this platform.");
      text = await bridges.extractDocx(path, maxChars);
      break;
    case "audio":
      if (!bridges.transcribeAudio)
        throw new Error("Audio ingestion needs a transcription model \u2014 download one from Models.");
      text = await bridges.transcribeAudio(path);
      break;
    case "video": {
      if (!bridges.sampleVideoFrames || !bridges.captionImage)
        throw new Error("Video ingestion needs a vision model \u2014 download one from Models.");
      const frames = await bridges.sampleVideoFrames(path, {
        everySeconds: opts.videoEverySeconds ?? 5,
        maxFrames: opts.videoMaxFrames ?? 24
      });
      const captions = [];
      for (let i = 0; i < frames.length; i++) {
        const c = (await bridges.captionImage(frames[i]))?.trim();
        if (c) captions.push(`[frame ${i + 1}] ${c}`);
      }
      text = captions.join("\n");
      break;
    }
    case "image":
      if (!bridges.captionImage)
        throw new Error("Image ingestion needs a vision model \u2014 download one from Models.");
      text = await bridges.captionImage(path);
      break;
    default:
      text = await bridges.readText(path);
  }
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, kind };
}

// src/service.ts
var RagService = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  /** Ingest a file into a project's knowledge base. */
  async indexDocument(params, onProgress) {
    onProgress?.("extracting");
    const { text, kind } = await extractContent(
      params.path,
      params.fileName,
      this.deps.extraction,
      params.extract
    );
    onProgress?.("chunking");
    const chunks = chunkText(text, this.deps.chunkOptions);
    const docId = await this.deps.store.addDocument({
      syncId: params.syncId,
      projectId: params.projectId,
      name: params.fileName,
      path: params.path,
      size: params.size,
      kind,
      createdAt: params.createdAt,
      enabled: params.enabled
    });
    if (chunks.length === 0) {
      onProgress?.("done");
      return { docId, chunkCount: 0, kind };
    }
    try {
      onProgress?.("embedding");
      const texts = chunks.map((c) => c.content);
      const embeddings = this.deps.embeddings.embedBatch ? await this.deps.embeddings.embedBatch(texts) : await Promise.all(texts.map((t) => this.deps.embeddings.embed(t)));
      onProgress?.("indexing");
      await this.deps.store.addChunks(docId, chunks, embeddings);
    } catch (error) {
      try {
        await this.deps.store.deleteDocument(docId);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Document indexing failed and document ${docId} could not be rolled back`
        );
      }
      throw error;
    }
    onProgress?.("done");
    return { docId, chunkCount: chunks.length, kind };
  }
  /** Retrieve the most relevant excerpts for a query within a project. */
  async searchProject(projectId, query, opts = {}) {
    const candidates = await this.deps.store.getChunkCandidates(projectId);
    if (candidates.length === 0) return { chunks: [], query };
    const queryVec = await this.deps.embeddings.embed(query);
    let ranked = rankBySimilarity(queryVec, candidates, opts.topK ?? 5);
    if (opts.contextLength) {
      ranked = selectWithinBudget(ranked, estimateCharBudget(opts.contextLength));
    }
    return { chunks: ranked, query };
  }
  /** Build a prompt-ready block from a search result. */
  formatForPrompt(result) {
    return formatForPrompt(result);
  }
  listDocuments(projectId) {
    return this.deps.store.listDocuments(projectId);
  }
  toggleDocument(docId, enabled) {
    return this.deps.store.setDocumentEnabled(docId, enabled);
  }
  deleteDocument(docId) {
    return this.deps.store.deleteDocument(docId);
  }
};

// src/tools.ts
var SEARCH_KB_TOOL = {
  type: "function",
  function: {
    name: "search_knowledge_base",
    description: "Search the current project's knowledge base (uploaded documents plus captured memory) for information relevant to the user's question.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up in the knowledge base." }
      },
      required: ["query"]
    }
  }
};
function makeSearchKnowledgeBaseHandler(searcher) {
  return async (args, projectId) => {
    if (!projectId) return "No active project. The knowledge base requires an open project.";
    const result = await searcher.searchProject(projectId, args.query);
    if (!result.chunks.length) return `No knowledge-base results found for "${args.query}".`;
    return result.chunks.map((c, i) => `[${i + 1}] ${c.name} (part ${c.position + 1}):
${c.content}`).join("\n\n---\n\n");
  };
}
export {
  RagService,
  SEARCH_KB_TOOL,
  chunkText,
  cosineSimilarity,
  detectKind,
  dotProduct,
  estimateCharBudget,
  extensionOf,
  extractContent,
  formatForPrompt,
  makeSearchKnowledgeBaseHandler,
  rankBySimilarity,
  selectWithinBudget,
  topKSimilar
};
