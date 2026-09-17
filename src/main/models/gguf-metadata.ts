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

import type { GgufFs } from './gguf'

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
export function parseGgufMetadata(buf: Buffer): GgufMetadata {
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
      // Model hyperparameters precede the tokenizer payload in modern GGUF files. Once that
      // payload begins, an absent NextN field means the model has no embedded MTP heads. Do not
      // synchronously walk megabytes of token strings each time Settings asks for capabilities.
      if (key.startsWith('tokenizer.')) return result
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

/** True only when the GGUF declares one or more embedded NextN/MTP layers. */
export function readGgufMtpSupport(
  p: string,
  fs: GgufFs,
  maxBytes = GGUF_METADATA_PREFIX_BYTES
): boolean {
  try {
    const size = fs.statSync(p).size
    const toRead = Math.min(size, maxBytes)
    if (toRead <= 0) return false
    const fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(toRead)
    try {
      fs.readSync(fd, buf, 0, toRead, 0)
    } finally {
      fs.closeSync(fd)
    }
    return (parseGgufMetadata(buf).nextnPredictLayers ?? 0) > 0
  } catch {
    return false
  }
}
