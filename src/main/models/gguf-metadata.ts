// Pure GGUF metadata reader — just enough of the key/value block to recover the model's TRAINED
// context length (`<arch>.context_length`) and architecture. We use the trained window as the
// context ceiling (like LM Studio), instead of an arbitrary constant, so a user can run a model up
// to what it was actually trained for. Parsing is split from the fs read so the byte-walk is pure
// and unit-testable; the reader below injects `GgufFs` (shared with gguf.ts) for the I/O.
//
// Format ref (GGUF v2/v3): magic "GGUF" | u32 version | u64 tensor_count | u64 kv_count | KV*.
// Each KV: gguf_string key (u64 len + bytes) | u32 value_type | value. Strings are u64-length in
// v2+. We only need two scalar keys, both written before the big tokenizer arrays, so we walk the
// KVs in order and stop as soon as both are known (never touching the huge token array).

import { promises as fsp } from 'node:fs'
import type { GgufFs } from './gguf'
import { detectThinkingDialect } from '../llm/thinking-dialect'

export interface GgufMetadata {
  architecture?: string
  contextLength?: number
  nextnPredictLayers?: number
}

// GGUF value-type enum (from the spec).
const T = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12
} as const

const SCALAR_BYTES: Record<number, number> = {
  [T.UINT8]: 1,
  [T.INT8]: 1,
  [T.BOOL]: 1,
  [T.UINT16]: 2,
  [T.INT16]: 2,
  [T.UINT32]: 4,
  [T.INT32]: 4,
  [T.FLOAT32]: 4,
  [T.UINT64]: 8,
  [T.INT64]: 8,
  [T.FLOAT64]: 8
}

/** Little-endian byte cursor over the header buffer. `need()` throws on a truncated prefix so the
 *  caller can fall back gracefully (we only read the file's leading bytes, not the whole model). */
class Cursor {
  constructor(
    readonly buf: Buffer,
    public off = 0
  ) {}
  private need(n: number): void {
    if (this.off + n > this.buf.length) {
      throw new Error('gguf: truncated metadata')
    }
  }
  u32(): number {
    this.need(4)
    const v = this.buf.readUInt32LE(this.off)
    this.off += 4
    return v
  }
  u64(): number {
    this.need(8)
    const v = this.buf.readBigUInt64LE(this.off)
    this.off += 8
    return Number(v)
  }
  take(n: number): Buffer {
    this.need(n)
    const b = this.buf.subarray(this.off, this.off + n)
    this.off += n
    return b
  }
  str(): string {
    return this.take(this.u64()).toString('utf8')
  }
}

/** Read (and advance past) one value of `type`. Returns scalars/strings; arrays are skipped
 *  (returns undefined) but still walked so the cursor lands on the next KV. */
function readValue(c: Cursor, type: number): number | string | boolean | undefined {
  switch (type) {
    case T.UINT8:
      return c.take(1).readUInt8(0)
    case T.INT8:
      return c.take(1).readInt8(0)
    case T.UINT16:
      return c.take(2).readUInt16LE(0)
    case T.INT16:
      return c.take(2).readInt16LE(0)
    case T.UINT32:
      return c.take(4).readUInt32LE(0)
    case T.INT32:
      return c.take(4).readInt32LE(0)
    case T.FLOAT32:
      return c.take(4).readFloatLE(0)
    case T.FLOAT64:
      return c.take(8).readDoubleLE(0)
    case T.UINT64:
      return c.u64()
    case T.INT64:
      return Number(c.take(8).readBigInt64LE(0))
    case T.BOOL:
      return c.take(1).readUInt8(0) !== 0
    case T.STRING:
      return c.str()
    case T.ARRAY:
      skipArray(c)
      return undefined
    default:
      throw new Error(`gguf: unknown value type ${type}`)
  }
}

