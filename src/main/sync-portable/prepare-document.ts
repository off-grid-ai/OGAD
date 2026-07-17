import { chunkText, extractContent } from '@offgrid/rag'
import { BundleError } from '@offgrid/sync/portable'
import type { DocumentRecord } from '@offgrid/sync/portable'
import { embeddings } from '../embeddings'
import { desktopExtraction } from '../rag/extractors'
import type { PreparedPortableDocument } from './data'

/** Prepares searchable RAG data before the SQLite/filesystem critical section. */
export async function preparePortableDocument(
  document: DocumentRecord,
  stagedPath: string
): Promise<PreparedPortableDocument> {
  const text = document.textContent
    ? document.textContent
    : (await extractContent(stagedPath, document.name, desktopExtraction)).text
  const chunks = chunkText(text, { chunkSize: 600, overlap: 120, minChunkLength: 20 })
  if (chunks.length === 0) {
    throw new BundleError(`Document ${document.name} has no searchable text.`)
  }
  const vectors = await Promise.all(
    chunks.map((chunk) => embeddings.generateEmbedding(chunk.content))
  )
  return { chunks, embeddings: vectors }
}
