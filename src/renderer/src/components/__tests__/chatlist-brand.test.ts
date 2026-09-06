/**
 * Brand-token guard for the chat-list markdown renderer. Links are an accent
 * surface and must use the emerald token, not cyan (which isn't in the Off Grid AI
 * palette at all — DESIGN.md). ChatList.tsx is a coverage-excluded .tsx, so guard
 * the contract by reading the source (§D). Fails-before (cyan) / passes-after.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, '../ChatList.tsx'), 'utf8')

describe('ChatList markdown link — emerald, not cyan', () => {
  it('uses no cyan class anywhere (cyan is not in the brand palette)', () => {
    expect(src).not.toMatch(/text-cyan|bg-cyan|cyan-\d/)
  })

  it('renders the markdown link with the emerald accent token', () => {
    // The exact emerald token (DESIGN.md), not the Tailwind green stand-in.
    expect(src).toMatch(/<a[^>]*className="text-emerald-400 underline"/)
  })
})
