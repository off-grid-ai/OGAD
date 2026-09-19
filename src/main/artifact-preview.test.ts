import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_CONTENT_SECURITY_POLICY,
  MAX_ARTIFACT_PREVIEW_BYTES,
  MAX_ARTIFACT_PREVIEWS_PER_OWNER,
  createArtifactPreview,
  revokeArtifactPreview,
  revokeArtifactPreviewsForOwner,
  serveArtifactPreview
} from './artifact-preview'
import { createRendererContentSecurityPolicy } from '../shared/renderer-csp'
import { MEDIA_PORT } from '../shared/ports'

describe('renderer content security policy', () => {
  it('keeps executable artifact permissions out of the trusted renderer', () => {
    const policy = createRendererContentSecurityPolicy('test-nonce')
    expect(policy).not.toContain("'unsafe-inline'")
    expect(policy).not.toContain("'unsafe-eval'")
    expect(policy).not.toContain('*')
    expect(policy).toContain("script-src 'self' 'nonce-test-nonce'")
    expect(policy).toContain("style-src 'self' 'nonce-test-nonce'")
    expect(policy).toContain('frame-src')
    expect(policy).toContain('ogartifact:')
    expect(policy).toContain(`img-src 'self' data: blob: ogcapture: http://127.0.0.1:${MEDIA_PORT}`)
  })

  it('limits artifact network access to the exact package runtime host', () => {
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).toContain("default-src 'none'")
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).toContain('https://esm.sh')
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).toContain('img-src data: blob: ogcapture:')
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).not.toContain('*')
  })
})

describe('artifact preview registry', () => {
  it('serves a registered document with its isolated policy until revoked', async () => {
    const ownerId = 101
    const documentHtml = '<!doctype html><script>document.body.textContent = "ready"</script>'
    const url = createArtifactPreview(documentHtml, ownerId)

    expect(url).toMatch(/^ogartifact:\/\/preview\/[0-9a-f-]+$/)
    const response = serveArtifactPreview(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Security-Policy')).toBe(ARTIFACT_CONTENT_SECURITY_POLICY)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    await expect(response.text()).resolves.toBe(documentHtml)

    expect(revokeArtifactPreview(url, ownerId)).toBe(true)
    expect(serveArtifactPreview(url).status).toBe(404)
  })

  it('rejects malformed, foreign, and unknown preview URLs', () => {
    expect(revokeArtifactPreview('not a url', 102)).toBe(false)
    expect(serveArtifactPreview('https://preview/id').status).toBe(404)
    expect(serveArtifactPreview('ogartifact://other/id').status).toBe(404)
    expect(serveArtifactPreview('ogartifact://preview/unknown').status).toBe(404)
  })

  it('binds revocation to the creating renderer and cleans all of its previews', () => {
    const firstUrl = createArtifactPreview('<p>one</p>', 103)
    const secondUrl = createArtifactPreview('<p>two</p>', 103)
    expect(revokeArtifactPreview(firstUrl, 999)).toBe(false)
    expect(serveArtifactPreview(firstUrl).status).toBe(200)

    expect(revokeArtifactPreviewsForOwner(103)).toBe(2)
    expect(serveArtifactPreview(firstUrl).status).toBe(404)
    expect(serveArtifactPreview(secondUrl).status).toBe(404)
  })

  it('caps document size and live previews per renderer', () => {
    expect(() => createArtifactPreview('x'.repeat(MAX_ARTIFACT_PREVIEW_BYTES + 1), 104)).toThrow(
      /8 MiB/
    )

    const urls = Array.from({ length: MAX_ARTIFACT_PREVIEWS_PER_OWNER }, (_, index) =>
      createArtifactPreview(`<p>${index}</p>`, 104)
    )
    expect(() => createArtifactPreview('<p>one too many</p>', 104)).toThrow(/limit reached/)
    expect(revokeArtifactPreviewsForOwner(104)).toBe(urls.length)
  })
})
