/**
 * Native (Python-free) speaker diarization + voiceprints for the gateway's /v1/audio/diarize and
 * /v1/audio/embed routes, using sherpa-onnx-node in-process.
 *
 * A voice-recognition bundle is two models: a shared **segmentation** model (pyannote-3.0 — who spoke
 * when) plus a swappable **fingerprint** (speaker-embedding) model (CAM++ / ERes2Net — whose voice).
 * Same sherpa-onnx 1.13.8 + same ONNX models as the phone's on-device path, so a voice enrolled on the
 * Mac and one enrolled on the phone share a vector space.
 *
 * Electron note: sherpa-onnx-node's `readWave` and `compute()` return *external* buffers, which
 * Electron's V8 sandbox forbids ("External buffers are not allowed"). So we decode WAV ourselves into
 * a JS-owned Float32Array and always call compute(stream, false) — the false disables the external
 * buffer and returns a copied, Electron-safe one.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DIARIZATION_MODELS, DEFAULT_DIARIZATION_MODEL_ID, resolveDiarizationModel } from '@offgrid/models'
import { dataDir, modelsDir } from '../runtime-env'

export interface DiarizedTurn {
  startMs: number
  endMs: number
  cluster: string
  embedding?: number[]
}

const TARGET_SR = 16000
const MIN_EMBED_SAMPLES = 4000 // ~0.25s — skip sub-blip turns, matching the phone/py path

// ─── Model files ─────────────────────────────────────────────────────────────
// Segmentation is shared across bundles; the fingerprint model is per-bundle. New home: flat files in
// the app's models dir (managed by the Models screen). Back-compat: the old hand-provisioned venv
// layout under ~/.offgrid-diarize/models still works untouched (that one is always the CAM++ bundle).
const LEGACY_DIR = path.join(os.homedir(), '.offgrid-diarize', 'models')

export const SEGMENTATION_FILE = 'sherpa-pyannote-segmentation-3.onnx'
export function fingerprintFile(modelId: string): string {
  return `sherpa-fingerprint-${modelId}.onnx`
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (p && fs.existsSync(p)) return p
  return null
}

export function segmentationPath(): string | null {
  return firstExisting([
    process.env.OGRID_DIARIZE_SEG || '',
    path.join(modelsDir(), SEGMENTATION_FILE),
    path.join(LEGACY_DIR, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx')
  ])
}

export function fingerprintPath(modelId: string): string | null {
  const candidates = [path.join(modelsDir(), fingerprintFile(modelId))]
  // The legacy venv only ever held the CAM++ bundle, so map it to that model id.
  if (modelId === DEFAULT_DIARIZATION_MODEL_ID) {
    candidates.push(process.env.OGRID_DIARIZE_EMB || '', path.join(LEGACY_DIR, 'campplus.onnx'))
  }
  return firstExisting(candidates)
}

// ─── Active bundle selection (persisted) ─────────────────────────────────────
function activeFile(): string {
  return path.join(dataDir(), 'diarization-active.json')
}

export function getActiveModelId(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(activeFile(), 'utf8')) as { modelId?: string }
    if (raw.modelId && DIARIZATION_MODELS.some(m => m.id === raw.modelId)) return raw.modelId
  } catch {
    // no selection yet
  }
  return DEFAULT_DIARIZATION_MODEL_ID
}

export function setActiveModelId(modelId: string): void {
  const id = DIARIZATION_MODELS.some(m => m.id === modelId) ? modelId : DEFAULT_DIARIZATION_MODEL_ID
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(activeFile(), JSON.stringify({ modelId: id }))
}

// ─── Status (drives the Models-screen "Voice recognition" card) ──────────────
export interface VoiceModelInfo {
  id: string
  name: string
  embeddingDim: number
  recommended: boolean
  installed: boolean
  active: boolean
}
export interface DiarizationStatus {
  /** Both the shared segmentation model and the active fingerprint model are present. */
  ready: boolean
  /** The shared "who spoke when" model. */
  segmentation: boolean
  /** Currently-selected fingerprint bundle. */
  activeModelId: string
  /** Every fingerprint bundle with its install/active state. */
  models: VoiceModelInfo[]
  segPath: string | null
  embPath: string | null
}

export function diarizationStatus(): DiarizationStatus {
  const segPath = segmentationPath()
  const activeModelId = getActiveModelId()
  const models: VoiceModelInfo[] = DIARIZATION_MODELS.map(m => ({
    id: m.id,
    name: m.name,
    embeddingDim: m.embeddingDim,
    recommended: !!m.recommended,
    installed: !!fingerprintPath(m.id),
    active: m.id === activeModelId
  }))
  const embPath = fingerprintPath(activeModelId)
  return {
    ready: !!segPath && !!embPath,
    segmentation: !!segPath,
    activeModelId,
    models,
    segPath,
    embPath
  }
}

// ─── sherpa-onnx-node (lazy, cached) ─────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
let sherpa: any = null
function loadSherpa(): any {
  if (!sherpa) sherpa = require('sherpa-onnx-node')
  return sherpa
}

let diarizer: { key: string; sd: any } | null = null
let extractor: { key: string; ext: any } | null = null

function getDiarizer(segPath: string, embPath: string): any {
  const key = `${segPath}|${embPath}`
  if (diarizer?.key !== key) {
    const s = loadSherpa()
    diarizer = {
      key,
      sd: new s.OfflineSpeakerDiarization({
        segmentation: { pyannote: { model: segPath } },
        embedding: { model: embPath },
        clustering: { numClusters: -1, threshold: 0.5 },
        minDurationOn: 0.3,
        minDurationOff: 0.5
      })
    }
  }
  return diarizer.sd
}

