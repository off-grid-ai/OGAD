import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentRecord } from '@offgrid/sync/portable'

const { generateEmbedding } = vi.hoisted(() => ({
  generateEmbedding: vi.fn(async () => [1, 0])
}))

vi.mock('../../embeddings', () => ({ embeddings: { generateEmbedding } }))
vi.mock('../../rag/extractors', () => ({ desktopExtraction: {} }))

import { preparePortableDocument } from '../prepare-document'

const document: DocumentRecord = {
  id: 'document-1',
  projectId: 'project-1',
  name: 'knowledge.txt',
  kind: 'text',
  size: 80,
  createdAt: '2026-07-17T00:00:00.000Z',
  enabled: true,
  textContent:
    'Off Grid AI keeps this private fact on the device. This sentence is long enough to index.'
}

beforeEach(() => generateEmbedding.mockClear())

describe('preparePortableDocument', () => {
  it('uses real shared chunking and only replaces the embedding runtime boundary', async () => {
    const prepared = await preparePortableDocument(document, '/unused/staged-file')

    expect(prepared.chunks).toEqual([
      expect.objectContaining({ content: expect.stringContaining('private fact'), position: 0 })
    ])
    expect(prepared.embeddings).toEqual([[1, 0]])
    expect(generateEmbedding).toHaveBeenCalledOnce()
    expect(generateEmbedding).toHaveBeenCalledWith(prepared.chunks[0]!.content)
  })

  it('rejects empty content without invoking embeddings', async () => {
    await expect(
      preparePortableDocument({ ...document, textContent: '   ' }, '/unused/staged-file')
    ).rejects.toThrow('no searchable text')
    expect(generateEmbedding).not.toHaveBeenCalled()
  })
})
