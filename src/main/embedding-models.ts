// The embedding and reranking models, as data. Kept apart from embeddings-core so main-process
// modules can name a model without loading @huggingface/transformers and ONNX Runtime: inference
// runs in the helper process (embeddings-worker), never beside the window.

/** A sentence embedder and the prefixes its training expects on questions and passages. */
export interface EmbedderSpec {
  model: string
  queryPrefix: string
  passagePrefix: string
}

const EMBEDDERS = {
  /** English. Measured 3.3 ms a passage fp32 on CPU here; q8 was slower (30.6 ms). */
  miniLM: { model: 'Xenova/all-MiniLM-L6-v2', queryPrefix: '', passagePrefix: '' },
  /** Hindi and English in one space (a Hindi question finds the English passage). 7.9 ms a passage
   *  fp32; a ~470 MB download against MiniLM's ~90 MB. Trained with these prefixes. */
  multilingualE5Small: {
    model: 'Xenova/multilingual-e5-small',
    queryPrefix: 'query: ',
    passagePrefix: 'passage: '
  }
} as const satisfies Record<string, EmbedderSpec>

/** The model behind embeddings that have no corpus of their own (/v1/embeddings, MCP, tool routing). */
export const DEFAULT_EMBEDDER: EmbedderSpec = EMBEDDERS.miniLM

/**
 * The model memory search embeds records and questions with. Changing it is this one line: each
 * stored vector records its model, so every record is embedded again with the new one.
 */
export const RECORD_EMBEDDER: EmbedderSpec = EMBEDDERS.multilingualE5Small

/**
 * Models for documents (chat attachments, knowledge bases, transcripts): the same multilingual
 * embedder as memory search, so one model is loaded and a Hindi question finds an English passage.
 * fp32 is 7.9 ms a passage on CPU here (the ~1.7 s once measured was its q8 build). Documents
 * indexed with MiniLM re-embed on their next use: the ingest compares each document's embedder. Indian-language documents still match by
 * keyword (FTS5 keeps their words whole). ms-marco-MiniLM-L-6-v2 is the cross-encoder AnythingLLM's
 * native reranker uses.
 */
export const DOCUMENT_EMBEDDER_SPEC: EmbedderSpec = EMBEDDERS.multilingualE5Small
export const DOCUMENT_EMBEDDER = DOCUMENT_EMBEDDER_SPEC.model
export const DOCUMENT_RERANKER = 'Xenova/ms-marco-MiniLM-L-6-v2'
