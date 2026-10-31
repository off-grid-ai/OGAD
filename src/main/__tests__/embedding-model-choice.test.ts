import { afterAll, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureRuntime } from '../runtime-env'
import {
  getEmbeddingDimensions,
  getEmbeddingModelId,
  saveEmbeddingModelId
} from '../embedding-model-choice'

// A synthetic profile: the choice is written to and read back from its file, as on a real launch.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'og-embedding-choice-'))
configureRuntime({ dataDir: profile })

afterAll(() => {
  fs.rmSync(profile, { recursive: true, force: true })
})

it('keeps a searched model and its vector size for the next launch', () => {
  saveEmbeddingModelId('onnx-community/example-embedding-ONNX', 768)
  expect(getEmbeddingModelId()).toBe('onnx-community/example-embedding-ONNX')
  expect(getEmbeddingDimensions()).toBe(768)
})
