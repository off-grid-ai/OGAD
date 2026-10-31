// Every embedding lands in the AI activity log with its vector, model, hardware and dimensions.
//
// The embedding service, the backend and residency settings, the ONNX provider ladder and the
// activity store all run for real on a synthetic profile. Two boundaries are faked: Electron (app
// paths, keychain) and transformers.js, where the ONNX runtime would load weights onto a device.
// The fake machine has no GPU, so only the CPU provider starts.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const profile = vi.hoisted(() => ({ dir: '' }))
// What the next forward passes return, in order; a vector of [1] once the list is empty.
const device = vi.hoisted(() => ({ outcomes: [] as (number[] | Error)[] }))

vi.mock('electron', () => ({
  app: { getPath: () => profile.dir, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('@huggingface/transformers', () => ({
  env: { backends: { onnx: { wasm: {} } } },
  pipeline: async (_task: string, _model: string, options: { device: string }) => {
    if (options.device !== 'cpu') throw new Error(`No ${options.device} device on this machine.`)
    return Object.assign(
      async (texts: string[]) => {
        const rows = texts.map(() => {
          const outcome = device.outcomes.shift() ?? [1]
          if (outcome instanceof Error) throw outcome
          return outcome
        })
        return { tolist: () => rows }
      },
      { dispose: async () => {} }
    )
  }
}))

profile.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-ai-request-embeddings-'))
fs.mkdirSync(path.join(profile.dir, 'models'))

import { configureRuntime } from '../runtime-env'
import { getDB } from '../database'
import { embeddings } from '../embeddings'
import {
  clearAIRequestLogs,
  flushAIRequestLogs,
  getAIRequestLog,
  initializeAIRequestLogs,
  listAIRequestLogs
} from '../ai-request-log-store'

configureRuntime({ dataDir: profile.dir, modelsDir: path.join(profile.dir, 'models') })
initializeAIRequestLogs()

/** The newest entry in the activity log, as the AI activity screen opens it. */
async function latestRecord(): Promise<ReturnType<typeof getAIRequestLog>> {
  await flushAIRequestLogs()
  const [newest] = listAIRequestLogs({ limit: 1 }).rows
  return newest ? getAIRequestLog(newest.id) : null
}

beforeEach(async () => {
  device.outcomes = []
  await clearAIRequestLogs()
})
afterAll(async () => {
  await flushAIRequestLogs()
  await embeddings.shutdown()
  getDB().close()
  fs.rmSync(profile.dir, { recursive: true, force: true })
})

describe('embedding request records', () => {
  it('retains the vector, model, hardware and dimensions', async () => {
    device.outcomes = [[0.1, 0.2]]
    await expect(embeddings.generateEmbedding('local text')).resolves.toEqual([0.1, 0.2])
    expect(await latestRecord()).toMatchObject({
      modality: 'embedding',
      backend: 'CPU',
      status: 'completed',
      metrics: { dimensions: 2 },
      response: [[0.1, 0.2]],
      request: { text: 'local text' }
    })
  })
  it('records errors and lets the next request run', async () => {
    device.outcomes = [new Error('provider stopped')]
    await expect(embeddings.generateEmbedding('first')).rejects.toThrow('provider stopped')
    expect(await latestRecord()).toMatchObject({ status: 'failed', error: 'provider stopped' })
    await embeddings.init()
    expect(await latestRecord()).toMatchObject({ source: 'Embedding warm-up', status: 'completed' })
  })
})
