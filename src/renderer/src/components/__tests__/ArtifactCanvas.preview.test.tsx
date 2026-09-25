// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactCanvas, artifactSpeechModelName } from '../ArtifactCanvas'

afterEach(cleanup)

describe('ArtifactCanvas isolated preview', () => {
  it('shows the speech model catalog name instead of its internal routing id', () => {
    const id = 'remote-vision:server:qwen%2Fqwen-audio-3.0-tts-flash'
    expect(
      artifactSpeechModelName(id, [
        { id, name: 'Qwen: Qwen-Audio-3.0-TTS Flash', kind: 'speech' }
      ])
    ).toBe('Qwen: Qwen-Audio-3.0-TTS Flash')
    expect(artifactSpeechModelName(id, [])).toBe('qwen/qwen-audio-3.0-tts-flash')
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
})
