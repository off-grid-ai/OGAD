/**
 * Streaming transcription over WebSocket — "true streamed offload" for the mobile ambient recorder.
 *
 * The batch route (POST /v1/audio/transcriptions) transcribes one finished WAV. This instead keeps a
 * live session: the phone streams mic PCM up as it records, and the Mac re-decodes the growing window
 * on a cadence and pushes partial text back, then a final per phrase. It reuses the SAME whisper
 * runtime (getActiveTranscription) on a rolling temp WAV — the whisper.cpp `stream` pattern — so there
 * is no second model, just a session buffer in front of the existing one.
 *
 * Protocol (JSON control frames + binary audio):
 *   client → server:
 *     { t: 'start', sampleRate, language? }   once, first
 *     <binary>                                Int16LE mono PCM frames at sampleRate
 *     { t: 'flush' }                          phrase boundary — finalize what's buffered, then reset
 *     { t: 'stop' }                           end the session
 *   server → client:
 *     { t: 'partial', text }                  best guess of the current (unfinalized) phrase
 *     { t: 'final', text }                    a settled phrase; the client appends it
 *     { t: 'error', message }
 *
 * Trust follows the gateway's other model routes: the machine's network is the boundary (see
 * handleTranscription), so a paired phone on the LAN/tailnet is accepted without a per-frame token.
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import { getActiveTranscription } from './select'
import { encodeWav } from './wav'

export const STREAM_TRANSCRIPTION_PATH = '/v1/audio/stream'

/** Re-decode roughly this often while a phrase is still growing. */
const PARTIAL_INTERVAL_MS = 1200
/** Never let one phrase's decode window grow past this — bounds latency + memory if VAD never flushes. */
const MAX_WINDOW_SEC = 30
/** Ignore a start with an implausible rate rather than decode garbage. */
const MIN_RATE = 8000
const MAX_RATE = 48000

interface StreamSession {
  sampleRate: number
  language?: string
  chunks: Float32Array[]
  samples: number
  decoding: boolean
  dirtySinceDecode: boolean
  timer: NodeJS.Timeout | null
  closed: boolean
  seq: number
}

function int16ToFloat32(data: Buffer): Float32Array {
  const count = Math.floor(data.length / 2)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i += 1) out[i] = data.readInt16LE(i * 2) / 0x8000
  return out
}

function concat(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

/** Attach the streaming-transcription WebSocket endpoint to the already-running gateway HTTP server. */
export function attachStreamingTranscription(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: STREAM_TRANSCRIPTION_PATH })
  wss.on('connection', (ws) => handleConnection(ws))
  return wss
}

function handleConnection(ws: WebSocket): void {
  const session: StreamSession = {
    sampleRate: 16000,
    chunks: [],
    samples: 0,
    decoding: false,
    dirtySinceDecode: false,
    timer: null,
    closed: false,
    seq: 0
  }
  let started = false

  const clearTimer = (): void => {
    if (session.timer) {
      clearInterval(session.timer)
      session.timer = null
    }
  }

  const decode = async (final: boolean): Promise<void> => {
    if (session.closed) return
    if (session.decoding) {
      session.dirtySinceDecode = true
      return
    }
    if (session.samples === 0) {
      if (final) send(ws, { t: 'final', text: '' })
      return
    }
    session.decoding = true
    session.dirtySinceDecode = false
    const pcm = concat(session.chunks, session.samples)
    const rate = session.sampleRate
    const tmp = path.join(os.tmpdir(), `offgrid-stream-${process.pid}-${Date.now()}-${(session.seq += 1)}.wav`)
    try {
      await fs.promises.writeFile(tmp, Buffer.from(encodeWav(pcm, rate)))
      const text = (
        await getActiveTranscription().transcribe(
          { path: tmp },
          session.language ? { language: session.language } : {}
        )
      ).text.trim()
      if (!session.closed) send(ws, { t: final ? 'final' : 'partial', text })
    } catch (error) {
      if (!session.closed)
        send(ws, { t: 'error', message: error instanceof Error ? error.message : 'transcription failed' })
    } finally {
      fs.promises.unlink(tmp).catch(() => undefined)
      session.decoding = false
      // Audio arrived while we were busy — decode again so partials keep up.
      if (!session.closed && session.dirtySinceDecode && !final) void decode(false)
    }
  }

  const reset = (): void => {
    session.chunks = []
    session.samples = 0
    session.dirtySinceDecode = false
  }

  ws.on('message', (raw: RawData, isBinary: boolean) => {
    if (session.closed) return
    if (isBinary) {
      if (!started) return
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
      const pcm = int16ToFloat32(buf)
      if (pcm.length === 0) return
      session.chunks.push(pcm)
      session.samples += pcm.length
      session.dirtySinceDecode = true
      // Cap the window: drop the oldest audio so a phrase that never flushes can't grow unbounded.
      const max = MAX_WINDOW_SEC * session.sampleRate
      while (session.samples > max && session.chunks.length > 1) {
        const dropped = session.chunks.shift()
        if (dropped) session.samples -= dropped.length
      }
      return
    }
    let msg: { t?: string; sampleRate?: number; language?: string }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.t === 'start') {
      const rate = Number(msg.sampleRate)
      if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
        send(ws, { t: 'error', message: 'invalid sampleRate' })
        return
      }
      session.sampleRate = rate
      session.language = typeof msg.language === 'string' ? msg.language : undefined
      started = true
      reset()
      clearTimer()
      session.timer = setInterval(() => {
        if (session.dirtySinceDecode) void decode(false)
      }, PARTIAL_INTERVAL_MS)
      return
    }
    if (msg.t === 'flush') {
      void decode(true).then(reset)
      return
    }
    if (msg.t === 'stop') {
      void decode(true).finally(() => ws.close())
    }
  })

  ws.on('close', () => {
    session.closed = true
    clearTimer()
    reset()
  })
  ws.on('error', () => {
    session.closed = true
    clearTimer()
  })
}