function skipArray(c: Cursor): void {
  const elemType = c.u32()
  const len = c.u64()
  if (elemType === T.STRING) {
    for (let i = 0; i < len; i++) {
      c.take(c.u64())
    }
    return
  }
  if (elemType === T.ARRAY) {
    for (let i = 0; i < len; i++) {
      skipArray(c)
    }
    return
  }
  const sz = SCALAR_BYTES[elemType]
  if (sz == null) {
    throw new Error(`gguf: unknown array element type ${elemType}`)
  }
  c.take(sz * len)
}

/**
 * Parse the leading bytes of a GGUF file into the metadata we care about. Best-effort: on a
 * truncated prefix or an unexpected type it returns whatever it collected before the problem
 * (so a caller still gets `architecture` even if the buffer ended before `context_length`).
 * Not a valid GGUF header → returns {}.
 */
export function parseGgufMetadata(buf: Buffer, scanPastTokenizer = false): GgufMetadata {
  const result: GgufMetadata = {}
  if (buf.length < 8 || buf.subarray(0, 4).toString('ascii') !== 'GGUF') {
    return result
  }
  const c = new Cursor(buf, 4)
  try {
    const version = c.u32()
    if (version < 2) {
      return result // v1 used u32 counts/strings; not worth supporting (no modern model ships it)
    }
    c.u64() // tensor_count (unused)
    const kvCount = c.u64()
    const scalars = new Map<string, number | string | boolean>()
    for (let i = 0; i < kvCount; i++) {
      const key = c.str()
      const type = c.u32()
      // Context reads can stop here. MTP exports can put NextN metadata after
      // the tokenizer, so capability reads must continue through its payload.
      if (key.startsWith('tokenizer.')) {
        if (!scanPastTokenizer) return result
        readValue(c, type)
        continue
      }
      const value = readValue(c, type)
      if (value !== undefined) {
        scalars.set(key, value)
      }
      // Stop as soon as both targets are known — before the huge tokenizer arrays.
      const arch = scalars.get('general.architecture')
      if (typeof arch === 'string') {
        result.architecture = arch
        const ctx = scalars.get(`${arch}.context_length`)
        if (typeof ctx === 'number') {
          result.contextLength = ctx
        }
        const nextn = scalars.get(`${arch}.nextn_predict_layers`)
        if (typeof nextn === 'number') {
          result.nextnPredictLayers = nextn
          return result
        }
      }
    }
    // Ran the whole KV block without hitting the short-circuit (rare ordering): resolve from map.
    const arch = scalars.get('general.architecture')
    if (typeof arch === 'string') {
      result.architecture = arch
      const ctx = scalars.get(`${arch}.context_length`)
      if (typeof ctx === 'number') {
        result.contextLength = ctx
      }
      const nextn = scalars.get(`${arch}.nextn_predict_layers`)
      if (typeof nextn === 'number') {
        result.nextnPredictLayers = nextn
      }
    }
    return result
  } catch {
    // Truncated prefix / malformed value: return what we have (architecture may already be set on a
    // future extension; today we return {} on any throw before the short-circuit).
    return result
  }
}

/** How many leading bytes to read: the arch hyperparameters (incl. context_length) sit well before
 *  the tokenizer token array, so a few MB is plenty and stays cheap against a multi-GB model. */
export const GGUF_METADATA_PREFIX_BYTES = 4 * 1024 * 1024

/**
 * Read a GGUF file's trained context length, or null if it can't be determined (unreadable file,
 * missing key, or the key sits past the prefix we read). Best-effort and never throws.
 */
export function readGgufContextLength(
  p: string,
  fs: GgufFs,
  maxBytes = GGUF_METADATA_PREFIX_BYTES
): number | null {
  try {
    const size = fs.statSync(p).size
    const toRead = Math.min(size, maxBytes)
    if (toRead <= 0) {
      return null
    }
    const fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(toRead)
    try {
      fs.readSync(fd, buf, 0, toRead, 0)
    } finally {
      fs.closeSync(fd)
    }
    const ctx = parseGgufMetadata(buf).contextLength
    return typeof ctx === 'number' && ctx > 0 ? ctx : null
  } catch {
    return null
  }
}

