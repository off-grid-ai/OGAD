import { afterAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'og-embedding-setup-'))
process.env.OFFGRID_EMBEDDING_SETUP_TEST_DIR = profile
vi.mock('../runtime-env', () => ({
  dataDir: () => process.env.OFFGRID_EMBEDDING_SETUP_TEST_DIR,
  modelsDir: () => path.join(process.env.OFFGRID_EMBEDDING_SETUP_TEST_DIR!, 'models')
}))
import { getEmbeddingSetupModel, downloadEmbeddingModel } from '../embedding-setup-download'
import { saveEmbeddingModelId } from '../embedding-model-choice'

afterAll(() => {
  fs.rmSync(profile, { recursive: true, force: true })
  delete process.env.OFFGRID_EMBEDDING_SETUP_TEST_DIR
})

it('reports real catalog bytes and cached install state without changing the active model', () => {
  const model = getEmbeddingSetupModel()
  expect(model?.id).toBe('Xenova/all-MiniLM-L6-v2')
  expect(model?.files.map((file) => file.name)).toEqual([
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model.onnx'
  ])
  expect(model?.totalBytes).toBe(91_100_283)
  expect(model?.remainingBytes).toBe(model?.totalBytes)
  expect(model?.installed).toBe(false)

  saveEmbeddingModelId('custom/my-embedding', 768)
  expect(getEmbeddingSetupModel()).toBeNull()
})

it('honors cancellation before it starts a network download', async () => {
  saveEmbeddingModelId('Xenova/all-MiniLM-L6-v2', 384)
  const request = vi.spyOn(globalThis, 'fetch')
  const controller = new AbortController()
  controller.abort()
  await expect(
    downloadEmbeddingModel('Xenova/all-MiniLM-L6-v2', undefined, controller.signal)
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(request).not.toHaveBeenCalled()
  request.mockRestore()
})
