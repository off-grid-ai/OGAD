import { describe, expect, it, vi } from 'vitest'
import {
  isTextEmbeddingRepository,
  searchEmbeddingModels,
  verifyEmbeddingModel
} from '../embedding-hub'

const compatible = {
  id: 'Xenova/all-MiniLM-L6-v2',
  pipeline_tag: 'feature-extraction',
  siblings: [
    { rfilename: 'config.json' },
    { rfilename: 'tokenizer.json' },
    { rfilename: 'onnx/model.onnx' }
  ]
}

describe('embedding Hub search', () => {
  it('requires a text tokenizer, ONNX weights, and the feature extraction task', () => {
    expect(isTextEmbeddingRepository(compatible)).toBe(true)
    expect(
      isTextEmbeddingRepository({ ...compatible, pipeline_tag: 'image-feature-extraction' })
    ).toBe(false)
    expect(
      isTextEmbeddingRepository({
        ...compatible,
        id: 'BAAI/bge-reranker-large',
        config: { architectures: ['XLMRobertaForSequenceClassification'] }
      })
    ).toBe(false)
    expect(
      isTextEmbeddingRepository({ ...compatible, siblings: [{ rfilename: 'onnx/model.onnx' }] })
    ).toBe(false)
    expect(
      isTextEmbeddingRepository({
        ...compatible,
        siblings: [
          { rfilename: 'config.json' },
          { rfilename: 'tokenizer.json' },
          { rfilename: 'model.gguf' }
        ]
      })
    ).toBe(false)
  })

  it('asks Hugging Face for feature extraction results and filters mixed replies', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => [
        compatible,
        { ...compatible, id: 'other/audio', siblings: [{ rfilename: 'preprocessor_config.json' }] }
      ]
    })) as unknown as typeof fetch
    await expect(searchEmbeddingModels('MiniLM', fetcher)).resolves.toMatchObject([
      { id: 'Xenova/all-MiniLM-L6-v2', name: 'all-MiniLM-L6-v2', org: 'Xenova' }
    ])
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('pipeline_tag=feature-extraction'))
  })

  it('checks the selected repository again before model loading', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => compatible
    })) as unknown as typeof fetch
    await expect(verifyEmbeddingModel(compatible.id, fetcher)).resolves.toBeUndefined()
    await expect(verifyEmbeddingModel('../bad', fetcher)).rejects.toThrow('Invalid model ID')
  })
})