/** The chat template string from the header, or null when absent or past the read window. */
export function parseGgufChatTemplate(buf: Buffer): string | null {
  if (buf.length < 8 || buf.subarray(0, 4).toString('ascii') !== 'GGUF') return null
  const c = new Cursor(buf, 4)
  try {
    if (c.u32() < 2) return null
    c.u64() // tensor_count
    const kvCount = c.u64()
    for (let i = 0; i < kvCount; i++) {
      const key = c.str()
      const type = c.u32()
      if (key === 'tokenizer.chat_template' && type === T.STRING) return c.str()
      readValue(c, type)
    }
  } catch {
    // Truncated prefix or an unexpected type: the template sits past what we read.
    return null
  }
  return null
}

/** Whether a chat template wires up tool/function calling (the model can be handed tools). */
export function chatTemplateDeclaresTools(template: string): boolean {
  return /tool_call|tool_calls|\btools\b|tool_calling/i.test(template)
}

// Parsing up to tens of MiB of metadata is the costly part, and the answer is fixed for
// one file version. Callers ask on every model-list read, so remember it per path, size
// and modification time.
const mtpSupportCache = new Map<string, boolean>()

/** True only when the GGUF declares one or more embedded NextN/MTP layers. */
export function readGgufMtpSupport(
  p: string,
  fs: GgufFs,
  // Some exports put prediction metadata after the tokenizer (about 11 MiB
  // for UI-Mate 9B). Keep this read bounded while covering that ordering.
  maxBytes = GGUF_METADATA_PREFIX_BYTES * 4,
  expectedSize?: number
): boolean {
  try {
    const { size, mtimeMs } = fs.statSync(p)
    if (expectedSize !== undefined && size !== expectedSize) return false
    const toRead = Math.min(size, maxBytes)
    if (toRead <= 0) return false
    const key = mtimeMs === undefined ? null : `${p}\0${size}\0${mtimeMs}\0${toRead}`
    const known = key === null ? undefined : mtpSupportCache.get(key)
    if (known !== undefined) return known
    const fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(toRead)
    try {
      fs.readSync(fd, buf, 0, toRead, 0)
    } finally {
      fs.closeSync(fd)
    }
    const supported = (parseGgufMetadata(buf, true).nextnPredictLayers ?? 0) > 0
    if (key !== null) mtpSupportCache.set(key, supported)
    return supported
  } catch {
    return false
  }
}

/** How many leading bytes to read when hunting for the chat template: it can sit after the token
 *  arrays, so this is larger than the hyperparameter prefix, yet still cheap against a GB-scale model. */
export const GGUF_TEMPLATE_PREFIX_BYTES = GGUF_METADATA_PREFIX_BYTES * 4

/** What a model's chat template wires up: tool calling, and a thinking control (reasoning). */
export interface ChatTemplateTraits {
  tools: boolean
  reasoning: boolean
}

const templateTraitsCache = new Map<string, ChatTemplateTraits | null>()

/**
 * Read a GGUF's chat template and report its traits, without blocking the event loop. The answer is
 * fixed for one file version, so it is remembered per path, size and modification time. Null when
 * the file has no template in the window we read (or cannot be read): unknown, never "false".
 */
export async function readGgufTemplateTraits(
  p: string,
  maxBytes = GGUF_TEMPLATE_PREFIX_BYTES
): Promise<ChatTemplateTraits | null> {
  try {
    const { size, mtimeMs } = await fsp.stat(p)
    const toRead = Math.min(size, maxBytes)
    if (toRead <= 0) return null
    const key = `${p}\0${size}\0${mtimeMs}\0${toRead}`
    if (templateTraitsCache.has(key)) return templateTraitsCache.get(key) ?? null
    const handle = await fsp.open(p, 'r')
    const buf = Buffer.alloc(toRead)
    try {
      await handle.read(buf, 0, toRead, 0)
    } finally {
      await handle.close()
    }
    const template = parseGgufChatTemplate(buf)
    const traits = template
      ? {
          tools: chatTemplateDeclaresTools(template),
          reasoning: detectThinkingDialect(template) !== 'none'
        }
      : null
    templateTraitsCache.set(key, traits)
    return traits
  } catch {
    return null
  }
}

