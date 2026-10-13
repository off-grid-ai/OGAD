import { describe, expect, it } from 'vitest'
import { selectedGgufParts } from '../catalog-logic'

describe('split GGUF download selection', () => {
  const parts = [
    { fileName: 'IQ3/model-00002-of-00002.gguf', downloadUrl: '/part2', sizeBytes: 32 },
    { fileName: 'IQ2/model-00001-of-00002.gguf', downloadUrl: '/other', sizeBytes: 16 },
    { fileName: 'IQ3/model-00001-of-00002.gguf', downloadUrl: '/part1', sizeBytes: 64 }
  ]
  it('selects the same complete package from either shard and puts the loader entry first', () => {
    for (const name of [parts[0]!.fileName, parts[2]!.fileName]) {
      expect(selectedGgufParts(parts, name)).toEqual([parts[2], parts[0]])
    }
  })
  it('rejects an incomplete set instead of downloading an unusable package', () => {
    expect(() => selectedGgufParts(parts.slice(0, 2), parts[0]!.fileName)).toThrow(
      'missing IQ3/model-00001-of-00002.gguf'
    )
  })
  it('preserves an ordinary single-file choice', () => {
    const file = { fileName: 'model-Q4.gguf', downloadUrl: '/model' }
    expect(selectedGgufParts([file, ...parts], file.fileName)).toEqual([file])
  })
})
