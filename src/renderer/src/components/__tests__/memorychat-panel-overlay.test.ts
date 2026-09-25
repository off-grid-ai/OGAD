/**
 * Guard: right-side drawers (settings, models, skills, gallery, lightbox) are fixed
 * overlays and must draw ON TOP of the chat, never squeeze it. The content's
 * paddingRight reflows ONLY for the side-by-side canvas — regression was the chat
 * wrapping to one word per line with a panel open. MemoryChat is coverage-excluded (§D).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, '../MemoryChat/index.tsx'), 'utf8')
const paddingBlock = src.slice(
  src.indexOf('paddingRight: canvasArtifact'),
  src.indexOf('paddingRight: canvasArtifact') + 300
)

describe('MemoryChat content layout — drawers overlay, only the canvas reflows', () => {
  it('reflows content width for the canvas', () => {
    expect(paddingBlock).toContain('canvasArtifact')
    expect(paddingBlock).toContain('canvasWidth')
  })

  it('does NOT reserve width for any drawer (they are fixed overlays)', () => {
    expect(paddingBlock).not.toMatch(/settingsOpen|modelPickerOpen|skillsOpen|showGallery|viewer/)
  })
})