/** A numeric array value (head counts per layer, a sliding-window pattern), else skipped. */
function readNumberArray(c: Cursor): number[] | undefined {
  const elemType = c.u32()
  const len = c.u64()
  const numeric = elemType !== T.STRING && elemType !== T.ARRAY && SCALAR_BYTES[elemType] != null
  if (!numeric || len > 4096) {
    // Rewind the header so skipArray reads it again.
    c.off -= 12
    skipArray(c)
    return undefined
  }
  const values: number[] = []
  for (let i = 0; i < len; i++) values.push(Number(readValue(c, elemType)))
  return values
}

/**
 * The attention shape that sets a model's KV cache size per token, from its GGUF header: layers that
 * keep a KV cache (only the full-attention ones in a hybrid such as Qwen3.5, only the non-sliding
 * layers that own their cache in Gemma 4), KV heads, and K/V head dims. Null when unreadable.
 * Never throws.
 */
export function readGgufKvShape(
  p: string,
  fs: GgufFs,
  maxBytes = GGUF_METADATA_PREFIX_BYTES
): { attentionLayers: number; kvHeads: number; keyDim: number; valueDim: number } | null {
  try {
    const size = fs.statSync(p).size
    const toRead = Math.min(size, maxBytes)
    if (toRead <= 0) return null
    const fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(toRead)
    try {
      fs.readSync(fd, buf, 0, toRead, 0)
    } finally {
      fs.closeSync(fd)
    }
    if (buf.subarray(0, 4).toString('ascii') !== 'GGUF') return null
    const c = new Cursor(buf, 4)
    if (c.u32() < 2) return null
    c.u64()
    const kvCount = c.u64()
    const values = new Map<string, number | string | boolean | number[]>()
    for (let i = 0; i < kvCount; i++) {
      const key = c.str()
      const type = c.u32()
      if (key.startsWith('tokenizer.')) break
      const value = type === T.ARRAY ? readNumberArray(c) : readValue(c, type)
      if (value !== undefined) values.set(key, value)
    }
    const arch = values.get('general.architecture')
    if (typeof arch !== 'string') return null
    const num = (key: string): number | undefined => {
      const v = values.get(`${arch}.${key}`)
      if (typeof v === 'number') return v
      if (Array.isArray(v) && v.length) return Math.max(...v)
      return undefined
    }
    const blocks = num('block_count')
    const heads = num('attention.head_count')
    const kvHeads = num('attention.head_count_kv') ?? heads
    const embedding = num('embedding_length')
    const keyDim = num('attention.key_length') ?? (embedding && heads ? embedding / heads : undefined)
    const valueDim = num('attention.value_length') ?? keyDim
    if (!blocks || !kvHeads || !keyDim || !valueDim) return null
    let attentionLayers = blocks
    const pattern = values.get(`${arch}.attention.sliding_window_pattern`)
    const interval = num('full_attention_interval')
    if (Array.isArray(pattern)) {
      // Sliding layers keep only a window; layers past the shared ones reuse an earlier cache.
      const owning = blocks - (num('attention.shared_kv_layers') ?? 0)
      attentionLayers = pattern.slice(0, owning).filter((sliding) => sliding === 0).length || 1
    } else if (interval && interval > 1) {
      // Every interval-th layer is full attention (llama.cpp counts (i + 1) % interval === 0).
      attentionLayers = Math.floor(blocks / interval)
    }
    return { attentionLayers, kvHeads, keyDim, valueDim }
  } catch {
    return null
  }
}
