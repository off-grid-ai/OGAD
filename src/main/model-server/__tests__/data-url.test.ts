import { describe, it, expect } from 'vitest'
import { decodeDataUrl, mimeFromExt, toDataUrl } from '../image-bytes'

describe('decodeDataUrl', () => {
  it('decodes a base64 data URL', () => {
    const url = 'data:image/png;base64,' + Buffer.from('hello').toString('base64')
    const { data, mime } = decodeDataUrl(url)
    expect(mime).toBe('image/png')
    expect(data.toString('utf8')).toBe('hello')
  })

  it('decodes a percent-encoded (non-base64) data URL', () => {
    const url = 'data:image/svg+xml,%3Csvg%3E'
    const { data, mime } = decodeDataUrl(url)
    expect(mime).toBe('image/svg+xml')
    expect(data.toString('utf8')).toBe('<svg>')
  })

  it('defaults the mime to image/png when absent', () => {
    const url = 'data:,plain'
    const { mime } = decodeDataUrl(url)
    expect(mime).toBe('image/png')
  })

  it('reads the declared mime for a jpeg data URL', () => {
    const url = 'data:image/jpeg;base64,' + Buffer.from('x').toString('base64')
    expect(decodeDataUrl(url).mime).toBe('image/jpeg')
  })
})

describe('mimeFromExt', () => {
  it('maps jpg and jpeg to image/jpeg', () => {
    expect(mimeFromExt('jpg')).toBe('image/jpeg')
    expect(mimeFromExt('jpeg')).toBe('image/jpeg')
    expect(mimeFromExt('JPG')).toBe('image/jpeg')
  })

  it('maps webp to image/webp', () => {
    expect(mimeFromExt('webp')).toBe('image/webp')
    expect(mimeFromExt('WEBP')).toBe('image/webp')
  })

  it('resolves gif to its real type (now the shared map is the source, not the png lump)', () => {
    // Previously gif fell into the png bucket (a wrong-MIME bug); the shared
    // ext->MIME map resolves it correctly.
    expect(mimeFromExt('gif')).toBe('image/gif')
  })

  it('resolves bmp/heic to their real types (accepted image uploads, now in the map)', () => {
    expect(mimeFromExt('bmp')).toBe('image/bmp')
    expect(mimeFromExt('heic')).toBe('image/heic')
  })

  it('falls back to image/png for png and a genuinely-unknown/empty ext', () => {
    expect(mimeFromExt('png')).toBe('image/png')
    expect(mimeFromExt('')).toBe('image/png')
    expect(mimeFromExt('tiff')).toBe('image/png')
  })
})

describe('toDataUrl', () => {
  it('encodes bytes as a base64 data URL', () => {
    const url = toDataUrl(Buffer.from('hello'), 'image/png')
    expect(url).toBe('data:image/png;base64,' + Buffer.from('hello').toString('base64'))
  })

  it('round-trips through decodeDataUrl', () => {
    const bytes = Buffer.from([0, 1, 2, 255, 128])
    const url = toDataUrl(bytes, 'image/webp')
    const back = decodeDataUrl(url)
    expect(back.mime).toBe('image/webp')
    expect(Buffer.compare(back.data, bytes)).toBe(0)
  })
})
