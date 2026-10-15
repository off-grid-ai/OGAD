// EmbedPort and RerankPort adapters over the shared embedding worker: the multilingual embedder for
// passages and questions (the one memory search uses, with the prefixes it was trained on), and the
// ms-marco cross-encoder for reranking.

import type { EmbedPort, RerankPort } from '@offgrid/rag/documents'
import { embeddings } from '../embeddings'
import { DOCUMENT_EMBEDDER, DOCUMENT_EMBEDDER_SPEC } from '../embedding-models'

/** How long the model stays loaded after the last indexing batch (on-demand residency). */
const HOLD_AFTER_MS = 30_000

let release: (() => void) | null = null
let releaseTimer: ReturnType<typeof setTimeout> | null = null

/** Keep the embedding worker loaded across an ingest; let it go shortly after the last batch. */
function holdDuringIngest(): void {
  release ??= embeddings.hold()
  if (releaseTimer) clearTimeout(releaseTimer)
  releaseTimer = setTimeout(() => {
    release?.()
    release = null
    releaseTimer = null
  }, HOLD_AFTER_MS)
  releaseTimer.unref()
}

export const documentEmbedder: EmbedPort = {
  embedder: DOCUMENT_EMBEDDER,
  async embedPassages(texts) {
    holdDuringIngest()
    return embeddings.embedDocumentTexts(
      texts.map((text) => `${DOCUMENT_EMBEDDER_SPEC.passagePrefix}${text}`)
    )
  },
  async embedQuery(text) {
    const [vector] = await embeddings.embedDocumentTexts(
      [`${DOCUMENT_EMBEDDER_SPEC.queryPrefix}${text}`],
      {
        interactive: true
      }
    )
    return vector ?? []
  }
}

export const documentReranker: RerankPort = {
  rerank: (query, passages) => embeddings.rerank(query, passages)
}
