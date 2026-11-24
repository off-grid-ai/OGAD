// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactCanvas, artifactSpeechModelName, type Artifact } from '../ArtifactCanvas'
import { withHtmlErrorOverlay } from '@renderer/lib/artifact-error-overlay'

afterEach(cleanup)

describe('ArtifactCanvas isolated preview', () => {
  it('shows the speech model catalog name instead of its internal routing id', () => {
    const id = 'remote-vision:server:qwen%2Fqwen-audio-3.0-tts-flash'
    expect(
      artifactSpeechModelName(id, [{ id, name: 'Qwen: Qwen-Audio-3.0-TTS Flash', kind: 'speech' }])
    ).toBe('Qwen: Qwen-Audio-3.0-TTS Flash')
    expect(artifactSpeechModelName(id, [])).toBe('Qwen audio 3.0 tts flash')
    expect(artifactSpeechModelName('kokoro-82m-v1.0.onnx', [])).toBe('Kokoro TTS 82M')
  })

  it('renders executable HTML from the artifact origin and revokes it on close', async () => {
    const previewUrl = 'ogartifact://preview/00000000-0000-4000-8000-000000000000'
    const createArtifactPreview = vi.fn(async () => previewUrl)
    const revokeArtifactPreview = vi.fn(async () => true)
    ;(window as unknown as { api: unknown }).api = {
      artifactRuntime: vi.fn(async () => ({})),
      createArtifactPreview,
      revokeArtifactPreview
    }

    const { unmount } = render(
      <ArtifactCanvas
        artifact={{
          kind: 'html',
          code: '<button onclick="document.body.dataset.ran=1">Run</button>'
        }}
        onClose={() => {}}
      />
    )

    const frame = await screen.findByTitle<HTMLIFrameElement>('artifact')
    expect(frame.src).toBe(previewUrl)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.hasAttribute('srcdoc')).toBe(false)
    expect(createArtifactPreview).toHaveBeenCalledWith(expect.stringContaining('<button'))

    unmount()
    await waitFor(() => expect(revokeArtifactPreview).toHaveBeenCalledWith(previewUrl))
  })

  it('puts the error overlay ahead of every script the page loads', () => {
    const page =
      '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
      '<script src="https://unpkg.com/three@0.160.0/examples/js/controls/OrbitControls.js"></script>' +
      '</head><body><header>Pagoda</header></body></html>'
    const shown = withHtmlErrorOverlay(page)
    const overlay = shown.indexOf("window.addEventListener('error'")
    expect(overlay).toBeGreaterThan(shown.indexOf('<head>'))
    expect(overlay).toBeLessThan(shown.indexOf('OrbitControls.js'))
    // A <header> element is not the document head.
    expect(shown).toContain('<header>Pagoda</header>')
    expect(withHtmlErrorOverlay('<button>Run</button>').indexOf('<script>')).toBe(0)
  })

  it('sends the HTML preview with the error overlay in it', async () => {
    const createArtifactPreview = vi.fn(async () => 'ogartifact://preview/1')
    ;(window as unknown as { api: unknown }).api = {
      artifactRuntime: vi.fn(async () => ({})),
      createArtifactPreview,
      revokeArtifactPreview: vi.fn(async () => true)
    }
    render(<ArtifactCanvas artifact={{ kind: 'html', code: '<p>hi</p>' }} onClose={() => {}} />)
    await waitFor(() =>
      expect(createArtifactPreview).toHaveBeenCalledWith(
        expect.stringContaining('data-og-artifact-error')
      )
    )
  })

  it('keeps the preview while a streaming artifact grows and rebuilds it once complete', async () => {
    const createArtifactPreview = vi.fn(async () => 'ogartifact://preview/2')
    ;(window as unknown as { api: unknown }).api = {
      artifactRuntime: vi.fn(async () => ({})),
      createArtifactPreview,
      revokeArtifactPreview: vi.fn(async () => true)
    }
    const page = (body: string, partial: boolean): Artifact => ({
      kind: 'html',
      code: `<!doctype html><html><body>${body}`,
      ...(partial ? { partial: true } : {})
    })
    const { rerender } = render(
      <ArtifactCanvas artifact={page('<p>one', true)} onClose={() => {}} />
    )
    await waitFor(() => expect(createArtifactPreview).toHaveBeenCalledTimes(1))
    rerender(<ArtifactCanvas artifact={page('<p>one</p><p>two', true)} onClose={() => {}} />)
    rerender(
      <ArtifactCanvas artifact={page('<p>one</p><p>two</p><p>three', true)} onClose={() => {}} />
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(createArtifactPreview).toHaveBeenCalledTimes(1)
    rerender(
      <ArtifactCanvas
        artifact={page('<p>one</p><p>two</p><p>three</p></body></html>', false)}
        onClose={() => {}}
      />
    )
    await waitFor(() => expect(createArtifactPreview).toHaveBeenCalledTimes(2))
    expect(createArtifactPreview).toHaveBeenLastCalledWith(
      expect.stringContaining('three</p></body>')
    )
  })
})
