// Platform bridges (DI boundaries) for the RAG engine. The engine is pure TS;
// each app injects implementations: desktop wires MiniLM embeddings + a
// better-sqlite3 store + Node/native extractors; mobile wires llama.rn + op-sqlite
// + RNFS/PDFKit. This keeps the chunking/retrieval/orchestration logic shared.

import type { MediaKind, RagDocument } from './types'

/** Turns text into an embedding vector. Same model must be used for index + query. */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
  /** Optional batch path; the service falls back to mapped embed() if absent. */
  embedBatch?(texts: string[]): Promise<number[][]>
  /** Embedding dimension (e.g. 384 for all-MiniLM-L6-v2). */
  readonly dimension: number
}

/** A stored chunk with its embedding, returned as a retrieval candidate. */
export interface ChunkCandidate {
  docId: number
  name: string
  content: string
  position: number
  embedding: number[]
}

/**
 * Persists documents/chunks/embeddings and lists retrieval candidates for a
 * project. Implementations may union uploaded-document chunks with other
 * sources (e.g. desktop folds in captured-memory embeddings) — the engine just
 * ranks whatever candidates are returned.
 */
export interface VectorStore {
  addDocument(doc: {
    syncId?: string
    projectId: string
    name: string
    path: string
    size: number
    kind: MediaKind
    createdAt?: string
    enabled?: boolean
  }): Promise<number>
  addChunks(
    docId: number,
    chunks: { content: string; position: number }[],
    embeddings: number[][]
  ): Promise<void>
  /** Enabled chunks (and any extra sources) eligible for retrieval in a project. */
  getChunkCandidates(projectId: string): Promise<ChunkCandidate[]>
  listDocuments(projectId: string): Promise<RagDocument[]>
  setDocumentEnabled(docId: number, enabled: boolean): Promise<void>
  deleteDocument(docId: number): Promise<void>
}

/**
 * Content extraction bridges — turn a file into plain text. Text/PDF/DOCX are
 * read/parsed directly; audio is transcribed (whisper); video is sampled into
 * frames that a vision model captions. Optional methods throw a clear error in
 * the engine when a file needs an unavailable capability (e.g. no vision model).
 */
export interface ExtractionBridges {
  readText(path: string): Promise<string>
  extractPdf?(path: string, maxChars?: number): Promise<string>
  extractDocx?(path: string, maxChars?: number): Promise<string>
  /** Transcribe an audio file to text (uses a downloaded transcription model). */
  transcribeAudio?(path: string): Promise<string>
  /** Sample frames from a video; returns image paths (or data URIs) to caption. */
  sampleVideoFrames?(
    path: string,
    opts: { everySeconds?: number; maxFrames?: number }
  ): Promise<string[]>
  /** Describe/OCR a single image (uses a downloaded vision model). */
  captionImage?(imagePath: string): Promise<string>
}
