import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const host = vi.hoisted(() => ({ embed: vi.fn() }))
// The inference boundary: the ONNX pipeline reports its device once, then returns vectors.
vi.mock('../embeddings-core', () => ({
  embedTexts: async (
    texts: string[],
    _model: string,
    _modelsDir: string,
    onReady?: (device: string) => void
  ) => {
    onReady?.('coreml')
    return [await host.embed(texts[0])]
  }
}))
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
      backend: 'Core ML',
      status: 'completed',
      metrics: { dimensions: 2 },
      response: [[0.1, 0.2]],
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
