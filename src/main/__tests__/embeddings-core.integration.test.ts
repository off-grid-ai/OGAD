import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const transformersBoundary = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  pipelineCalls: [] as unknown[][],
  inferenceCalls: [] as Array<{ text: string; options: Record<string, unknown> }>
}))

vi.mock('@xenova/transformers', () => ({
  env: transformersBoundary.env,
  pipeline: async (...args: unknown[]) => {
    transformersBoundary.pipelineCalls.push(args)
    return async (text: string, options: Record<string, unknown>) => {
      transformersBoundary.inferenceCalls.push({ text, options })
      return { data: Float32Array.from(text === 'first note' ? [0.25, 0.75] : [0.4, 0.6]) }
    }
  }
}))

describe('Desktop embeddings composition', () => {
  it('configures one external pipeline and returns plain vectors for repeated requests', async () => {
    const { embedText } = await import('../embeddings-core')
    const modelsDirectory = path.join('/tmp', 'offgrid-models')

    await expect(embedText('first note', modelsDirectory)).resolves.toEqual([0.25, 0.75])
    await expect(embedText('second note', modelsDirectory)).resolves.toEqual([
      0.4000000059604645, 0.6000000238418579
    ])

    expect(transformersBoundary.env).toEqual({
      localModelPath: modelsDirectory,
      allowRemoteModels: true,
      cacheDir: path.join(modelsDirectory, '.cache')
    })
    expect(transformersBoundary.pipelineCalls).toEqual([
      ['feature-extraction', 'Xenova/all-MiniLM-L6-v2']
    ])
    expect(transformersBoundary.inferenceCalls).toEqual([
      { text: 'first note', options: { pooling: 'mean', normalize: true } },
      { text: 'second note', options: { pooling: 'mean', normalize: true } }
    ])
  })
})
