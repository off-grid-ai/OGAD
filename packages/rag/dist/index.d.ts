/** What a knowledge-base file is, which decides how its text is extracted. */
type MediaKind = 'text' | 'pdf' | 'docx' | 'audio' | 'video' | 'image';
/** A workspace: a named container scoping chat threads + a knowledge base. */
interface Project {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    icon?: string;
    createdAt: string;
    updatedAt: string;
}
/** A file added to a project's knowledge base. */
interface RagDocument {
    id: number;
    /** Stable RFC 4122 identity used across devices. The integer id remains local-only. */
    syncId: string;
    projectId: string;
    name: string;
    path: string;
    size: number;
    kind: MediaKind;
    createdAt: string;
    enabled: boolean;
}
/** One ranked excerpt returned from retrieval. */
interface RagSearchResult {
    docId: number;
    name: string;
    content: string;
    position: number;
    score: number;
}
/** The result of a knowledge-base query: ranked excerpts for `query`. */
interface SearchResult {
    chunks: RagSearchResult[];
    query: string;
}

interface ChunkOptions {
    /** Target chunk size in characters (default 500). */
    chunkSize?: number;
    /** Sliding-window overlap for oversized paragraphs (default 100). */
    overlap?: number;
    /** Drop chunks shorter than this (default 20). */
    minChunkLength?: number;
}
interface Chunk {
    content: string;
    position: number;
}
declare function chunkText(text: string, opts?: ChunkOptions): Chunk[];

declare function dotProduct(a: number[], b: number[]): number;
declare function cosineSimilarity(a: number[], b: number[]): number;
interface SimilarityResult {
    index: number;
    score: number;
}
/** Top-k most similar candidate vectors to `query`, score-descending. */
declare function topKSimilar(query: number[], candidates: number[][], k: number): SimilarityResult[];

/** Turns text into an embedding vector. Same model must be used for index + query. */
interface EmbeddingProvider {
    embed(text: string): Promise<number[]>;
    /** Optional batch path; the service falls back to mapped embed() if absent. */
    embedBatch?(texts: string[]): Promise<number[][]>;
    /** Embedding dimension (e.g. 384 for all-MiniLM-L6-v2). */
    readonly dimension: number;
}
/** A stored chunk with its embedding, returned as a retrieval candidate. */
interface ChunkCandidate {
    docId: number;
    name: string;
    content: string;
    position: number;
    embedding: number[];
}
/**
 * Persists documents/chunks/embeddings and lists retrieval candidates for a
 * project. Implementations may union uploaded-document chunks with other
 * sources (e.g. desktop folds in captured-memory embeddings) — the engine just
 * ranks whatever candidates are returned.
 */
interface VectorStore {
    addDocument(doc: {
        syncId?: string;
        projectId: string;
        name: string;
        path: string;
        size: number;
        kind: MediaKind;
        createdAt?: string;
        enabled?: boolean;
    }): Promise<number>;
    addChunks(docId: number, chunks: {
        content: string;
        position: number;
    }[], embeddings: number[][]): Promise<void>;
    /** Enabled chunks (and any extra sources) eligible for retrieval in a project. */
    getChunkCandidates(projectId: string): Promise<ChunkCandidate[]>;
    listDocuments(projectId: string): Promise<RagDocument[]>;
    setDocumentEnabled(docId: number, enabled: boolean): Promise<void>;
    deleteDocument(docId: number): Promise<void>;
}
/**
 * Content extraction bridges — turn a file into plain text. Text/PDF/DOCX are
 * read/parsed directly; audio is transcribed (whisper); video is sampled into
 * frames that a vision model captions. Optional methods throw a clear error in
 * the engine when a file needs an unavailable capability (e.g. no vision model).
 */
interface ExtractionBridges {
    readText(path: string): Promise<string>;
    extractPdf?(path: string, maxChars?: number): Promise<string>;
    extractDocx?(path: string, maxChars?: number): Promise<string>;
    /** Transcribe an audio file to text (uses a downloaded transcription model). */
    transcribeAudio?(path: string): Promise<string>;
    /** Sample frames from a video; returns image paths (or data URIs) to caption. */
    sampleVideoFrames?(path: string, opts: {
        everySeconds?: number;
        maxFrames?: number;
    }): Promise<string[]>;
    /** Describe/OCR a single image (uses a downloaded vision model). */
    captionImage?(imagePath: string): Promise<string>;
}