function getExtractor(embPath: string): any {
  if (extractor?.key !== embPath) {
    const s = loadSherpa()
    extractor = { key: embPath, ext: new s.SpeakerEmbeddingExtractor({ model: embPath }) }
  }
  return extractor.ext
}

// ─── WAV decode → JS-owned Float32Array @ 16k mono ───────────────────────────
function decodeWav16kMono(file: string): Float32Array {
  const buf = fs.readFileSync(file)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('diarization: not a RIFF/WAV file')
  }
  let sr = TARGET_SR
  let channels = 1
  let bits = 16
  let format = 1 // PCM
  let dataOff = -1
  let dataLen = 0
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const sz = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      format = buf.readUInt16LE(off + 8)
      channels = buf.readUInt16LE(off + 10) || 1
      sr = buf.readUInt32LE(off + 12) || TARGET_SR
      bits = buf.readUInt16LE(off + 22) || 16
    } else if (id === 'data') {
      dataOff = off + 8
      dataLen = Math.min(sz, buf.length - dataOff)
      break
    }
    off += 8 + sz + (sz & 1)
  }
  if (dataOff < 0) throw new Error('diarization: no data chunk in WAV')

  // Decode to mono float32 at the source rate.
  let mono: Float32Array
  if (format === 3 && bits === 32) {
    const n = Math.floor(dataLen / 4 / channels)
    mono = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (let c = 0; c < channels; c++) acc += buf.readFloatLE(dataOff + (i * channels + c) * 4)
      mono[i] = acc / channels
    }
  } else if (bits === 16) {
    const n = Math.floor(dataLen / 2 / channels)
    mono = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (let c = 0; c < channels; c++) acc += buf.readInt16LE(dataOff + (i * channels + c) * 2)
      mono[i] = acc / channels / 32768
    }
  } else if (bits === 32) {
    const n = Math.floor(dataLen / 4 / channels)
    mono = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (let c = 0; c < channels; c++) acc += buf.readInt32LE(dataOff + (i * channels + c) * 4)
      mono[i] = acc / channels / 2147483648
    }
  } else {
    throw new Error(`diarization: unsupported WAV (${bits}-bit, format ${format})`)
  }

  return sr === TARGET_SR ? mono : resampleLinear(mono, sr, TARGET_SR)
}

/** Simple linear resampler — plenty for speech embeddings, and keeps buffers JS-owned. */
function resampleLinear(input: Float32Array, fromSr: number, toSr: number): Float32Array {
  const ratio = toSr / fromSr
  const outLen = Math.floor(input.length * ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = srcPos - i0
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac
  }
  return out
}

function normalize(v: Float32Array): number[] {
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += (v[i] ?? 0) * (v[i] ?? 0)
  norm = Math.sqrt(norm)
  const out = new Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = norm > 0 ? (v[i] ?? 0) / norm : (v[i] ?? 0)
  return out
}

function embedSamples(ext: any, samples: Float32Array): number[] {
  const stream = ext.createStream()
  stream.acceptWaveform({ sampleRate: TARGET_SR, samples })
  stream.inputFinished()
  const v: Float32Array = ext.compute(stream, false) // false → copied (Electron-safe) buffer
  return normalize(v)
}

function resolvePaths(modelId?: string): { segPath: string; embPath: string } {
  const segPath = segmentationPath()
  // The phone dictates which fingerprint to run (one space, phone + Mac). Fall back to this Mac's
  // stored default only when the request doesn't name a known model.
  const id = modelId && DIARIZATION_MODELS.some(m => m.id === modelId) ? modelId : getActiveModelId()
  const embPath = fingerprintPath(id)
  if (!segPath || !embPath) {
    throw new Error(
      `diarization: voice model "${id}" not installed on this Mac (Models → Transcription → Voice recognition)`
    )
  }
  return { segPath, embPath }
}

// ─── Public API (same shape as the old Python offload) ───────────────────────

/** Diarize a full recording into speaker turns, each with a normalized voiceprint. */
export async function diarizeRecording(wavPath: string, modelId?: string): Promise<{ turns: DiarizedTurn[] }> {
  const { segPath, embPath } = resolvePaths(modelId)
  const samples = decodeWav16kMono(wavPath)
  const sd = getDiarizer(segPath, embPath)
  const ext = getExtractor(embPath)
  const segments: { start: number; end: number; speaker: number }[] = sd.process(samples)
  const turns: DiarizedTurn[] = []
  for (const seg of segments.slice().sort((a, b) => a.start - b.start)) {
    const s0 = Math.floor(seg.start * TARGET_SR)
    const s1 = Math.floor(seg.end * TARGET_SR)
    const chunk = samples.subarray(s0, s1)
    const embedding = chunk.length >= MIN_EMBED_SAMPLES ? embedSamples(ext, Float32Array.from(chunk)) : undefined
    turns.push({
      startMs: Math.round(seg.start * 1000),
      endMs: Math.round(seg.end * 1000),
      cluster: `spk${seg.speaker}`,
      embedding
    })
  }
  return { turns }
}

/** Voiceprint for one enrollment clip — same fingerprint model as the diarized turns. */
export async function embedClip(wavPath: string, modelId?: string): Promise<{ embedding: number[] }> {
  const { embPath } = resolvePaths(modelId)
  const samples = decodeWav16kMono(wavPath)
  const ext = getExtractor(embPath)
  return { embedding: embedSamples(ext, samples) }
}

export { resolveDiarizationModel }
