// Pure image-dimension resolution for the /v1/images endpoints. No I/O.
// Extracted from model-server.ts so the branch logic (OpenAI size, OpenRouter
// aspect_ratio + resolution, explicit width/height) is unit-testable.

import { snapImageDimension } from '../../shared/image-dimensions'

// Round to a multiple of 64 (diffusion models require it), clamped 256-2048. A non-finite input
// (NaN/Infinity - e.g. a bad size string or a 0-denominator aspect ratio) clamps to the 256 floor
// rather than leaking NaN downstream into image generation. Same rule as the in-app size controls.
export const round64 = snapImageDimension

/** Parse an OpenAI "WIDTHxHEIGHT" size string. */
export function parseSize(size: unknown): { width?: number; height?: number } {
  if (typeof size !== 'string') return {}
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim())
  if (!m) return {}
  return { width: parseInt(m[1]!, 10), height: parseInt(m[2]!, 10) }
}

// Resolve output dimensions from any of: explicit width/height, an OpenAI
// "WIDTHxHEIGHT" size, or an OpenRouter aspect_ratio + resolution pair. EVERY branch runs its
// result through round64 (round to /64, clamp 256-2048, reject NaN) so no path can leak an
// out-of-range or non-numeric dimension into image generation.
export function resolveDims(p: {
  width?: unknown
  height?: unknown
  size?: unknown
  aspect_ratio?: unknown
  resolution?: unknown
}): { width?: number; height?: number } {
  if (typeof p.width === 'number' && typeof p.height === 'number') {
    return { width: round64(p.width), height: round64(p.height) }
  }
  const fromSize = parseSize(p.size)
  if (fromSize.width && fromSize.height)
    return { width: round64(fromSize.width), height: round64(fromSize.height) }
  if (typeof p.aspect_ratio === 'string') {
    const m = /^(\d+)\s*[:x×]\s*(\d+)$/.exec(p.aspect_ratio.trim())
    if (m) {
      const ar = parseInt(m[1]!, 10) / parseInt(m[2]!, 10)
      const res = String(p.resolution ?? '1K').toUpperCase()
      const base = res === '2K' ? 1536 : res === '512' ? 512 : 1024 // long edge
      const [w, h] = ar >= 1 ? [base, base / ar] : [base * ar, base]
      return { width: round64(w), height: round64(h) }
    }
  }
  return {}
}
