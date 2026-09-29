import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const host = vi.hoisted(() => ({ embed: vi.fn() }))
vi.mock('../embeddings-core', () => ({ embedText: host.embed, embeddingDevice: () => 'coreml' }))
vi.mock('../runtime-env', () => ({ modelsDir: () => '/synthetic/models' }))
vi.mock('../backend-preferences', () => ({ getBackendPreference: () => 'auto' }))
vi.mock('../runtime-residency', () => ({ getResidencyMode: () => 'resident' }))
import { embeddings } from '../embeddings'
import { setAIRequestSink } from '../ai-request-log'
import type { AIRequestRecord } from '../../shared/ai-request-log'
let records: AIRequestRecord[]
beforeEach(() => {
  records = []
  host.embed.mockReset()
  setAIRequestSink((record) => records.push(structuredClone(record)))
})
afterEach(() => setAIRequestSink(undefined))
describe('embedding request records', () => {
  it('retains the vector, model, hardware and dimensions', async () => {
    host.embed.mockResolvedValue([0.1, 0.2])
    await expect(embeddings.generateEmbedding('local text')).resolves.toEqual([0.1, 0.2])
    expect(records.at(-1)).toMatchObject({
      modality: 'embedding',
      backend: 'coreml',
      status: 'completed',
      metrics: { dimensions: 2 },
      response: [0.1, 0.2],
      request: { text: 'local text' }
    })
  })
  it('records errors and lets the next request run', async () => {
    host.embed.mockRejectedValueOnce(new Error('provider stopped')).mockResolvedValue([1])
    await expect(embeddings.generateEmbedding('first')).rejects.toThrow('provider stopped')
    expect(records.at(-1)).toMatchObject({ status: 'failed', error: 'provider stopped' })
    await embeddings.init()
    expect(records.at(-1)).toMatchObject({ source: 'Embedding warm-up', status: 'completed' })
  })
})
