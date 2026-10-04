import { describe, it, expect } from 'vitest'
import { buildWhisperServerArgs, whisperContextKey } from '../whisper-server'

describe('buildWhisperServerArgs', () => {
  it('builds -m / --host / --port / -t argv from the context', () => {
    const args = buildWhisperServerArgs({
      modelPath: '/models/ggml-base.bin',
      threads: 4,
      port: 8441
    })
    expect(args).toEqual([
      '-m',
      '/models/ggml-base.bin',
      '--host',
      '127.0.0.1',
      '--port',
      '8441',
      '-t',
      '4'
    ])
  })

  it('defaults the port and threads when omitted', () => {
    const args = buildWhisperServerArgs({ modelPath: '/m/ggml-small.bin' })
    // model + host are fixed; a port and a thread count are always present.
    expect(args.slice(0, 4)).toEqual(['-m', '/m/ggml-small.bin', '--host', '127.0.0.1'])
    const portIdx = args.indexOf('--port')
    expect(portIdx).toBeGreaterThan(-1)
    expect(Number(args[portIdx + 1])).toBeGreaterThan(0)
    const tIdx = args.indexOf('-t')
    expect(tIdx).toBeGreaterThan(-1)
    expect(Number(args[tIdx + 1])).toBeGreaterThanOrEqual(1)
  })
})

describe('whisperContextKey', () => {
  it('is stable for the same context and differs on a model swap', () => {
    const a = whisperContextKey({ modelPath: '/m/base.bin', threads: 4, port: 8441 })
    const b = whisperContextKey({ modelPath: '/m/base.bin', threads: 4, port: 8441 })
    const c = whisperContextKey({ modelPath: '/m/large.bin', threads: 4, port: 8441 })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('differs when the thread count changes (a restart-worthy launch arg)', () => {
    const a = whisperContextKey({ modelPath: '/m/base.bin', threads: 4 })
    const b = whisperContextKey({ modelPath: '/m/base.bin', threads: 8 })
    expect(a).not.toBe(b)
  })
})
