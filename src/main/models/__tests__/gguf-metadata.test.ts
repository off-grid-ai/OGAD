import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseGgufMetadata,
  parseGgufChatTemplate,
  chatTemplateDeclaresTools,
  readGgufTemplateTraits,
  readGgufContextLength,
  readGgufKvShape,
  GGUF_METADATA_PREFIX_BYTES
} from '../gguf-metadata'

// --- Minimal GGUF (v3) byte-builder, so the parser is tested against real bytes, not a fake. ---
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const u64 = (n: number): Buffer => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}
const gstr = (s: string): Buffer => {
  const body = Buffer.from(s, 'utf8')
  return Buffer.concat([u64(body.length), body])
}
const kvString = (key: string, val: string): Buffer =>
  Buffer.concat([gstr(key), u32(8 /* STRING */), gstr(val)])
const kvU32 = (key: string, val: number): Buffer =>
  Buffer.concat([gstr(key), u32(4 /* UINT32 */), u32(val)])
const kvU64 = (key: string, val: number): Buffer =>
  Buffer.concat([gstr(key), u32(10 /* UINT64 */), u64(val)])
// A STRING array whose DECLARED length far exceeds the strings actually present — reading it would
// run off the end of the buffer (throw). Used to prove the parser short-circuits before the
// tokenizer array and never touches it.
const kvOversizedStringArray = (key: string): Buffer =>
  Buffer.concat([
    gstr(key),
    u32(9 /* ARRAY */),
    u32(8 /* STRING elem */),
    u64(1_000_000),
    gstr('a')
  ])
const buildGguf = (kvs: Buffer[], version = 3): Buffer =>
  Buffer.concat([
    Buffer.from('GGUF', 'ascii'),
    u32(version),
    u64(0 /* tensors */),
    u64(kvs.length),
    ...kvs
  ])

describe('parseGgufMetadata', () => {
  it('reads architecture and the trained context_length (UINT32)', () => {
    const buf = buildGguf([
      kvString('general.architecture', 'llama'),
      kvU32('llama.context_length', 131072)
    ])
    expect(parseGgufMetadata(buf)).toEqual({ architecture: 'llama', contextLength: 131072 })
  })

  it('reads a UINT64 context_length (qwen-style)', () => {
    const buf = buildGguf([
      kvString('general.architecture', 'qwen3moe'),
      kvU64('qwen3moe.context_length', 262144)
    ])
    expect(parseGgufMetadata(buf)).toEqual({ architecture: 'qwen3moe', contextLength: 262144 })
  })

  it('short-circuits before the tokenizer array — never walks the huge token list', () => {
    // The oversized array sits AFTER the two keys. If the parser did not stop early it would try to
    // read 1,000,000 strings, run off the buffer, and return {} — so a correct result proves it stopped.
    const buf = buildGguf([
      kvString('general.architecture', 'llama'),
      kvU32('llama.context_length', 32768),
      kvOversizedStringArray('tokenizer.ggml.tokens')
    ])
    expect(parseGgufMetadata(buf)).toEqual({ architecture: 'llama', contextLength: 32768 })
  })

  it('resolves even when context_length precedes general.architecture', () => {
    const buf = buildGguf([
      kvU32('llama.context_length', 4096),
      kvString('general.architecture', 'llama')
    ])
    expect(parseGgufMetadata(buf)).toEqual({ architecture: 'llama', contextLength: 4096 })
  })

  it('returns the architecture but no contextLength when the key is absent', () => {
    const buf = buildGguf([
      kvString('general.architecture', 'llama'),
      kvU32('llama.embedding_length', 4096)
    ])
    expect(parseGgufMetadata(buf)).toEqual({ architecture: 'llama' })
  })

  it('returns {} for a non-GGUF buffer', () => {
    expect(parseGgufMetadata(Buffer.from('not a gguf file at all'))).toEqual({})
  })

  it('returns {} for an unsupported (v1) file', () => {
    expect(parseGgufMetadata(buildGguf([kvString('general.architecture', 'llama')], 1))).toEqual({})
  })
})

