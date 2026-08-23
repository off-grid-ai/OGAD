import { describe, expect, it } from 'vitest'
import { capturePathFromUrl } from '../ogcapture-serve'

/**
 * The Windows preview defect, held down where it can be proved without a protocol handler.
 *
 * An image generated on Windows, the file was on disk, download worked, and only the preview broke. The
 * handler sliced the scheme off the URL string - but a URL is parsed, not cut. The authority comes before
 * the path, so a drive letter lands in the host and loses its colon.
 */
describe('capturePathFromUrl', () => {
  it('keeps a Windows drive letter, colon and all', () => {
    // What the old slice produced: 'C/Users/oga/AppData/Roaming/Off Grid AI Desktop/generated-images/a.png'
    expect(
      capturePathFromUrl(
        'ogcapture://C:/Users/oga/AppData/Roaming/Off Grid AI Desktop/generated-images/a.png'
      )
    ).toBe('C:/Users/oga/AppData/Roaming/Off Grid AI Desktop/generated-images/a.png')
  })

  it('leaves a POSIX path exactly as it was, which is why macOS never saw the fault', () => {
    expect(capturePathFromUrl('ogcapture:///Users/user/Library/generated-images/a.png')).toBe(
      '/Users/user/Library/generated-images/a.png'
    )
  })

  it('decodes the escaping a real path needs', () => {
    expect(capturePathFromUrl('ogcapture:///Users/user/Off%20Grid/a%20b.png')).toBe(
      '/Users/user/Off Grid/a b.png'
    )
    expect(capturePathFromUrl('ogcapture://C%3A/Users/oga/a%20b.png')).toBe(
      'C:/Users/oga/a b.png'
    )
  })

  it('treats a longer authority as path, since this scheme has no host', () => {
    // Never invents a drive out of something that is not one letter.
    expect(capturePathFromUrl('ogcapture://relative/a.png')).toBe('relative/a.png')
  })
})