/** Score every candidate by cosine similarity and return the top-k, desc. */
declare function rankBySimilarity(queryVec: number[], candidates: ChunkCandidate[], topK?: number): RagSearchResult[];
/** Characters of context to spend on retrieved KB excerpts for a given window.
 *  ~4 chars/token, reserve ~40% of the window for the knowledge base. */
declare function estimateCharBudget(contextLengthTokens: number): number;
/** Greedily keep top chunks until the character budget is exhausted. */
declare function selectWithinBudget(chunks: RagSearchResult[], charBudget: number): RagSearchResult[];
/** Wrap retrieved excerpts in a tagged block for the system/user prompt. */
declare function formatForPrompt(result: {
    chunks: RagSearchResult[];
}): string;

declare function extensionOf(fileName: string): string;
/** Classify a file by extension into a MediaKind. */
declare function detectKind(fileName: string): MediaKind;
interface ExtractOptions {
    /** Hard cap on extracted characters (default 500_000). */
    maxChars?: number;
    /** Video: sample one frame every N seconds (default 5). */
    videoEverySeconds?: number;
    /** Video: cap total sampled frames (default 24). */
    videoMaxFrames?: number;
}
interface ExtractedContent {
    text: string;
    kind: MediaKind;
}
/** Extract plain text from a file, routing by kind through the given bridges. */
declare function extractContent(path: string, fileName: string, bridges: ExtractionBridges, opts?: ExtractOptions): Promise<ExtractedContent>;

type IndexStage = 'extracting' | 'chunking' | 'embedding' | 'indexing' | 'done';
interface RagServiceDeps {
    store: VectorStore;
    embeddings: EmbeddingProvider;
    extraction: ExtractionBridges;
    chunkOptions?: ChunkOptions;
}
interface IndexResult {
    docId: number;
    chunkCount: number;
    kind: RagDocument['kind'];
}
interface IndexDocumentParams {
    projectId: string;
    path: string;
    fileName: string;
    size: number;
    extract?: ExtractOptions;
    syncId?: string;
    createdAt?: string;
    enabled?: boolean;
}
declare class RagService {
    private readonly deps;
    constructor(deps: RagServiceDeps);
    /** Ingest a file into a project's knowledge base. */
    indexDocument(params: IndexDocumentParams, onProgress?: (stage: IndexStage) => void): Promise<IndexResult>;
    /** Retrieve the most relevant excerpts for a query within a project. */
    searchProject(projectId: string, query: string, opts?: {
        topK?: number;
        contextLength?: number;
    }): Promise<SearchResult>;
    /** Build a prompt-ready block from a search result. */
    formatForPrompt(result: SearchResult): string;
    listDocuments(projectId: string): Promise<RagDocument[]>;
    toggleDocument(docId: number, enabled: boolean): Promise<void>;
    deleteDocument(docId: number): Promise<void>;
}

declare const SEARCH_KB_TOOL: {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                query: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
};
/** Build a tool handler bound to a searcher. Returns a model-ready string. */
declare function makeSearchKnowledgeBaseHandler(searcher: {
    searchProject(projectId: string, query: string): Promise<SearchResult>;
}): (args: {
    query: string;
}, projectId?: string) => Promise<string>;

export { type Chunk, type ChunkCandidate, type ChunkOptions, type EmbeddingProvider, type ExtractOptions, type ExtractedContent, type ExtractionBridges, type IndexDocumentParams, type IndexResult, type IndexStage, type MediaKind, type Project, type RagDocument, type RagSearchResult, RagService, type RagServiceDeps, SEARCH_KB_TOOL, type SearchResult, type SimilarityResult, type VectorStore, chunkText, cosineSimilarity, detectKind, dotProduct, estimateCharBudget, extensionOf, extractContent, formatForPrompt, makeSearchKnowledgeBaseHandler, rankBySimilarity, selectWithinBudget, topKSimilar };
