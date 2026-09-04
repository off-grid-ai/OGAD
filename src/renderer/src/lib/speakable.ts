// Convert assistant markdown into the plain text the TTS engine should pronounce.
//
// This runs in the renderer and parses with the SAME markdown stack the chat UI
// renders with (remark-parse + remark-gfm), then extracts text from the AST. A real
// CommonMark+GFM parser handles every emphasis/link/code/list edge case by definition
// — no regex whack-a-mole (the old regex read "*emphasis*" attached to an em dash
// aloud as asterisks). Kokoro does no markdown stripping of its own, so the text must
// arrive clean. Done here (not the main process) because these remark libs are
// ESM-only and the renderer already bundles them; it also keeps ONE markdown parser.

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { toString } from 'mdast-util-to-string'
import type { Nodes, Parent } from 'mdast'

const processor = unified().use(remarkParse).use(remarkGfm)

// Block-level nodes each read as their own line (a natural pause) so list items and
// paragraphs don't run together in speech.
const BLOCKS = new Set([
  'paragraph',
  'heading',
  'listItem',
  'blockquote',
  'tableRow',
  'code',
  'thematicBreak'
])

function collect(node: Nodes, out: string[]): void {
  // Never pronounce raw HTML markup (block or inline).
  if (node.type === 'html') {
    return
  }
  if (BLOCKS.has(node.type)) {
    const text = toString(node, { includeImageAlt: true })
      .replace(/<[^>]+>/g, ' ') // any inline HTML that slipped into a block's text
      .replace(/[ \t]+/g, ' ')
      .trim()
    if (text) {
      out.push(text)
    }
    return // toString already walked this block's inline children
  }
  for (const child of (node as Parent).children) {
    collect(child, out)
  }
}

/** Rendered assistant markdown -> plain speakable text. Empty for formatting-only input. */
export function toSpeakableText(markdown: string): string {
  if (!markdown) {
    return ''
  }
  const out: string[] = []
  collect(processor.parse(markdown), out)
  return out.join('\n').trim()
}
