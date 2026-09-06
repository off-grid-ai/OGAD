/**
 * The upload name sanitiser (a path port) and the picker wiring. Classification
 * itself is owned by @offgrid/sync (attachment-kind) and tested there.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { sanitizeUploadName } from '../files-upload-name'

describe('sanitizeUploadName — strip path-unsafe characters', () => {
  it('collapses runs of unsafe characters to a single underscore', () => {
    expect(sanitizeUploadName('my file (1).png')).toBe('my_file_1_.png')
  })

  it('preserves word chars, dots, and dashes', () => {
    expect(sanitizeUploadName('report-2024_final.v2.pdf')).toBe('report-2024_final.v2.pdf')
  })

  it('replaces slashes and other separators', () => {
    expect(sanitizeUploadName('a/b\\c:d')).toBe('a_b_c_d')
  })

  it('a clean name is returned unchanged', () => {
    expect(sanitizeUploadName('photo.png')).toBe('photo.png')
  })
})

describe('upload picker and processor share the shared classifier', () => {
  it('rag-ipc builds its picker filter from @offgrid/sync, not a hardcoded array', () => {
    const src = readFileSync(join(__dirname, '../rag-ipc.ts'), 'utf8')
    expect(src).toContain("import { attachmentPickerExtensions } from '@offgrid/sync'")
    expect(src).toContain('extensions: attachmentPickerExtensions()')
    expect(src).not.toMatch(/'mp3',\s*'wav',\s*'m4a'/)
  })

  it('files.ts routes by the shared attachment kind, not its own extension sets', () => {
    const src = readFileSync(join(__dirname, '../files.ts'), 'utf8')
    expect(src).toContain("import { attachmentKindFor, type AttachmentKind } from '@offgrid/sync'")
    expect(src).not.toMatch(/IMAGE_EXT|AUDIO_EXT|VIDEO_EXT/)
  })
})
