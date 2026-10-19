// A minimal GGUF (v3) file for a staged model: real header bytes the app's own reader parses, with an
// optional chat template, so what a model "can do" comes from the file, as it would on a real disk.

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
const kvString = (key: string, value: string): Buffer =>
  Buffer.concat([gstr(key), u32(8 /* STRING */), gstr(value)])

/** GGUF bytes with an optional `tokenizer.chat_template`, padded like the other staged files. */
export function ggufFile(chatTemplate?: string): Buffer {
  const kvs = [kvString('general.architecture', 'qwen3')]
  if (chatTemplate) kvs.push(kvString('tokenizer.chat_template', chatTemplate))
  const header = Buffer.concat([
    Buffer.from('GGUF', 'ascii'),
    u32(3),
    u64(0 /* tensors */),
    u64(kvs.length),
    ...kvs
  ])
  return Buffer.concat([header, Buffer.alloc(Math.max(0, 2_048 - header.length))])
}

/** A template that wires up tool calling and a thinking switch (Qwen-style). */
export const TOOL_AND_THINKING_TEMPLATE =
  '{% if enable_thinking %}<think>{% endif %}' +
  '{% if tools %}{% for t in tools %}{{ t.function.name }}{% endfor %}{% endif %}' +
  '{% for m in messages %}{% if m.tool_calls %}<tool_call>{% endif %}{{ m.content }}{% endfor %}'

/** A plain chat template: no tools, no thinking control. */
export const PLAIN_TEMPLATE = '{% for m in messages %}{{ m.role }}: {{ m.content }}{% endfor %}'
