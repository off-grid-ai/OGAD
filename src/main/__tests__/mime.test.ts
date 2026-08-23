import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { mimeForExt } from '../mime'
import { IMAGE_EXT } from '../files-classify'

describe('mimeForExt — single source of truth for ext -> MIME', () => {
  it('resolves video / audio / image extensions', () => {
    expect(mimeForExt('mp4')).toBe('video/mp4')
    expect(mimeForExt('m4v')).toBe('video/mp4')
    expect(mimeForExt('mov')).toBe('video/quicktime')
    expect(mimeForExt('webm')).toBe('video/webm')
    expect(mimeForExt('mp3')).toBe('audio/mpeg')
    expect(mimeForExt('m4a')).toBe('audio/mp4')
    expect(mimeForExt('wav')).toBe('audio/wav')
    expect(mimeForExt('aac')).toBe('audio/aac')
    expect(mimeForExt('ogg')).toBe('audio/ogg')
    expect(mimeForExt('png')).toBe('image/png')
    expect(mimeForExt('jpg')).toBe('image/jpeg')
    expect(mimeForExt('jpeg')).toBe('image/jpeg')
    expect(mimeForExt('gif')).toBe('image/gif')
    expect(mimeForExt('bmp')).toBe('image/bmp')
    expect(mimeForExt('heic')).toBe('image/heic')
  })

  // The webp bug: tools.ts inlined `endsWith('.png') ? png : jpeg`, so a .webp
  // attachment was mislabeled image/jpeg (which the vision model may reject).
  // The single map is the fix — webp resolves to its real type on every path.
  it('resolves webp to image/webp (never image/jpeg)', () => {
    expect(mimeForExt('webp')).toBe('image/webp')
    expect(mimeForExt('webp', 'image/png')).toBe('image/webp')
  })

  it('accepts an ext with a leading dot and any case (path.extname / raw ext both work)', () => {
    expect(mimeForExt('.mp4')).toBe('video/mp4') // media-server passes path.extname (dotted)
    expect(mimeForExt('.MP4')).toBe('video/mp4')
    expect(mimeForExt('JPEG')).toBe('image/jpeg')
    expect(mimeForExt('.WebP')).toBe('image/webp')
  })

  it('falls back per caller context for an unknown extension', () => {
    // file-serving callers (ogcapture protocol, media server) default octet-stream
    expect(mimeForExt('xyz')).toBe('application/octet-stream')
    expect(mimeForExt('')).toBe('application/octet-stream')
    // image-attachment callers pass image/png as the fallback for a TRULY unknown ext
    expect(mimeForExt('tiff', 'image/png')).toBe('image/png')
  })

  // Every ext files-classify's IMAGE_EXT accepts must be in the map, or that upload
  // is mislabelled (the class of bug this map exists to prevent). Guard it directly.
  it('covers every accepted image upload extension (no fallback for an accepted type)', () => {
    // Asserted against the ROUTER's own accept-list (single source), not a re-hardcoded
    // copy: any ext the uploader accepts must resolve to a real image/* MIME, never the
    // fallback — that mismatch is the mislabel bug this map prevents.
    for (const ext of IMAGE_EXT) {
      expect(mimeForExt(ext, 'SENTINEL')).not.toBe('SENTINEL')
      expect(mimeForExt(ext, 'SENTINEL')).toMatch(/^image\//)
    }
  })
})

// tools.ts is a coverage-excluded I/O shell (agentic loop). Guard the webp fix by reading the
// source (§D contract guard): an attachment's MIME must come from the shared map, never from a
// re-inlined `endsWith('.png') ? png : jpeg` guess that mislabelled webp.
//
// The guard moved with the code. tools.ts no longer resolves MIME at all - reading image bytes is
// owned by llm/read-images.ts, which BOTH the agentic path and the plain chat path now call, so
// there is one decoder instead of two that could disagree. So the assertion is now "tools delegates
// and does not decode", plus "the one decoder uses the shared resolver".
describe('attachment MIME — one decoder, no re-inlined png/jpeg guess', () => {
  const toolsSrc = readFileSync(join(__dirname, '../tools.ts'), 'utf8')
  const readImagesSrc = readFileSync(join(__dirname, '../llm/read-images.ts'), 'utf8')

  it('tools.ts delegates image decoding instead of doing its own', () => {
    expect(toolsSrc).toContain("import { readImages } from './llm/read-images'")
    // No second decoder: the inline readFileSync/base64 loop it used to carry is gone.
    expect(toolsSrc).not.toMatch(/readFileSync\([^)]*\)\.toString\('base64'\)/)
  })

  it('the one decoder resolves MIME through the shared map', () => {
    expect(readImagesSrc).toContain('imageMime')
  })

  it('neither inlines the .png-or-jpeg ternary that mislabelled webp', () => {
    const ternary = /endsWith\('\.png'\)\s*\?\s*'image\/png'\s*:\s*'image\/jpeg'/
    expect(toolsSrc).not.toMatch(ternary)
    expect(readImagesSrc).not.toMatch(ternary)
  })
})