describe('readGgufContextLength (real temp file, real fs)', () => {
  it('reads the trained context length off a real file on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-meta-'))
    const p = path.join(dir, 'model.gguf')
    try {
      fs.writeFileSync(
        p,
        buildGguf([
          kvString('general.architecture', 'llama'),
          kvU32('llama.context_length', 131072),
          kvOversizedStringArray('tokenizer.ggml.tokens')
        ])
      )
      expect(readGgufContextLength(p, fs)).toBe(131072)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null for a missing / unreadable file', () => {
    expect(readGgufContextLength('/no/such/model.gguf', fs)).toBeNull()
  })

  it('returns null when the key sits past the bytes we read (prefix bound honored)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-meta-'))
    const p = path.join(dir, 'model.gguf')
    try {
      fs.writeFileSync(
        p,
        buildGguf([
          kvString('general.architecture', 'llama'),
          kvU32('llama.context_length', 131072)
        ])
      )
      // Read only the first 8 bytes — the KV block is beyond that, so ctx can't be recovered.
      expect(readGgufContextLength(p, fs, 8)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exposes a multi-MB default prefix (cheap vs a multi-GB model, ample for the arch block)', () => {
    expect(GGUF_METADATA_PREFIX_BYTES).toBeGreaterThanOrEqual(1024 * 1024)
  })
})

describe('tool-calling detection from the chat template', () => {
  it('extracts the chat template, and returns null when it sits past the read window', () => {
    const template = '{% for m in messages %}{{ m.content }}{% endfor %}'
    const found = buildGguf([
      kvString('general.architecture', 'qwen3'),
      kvString('tokenizer.chat_template', template)
    ])
    expect(parseGgufChatTemplate(found)).toBe(template)
    // A token array so large the walk runs off the buffer → null, never a crash.
    const truncated = buildGguf([
      kvOversizedStringArray('tokenizer.ggml.tokens'),
      kvString('tokenizer.chat_template', template)
    ])
    expect(parseGgufChatTemplate(truncated)).toBeNull()
  })

  it('reads tools from templates that wire up tool calling, and not from plain ones', () => {
    const toolTemplate =
      '{% if tools %}{% for t in tools %}{{ t.function.name }}{% endfor %}{% endif %}' +
      '{% if message.tool_calls %}<tool_call>{% endif %}'
    const plainTemplate = '{% for m in messages %}{{ m.role }}: {{ m.content }}{% endfor %}'
    expect(chatTemplateDeclaresTools(toolTemplate)).toBe(true)
    expect(chatTemplateDeclaresTools(plainTemplate)).toBe(false)
  })
})

