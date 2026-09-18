/**
 * Brand-name guard for the chat surface. The product brand mark is "Off Grid AI"
 * (matching the sidebar), never the bare "OFF GRID"/"Off Grid". MemoryChat/index.tsx is a
 * coverage-excluded .tsx, so guard the contract by reading the source (§D).
 * Fails-before (bare "OFF GRID" header) / passes-after.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, '../MemoryChat/index.tsx'), 'utf8')

describe('MemoryChat brand mark — "Off Grid AI"', () => {
  it('renders the chat header as "Off Grid AI", not the bare "OFF GRID"', () => {
    expect(src).toMatch(/>Off Grid AI<\/h2>/)
    expect(src).not.toMatch(/>OFF GRID<\/h2>/)
  })

  it('labels the generating turn as "Off Grid AI"', () => {
    // The small caps label above a streaming answer is the brand mark, not "Off Grid".
    expect(src).not.toMatch(/tracking-wider text-neutral-600">\s*Off Grid\s*<\/div>/)
  })
})
