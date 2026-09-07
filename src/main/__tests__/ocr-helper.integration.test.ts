import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import sharp from 'sharp'
import { createOfflineFetchBoundary } from './harness/offline-fetch'

// FUNCTIONAL integration test for the native macOS OCR helper (electron/accessibility/ocr,
// built from ocr.swift via Vision). It is the capture -> OCR -> text step the whole "sees"
// pipeline depends on, so we verify the REAL binary actually extracts text - not a mock.
//
// Runs only where the compiled binary exists (a dev Mac / a release build that ran
// build scripts). In a plain `npm ci` CI the Swift helpers aren't built, so it SKIPS
// rather than failing - honest: it guards the behavior wherever the binary is present.
// Vision OCR of a FILE needs no TCC permission, so it works headless.
const OCR_BIN = path.resolve(__dirname, '../../../electron/accessibility/ocr')
const HAVE_BIN = existsSync(OCR_BIN)
const offlineNetwork = createOfflineFetchBoundary()
const OCR_PROCESS_TIMEOUT_MS = 30_000
const OCR_TEST_TIMEOUT_MS = 35_000

describe.skipIf(!HAVE_BIN)('native OCR helper (Vision) extracts text from an image', () => {
  let imagePath: string
  const KNOWN = 'Off Grid AI OCR'

  beforeAll(async () => {
    vi.stubGlobal('fetch', offlineNetwork.fetch)
    const dir = mkdtempSync(path.join(tmpdir(), 'ogocr-'))
    imagePath = path.join(dir, 'fixture.png')
    // Render big, high-contrast text so Vision reads it deterministically.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="300">
      <rect width="100%" height="100%" fill="white"/>
      <text x="50" y="180" font-family="Helvetica, Arial, sans-serif" font-size="120" font-weight="bold" fill="black">${KNOWN}</text>
    </svg>`
    const png = await sharp(Buffer.from(svg)).png().toBuffer()
    writeFileSync(imagePath, png)
  })

  afterAll(() => {
    expect(offlineNetwork.blockedRequests).toEqual([])
    vi.unstubAllGlobals()
  })

  it(
    'prints the recognized text for a rendered image',
    () => {
      const out = execFileSync(OCR_BIN, [imagePath], {
        encoding: 'utf8',
        timeout: OCR_PROCESS_TIMEOUT_MS
      })
      // Vision may split/space differently; assert the salient tokens survive round-trip.
      const normalized = out.toUpperCase().replace(/\s+/g, ' ')
      expect(normalized).toContain('OFF GRID AI')
      expect(normalized).toContain('OCR')
    },
    OCR_TEST_TIMEOUT_MS
  )

  it('exits non-zero with a usage error when given no image path', () => {
    let failed = false
    try {
      execFileSync(OCR_BIN, [], { encoding: 'utf8', timeout: 10_000, stdio: 'pipe' })
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })
})
