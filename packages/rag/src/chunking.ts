// Paragraph-aware text chunking, ported from Off Grid Mobile (rag/chunking.ts).
// Splits on blank lines to respect paragraph boundaries; long paragraphs fall
// back to a fixed-size sliding window with overlap so context isn't lost across
// chunk edges. Pure: no platform dependencies.

export interface ChunkOptions {
  /** Target chunk size in characters (default 500). */
  chunkSize?: number
  /** Sliding-window overlap for oversized paragraphs (default 100). */
  overlap?: number
  /** Drop chunks shorter than this (default 20). */
  minChunkLength?: number
}

export interface Chunk {
  content: string
  position: number
}

export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const chunkSize = opts.chunkSize ?? 500
  const overlap = opts.overlap ?? 100
  const minChunkLength = opts.minChunkLength ?? 20

  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) return []

  const paragraphs = clean
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let buffer = ''

  const flush = (): void => {
    const t = buffer.trim()
    if (t.length >= minChunkLength) chunks.push(t)
    buffer = ''
  }

  for (const para of paragraphs) {
    if (para.length > chunkSize) {
      // Oversized paragraph: emit the buffer, then sliding-window the paragraph.
      flush()
      const step = Math.max(1, chunkSize - overlap)
      for (let start = 0; start < para.length; start += step) {
        const slice = para.slice(start, start + chunkSize).trim()
        if (slice.length >= minChunkLength) chunks.push(slice)
        if (start + chunkSize >= para.length) break
      }
    } else if (buffer && buffer.length + 2 + para.length > chunkSize) {
      flush()
      buffer = para
    } else {
      buffer = buffer ? `${buffer}\n\n${para}` : para
    }
  }
  flush()

  if (chunks.length === 0) {
    return [{ content: clean, position: 0 }]
  }

  return chunks.map((content, position) => ({ content, position }))
}