describe('readGgufTemplateTraits (real temp file, real fs)', () => {
  const withFile = async (bytes: Buffer, run: (p: string) => Promise<void>): Promise<void> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-traits-'))
    const p = path.join(dir, 'model.gguf')
    try {
      fs.writeFileSync(p, bytes)
      await run(p)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('reads tool calling and a thinking control off the template on disk', async () => {
    const template =
      '{% if enable_thinking %}<think>{% endif %}{% for t in tools %}{{ t.name }}{% endfor %}'
    await withFile(buildGguf([kvString('tokenizer.chat_template', template)]), async (p) => {
      expect(await readGgufTemplateTraits(p)).toEqual({ tools: true, reasoning: true })
    })
  })

  it('reports neither trait for a plain chat template', async () => {
    const template = '{% for m in messages %}{{ m.role }}: {{ m.content }}{% endfor %}'
    await withFile(buildGguf([kvString('tokenizer.chat_template', template)]), async (p) => {
      expect(await readGgufTemplateTraits(p)).toEqual({ tools: false, reasoning: false })
    })
  })

  it('is unknown (null), not false, when there is no template or no file', async () => {
    await withFile(buildGguf([kvString('general.architecture', 'llama')]), async (p) => {
      expect(await readGgufTemplateTraits(p)).toBeNull()
    })
    expect(await readGgufTemplateTraits(path.join(os.tmpdir(), 'no-such-model.gguf'))).toBeNull()
  })

  it('reads a new file version again instead of serving the cached answer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-traits-'))
    const p = path.join(dir, 'model.gguf')
    try {
      fs.writeFileSync(p, buildGguf([kvString('tokenizer.chat_template', '{{ m.content }}')]))
      expect(await readGgufTemplateTraits(p)).toEqual({ tools: false, reasoning: false })
      fs.writeFileSync(
        p,
        buildGguf([kvString('tokenizer.chat_template', '{% for t in tools %}{% endfor %}x')])
      )
      fs.utimesSync(p, new Date(), new Date(Date.now() + 5_000))
      expect(await readGgufTemplateTraits(p)).toEqual({ tools: true, reasoning: false })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('readGgufKvShape', () => {
  const kvU8Array = (key: string, values: number[]): Buffer =>
    Buffer.concat([
      gstr(key),
      u32(9 /* ARRAY */),
      u32(0 /* UINT8 */),
      u64(values.length),
      Buffer.from(values)
    ])
  const write = (kvs: Buffer[]): string => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-kv-')), 'model.gguf')
    fs.writeFileSync(file, buildGguf(kvs))
    return file
  }

  it('counts only the full-attention layers of a hybrid model (Qwen3.5 layout)', () => {
    const file = write([
      kvString('general.architecture', 'qwen35'),
      kvU32('qwen35.block_count', 33),
      kvU32('qwen35.attention.head_count', 16),
      kvU32('qwen35.attention.head_count_kv', 4),
      kvU32('qwen35.attention.key_length', 256),
      kvU32('qwen35.attention.value_length', 256),
      kvU32('qwen35.full_attention_interval', 4)
    ])
    // The bundled engine reports 8 KV layers for this model.
    expect(readGgufKvShape(file, fs)).toEqual({
      attentionLayers: 8,
      kvHeads: 4,
      keyDim: 256,
      valueDim: 256
    })
  })

  it('counts the non-sliding layers that own a cache (Gemma 4 layout)', () => {
    const pattern = Array.from({ length: 42 }, (_, i) => ((i + 1) % 6 === 0 ? 0 : 1))
    const file = write([
      kvString('general.architecture', 'gemma4'),
      kvU32('gemma4.block_count', 42),
      kvU32('gemma4.attention.head_count', 8),
      kvU32('gemma4.attention.head_count_kv', 2),
      kvU32('gemma4.attention.key_length', 512),
      kvU32('gemma4.attention.value_length', 512),
      kvU32('gemma4.attention.shared_kv_layers', 18),
      kvU8Array('gemma4.attention.sliding_window_pattern', pattern)
    ])
    expect(readGgufKvShape(file, fs)).toEqual({
      attentionLayers: 4,
      kvHeads: 2,
      keyDim: 512,
      valueDim: 512
    })
  })

  it('falls back to embedding / heads for the head dim of a dense model', () => {
    const file = write([
      kvString('general.architecture', 'llama'),
      kvU32('llama.block_count', 32),
      kvU32('llama.embedding_length', 4096),
      kvU32('llama.attention.head_count', 32),
      kvU32('llama.attention.head_count_kv', 8)
    ])
    expect(readGgufKvShape(file, fs)).toEqual({
      attentionLayers: 32,
      kvHeads: 8,
      keyDim: 128,
      valueDim: 128
    })
  })

  it('returns null for a file that is not GGUF', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-kv-')), 'x.gguf')
    fs.writeFileSync(file, 'not a model')
    expect(readGgufKvShape(file, fs)).toBeNull()
  })
})
