import { afterAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'og-embedding-choice-'))
process.env.OFFGRID_EMBEDDING_CHOICE_TEST_DIR = profile
vi.mock('../runtime-env', () => ({ dataDir: () => process.env.OFFGRID_EMBEDDING_CHOICE_TEST_DIR }))
import {
  getEmbeddingDimensions,
  getEmbeddingModelId,
  saveEmbeddingModelId
} from '../embedding-model-choice'

afterAll(() => {
  fs.rmSync(profile, { recursive: true, force: true })
  delete process.env.OFFGRID_EMBEDDING_CHOICE_TEST_DIR
})

it('keeps a searched model and its vector size for the next launch', () => {
  saveEmbeddingModelId('onnx-community/example-embedding-ONNX', 768)
  expect(getEmbeddingModelId()).toBe('onnx-community/example-embedding-ONNX')
  expect(getEmbeddingDimensions()).toBe(768)
})
