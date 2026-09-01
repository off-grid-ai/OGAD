/** Pure Desktop adapter tests for image-path MIME dispatch. */

import { describe, it, expect } from 'vitest'
import { imageMime } from '../chat-payload'

describe('imageMime', () => {
  it('maps .png (any case) to image/png', () => {
    expect(imageMime('/a/b.png')).toBe('image/png')
    expect(imageMime('/a/B.PNG')).toBe('image/png')
  })
  it('resolves each image type to its REAL MIME (not the old png-or-jpeg guess)', () => {
    expect(imageMime('/a/b.jpg')).toBe('image/jpeg')
    expect(imageMime('/a/b.jpeg')).toBe('image/jpeg')
    // Regression: webp/gif were mislabelled image/jpeg by the old rule, which the
    // vision model may reject. Now routed through the shared ext->MIME map.
    expect(imageMime('/a/b.webp')).toBe('image/webp')
    expect(imageMime('/a/b.gif')).toBe('image/gif')
  })
  it('falls back to image/png for an unknown/extensionless path', () => {
    expect(imageMime('/a/noext')).toBe('image/png')
  })
})
