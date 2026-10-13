import { afterEach, describe, expect, it } from 'vitest'
import {
  AIRequestHandle,
  currentAIRequest,
  invalidateAIRequests,
  recordAIRequest,
  setAIRequestSink,
  snapshotAIValue,
  withoutAIRequestLog
} from '../ai-request-log'
import type { AIRequestRecord } from '../../shared/ai-request-log'
import { AI_LOG_POLICY } from '../../shared/ai-request-log'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

afterEach(() => setAIRequestSink(undefined))
function capture(): AIRequestRecord[] {
  const rows: AIRequestRecord[] = []
  setAIRequestSink((row) => rows.push(structuredClone(row)))
  return rows
}
describe('AI request recording does not own inference', () => {
  it('keeps nothing of work run without the log, nested requests and audio included', async () => {
    const rows = capture()
    const dir = await mkdtemp(path.join(os.tmpdir(), 'offgrid-unrecorded-'))
    const clip = path.join(dir, 'clip.wav')
    await writeFile(clip, Buffer.from('synthetic audio'))
    try {
      const text = await withoutAIRequestLog(() =>
        recordAIRequest({ modality: 'stt', source: 'Whisper transcription' }, async (log) => {
          await log.inputFile(clip)
          return recordAIRequest({ modality: 'stt', source: 'Whisper attempt' }, async () => 'Ares')
        })
      )
      expect(text).toBe('Ares')
      expect(rows).toEqual([])
      // Work after it is recorded as usual.
      await recordAIRequest({ modality: 'stt', source: 'Dictation' }, async () => 'hello')
      expect(rows.map((row) => row.source)).toEqual(['Dictation', 'Dictation'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('preserves results, effective inputs, model identity and timing', async () => {
    const rows = capture()
    const result = { content: 'answer', metrics: { completionTokens: 7 } }
    const actual = await recordAIRequest(
      { modality: 'text', source: 'Chat', model: 'selected', request: { messages: ['hello'] } },
      async (log) => {
        log.update({ model: 'actual', backend: 'CUDA', effectiveRequest: { temperature: 0.5 } })
        expect(currentAIRequest()).toBe(log)
        return result
      }
    )
    expect(actual).toBe(result)
    expect(rows.map((row) => row.status)).toEqual(['running', 'completed'])
    expect(rows[1]).toMatchObject({
      model: 'actual',
      backend: 'CUDA',
      response: result,
      metrics: { completionTokens: 7 },
      effectiveRequest: { temperature: 0.5 }
    })
    expect(rows[1]!.durationMs).toBeGreaterThanOrEqual(0)
    expect(currentAIRequest()).toBeUndefined()
  })
  it('links failed attempts to a successful fallback without swallowing errors', async () => {
    const rows = capture()
    const failure = new Error('GPU stopped')
    await recordAIRequest({ modality: 'image', source: 'Image' }, async () => {
      await expect(
        recordAIRequest({ modality: 'image', source: 'Attempt', backend: 'Vulkan' }, async () => {
          throw failure
        })
      ).rejects.toBe(failure)
      return { computeBackend: 'CPU', model: 'image.gguf', path: 'image.png' }
    })
    const finished = rows.filter((row) => row.status !== 'running')
    expect(finished[0]).toMatchObject({
      status: 'failed',
      backend: 'Vulkan',
      error: 'GPU stopped',
      parentId: finished[1]!.id
    })
    expect(finished[1]).toMatchObject({ status: 'completed', backend: 'CPU', model: 'image.gguf' })
  })
  it('keeps parallel contexts isolated', async () => {
    const rows = capture()
    await Promise.all(
      ['a', 'b'].map((source) =>
        recordAIRequest({ modality: 'text', source }, async () => {
          await new Promise((resolve) => setImmediate(resolve))
          await recordAIRequest({ modality: 'text', source: `${source}-child` }, async () => source)
        })
      )
    )
    for (const source of ['a', 'b'])
      expect(rows.find((row) => row.source === `${source}-child`)!.parentId).toBe(
        rows.find((row) => row.source === source)!.id
      )
  })
  it('retains partial output on cancellation and stream failure', async () => {
    const rows = capture()
    const controller = new AbortController()
    await recordAIRequest(
      { modality: 'text', source: 'stream', signal: controller.signal },
      async (log) => {
        log.delta('partial', 'content')
        log.delta('thinking', 'reasoning')
        controller.abort()
        return { content: 'partial' }
      }
    )
    expect(rows.at(-1)).toMatchObject({
      status: 'cancelled',
      response: { result: { content: 'partial' }, reasoning: 'thinking' }
    })
    await expect(
      recordAIRequest({ modality: 'text', source: 'stream' }, async (log) => {
        log.delta('hello', 'content')
        throw new Error('timeout')
      })
    ).rejects.toThrow('timeout')
    expect(rows.at(-1)).toMatchObject({ status: 'failed', response: { content: 'hello' } })
  })
  it('does not recreate cleared history when an in-flight request completes', () => {
    const rows = capture()
    const log = new AIRequestHandle({ modality: 'tts', source: 'Voice' })
    invalidateAIRequests()
    log.finish({ dataUrl: 'audio' })
    expect(rows).toHaveLength(1)
  })
  it('handles absent and throwing storage without changing results or failures', async () => {
    setAIRequestSink(() => {
      throw new Error('disk full')
    })
    expect(
      await recordAIRequest({ modality: 'embedding', source: 'test' }, async () => [1, 2])
    ).toEqual([1, 2])
    const error = new Error('real runtime error')
    await expect(
      recordAIRequest({ modality: 'stt', source: 'test' }, async () => {
        throw error
      })
    ).rejects.toBe(error)
    setAIRequestSink(undefined)
    expect(await recordAIRequest({ modality: 'text', source: 'disabled' }, async () => 42)).toBe(42)
  })
  it('snapshots inputs, drops credentials, and bounds cyclic or large payloads', async () => {
    const rows = capture()
    const input = { text: 'original', apiKey: 'secret', headers: { Authorization: 'secret' } }
    await recordAIRequest({ modality: 'text', source: 'test', request: input }, async () => {
      input.text = 'changed'
      return 'ok'
    })
    expect(rows.at(-1)!.request).toEqual({ text: 'original', headers: {} })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(snapshotAIValue(circular)).toEqual({ self: '[Repeated reference]' })
    expect(String(snapshotAIValue('x'.repeat(AI_LOG_POLICY.maxPayloadChars + 100)))).toContain(
      '[Truncated: log size limit]'
    )
    expect(
      snapshotAIValue({
        get value() {
          throw new Error('getter')
        }
      })
    ).toBe('[Payload unavailable]')
  })
  it('retains submitted media before caller cleanup and ignores unreadable input', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-log-input-'))
    try {
      const file = path.join(dir, 'audio.wav')
      await writeFile(file, Buffer.from('sample'))
      const rows = capture()
      await recordAIRequest({ modality: 'stt', source: 'test' }, async (log) => {
        await log.inputFile(file)
        await rm(file)
        return 'transcript'
      })
      expect(rows.at(-1)!.effectiveRequest).toMatchObject({
        media: 'data:audio/wav;base64,c2FtcGxl'
      })
      await expect(
        recordAIRequest({ modality: 'stt', source: 'test' }, async (log) => {
          await log.inputFile(file)
          return 'ok'
        })
      ).resolves.toBe('ok')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('keeps raw provider responses rather than only the projected answer', async () => {
    const rows = capture()
    await recordAIRequest({ modality: 'text', source: 'chat' }, async (log) => {
      log.update({ response: { choices: ['answer'], usage: { total: 4 } } })
      return 'answer'
    })
    expect(rows.at(-1)!.response).toEqual({ choices: ['answer'], usage: { total: 4 } })
  })
})
