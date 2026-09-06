// Unit tests for the self-hosted gateway docs (api-docs.ts).
//
// All three exports are pure string/object builders parameterised by the live
// gateway port and (for the spec) the current modality/image-model state, so we
// assert the port is threaded through and the live-status branches render.
import { describe, it, expect } from 'vitest'
import { docsText, docsHtml, openApiSpec } from '../api-docs'

interface ImageModelSchema {
  enum?: string[]
  type?: string
}

interface ImagePathSpec {
  paths: {
    '/v1/images': {
      post: {
        requestBody: {
          content: {
            'application/json': { schema: { properties: { model: ImageModelSchema } } }
          }
        }
      }
    }
  }
}

describe('docsText', () => {
  it('embeds the loopback base URL for the given port', () => {
    const out = docsText(8439)
    expect(out).toContain('http://127.0.0.1:8439/v1')
    expect(out).toContain('Off Grid AI — Local Model Gateway')
    expect(out).toContain('no API key required')
  })

  it('lists every modality endpoint', () => {
    const out = docsText(1234)
    for (const p of [
      '/v1/chat/completions',
      '/v1/embeddings',
      '/v1/audio/transcriptions',
      '/v1/audio/speech',
      '/v1/audio/voices',
      '/v1/images'
    ]) {
      expect(out).toContain(`http://127.0.0.1:1234${p}`)
    }
  })

  it('threads a different port through the whole document', () => {
    expect(docsText(9999)).not.toContain('127.0.0.1:8439')
    expect(docsText(9999)).toContain('127.0.0.1:9999')
  })
})

describe('docsHtml', () => {
  it('is a self-contained HTML document', () => {
    const html = docsHtml(8439)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('</html>')
    expect(html).toContain('<title>Off Grid AI — Local API</title>')
  })

  it('points the Scalar reference at the port-specific openapi.json', () => {
    expect(docsHtml(7878)).toContain('data-url="http://127.0.0.1:7878/openapi.json"')
  })

  it('applies the Off Grid AI brand tokens (Menlo + emerald)', () => {
    const html = docsHtml(8439)
    expect(html).toContain('#34D399') // emerald accent
    expect(html).toContain('Menlo')
  })
})

describe('openApiSpec', () => {
  const spec = (
    modalities: Record<string, string> = {},
    imageModels: string[] = []
  ): Record<string, unknown> =>
    openApiSpec(8439, modalities, imageModels) as Record<string, unknown>

  it('produces an OpenAPI 3.1 document with the loopback server', () => {
    const s = spec()
    expect(s.openapi).toBe('3.1.0')
    expect((s.info as { title: string }).title).toBe('Off Grid AI — Local Model Gateway')
    expect(s.servers).toEqual([
      { url: 'http://127.0.0.1:8439', description: 'Local gateway (loopback)' }
    ])
  })

  it('renders "ready" only for modalities whose value is exactly "ready"', () => {
    const desc = (
      openApiSpec(8439, { text: 'ready', vision_understanding: 'loading' }, []) as {
        info: { description: string }
      }
    ).info.description
    expect(desc).toContain('text: ready')
    // A non-"ready" value maps to "not installed", never leaks the raw state.
    expect(desc).toContain('vision: not installed')
    expect(desc).not.toContain('vision: loading')
  })

  it('marks a missing modality as "not installed"', () => {
    const desc = (openApiSpec(8439, {}, []) as { info: { description: string } }).info.description
    expect(desc).toContain('embeddings: not installed')
    expect(desc).toContain('image gen: not installed')
  })

  it('exposes every documented path', () => {
    const paths = spec().paths as Record<string, unknown>
    for (const p of [
      '/v1/chat/completions',
      '/v1/embeddings',
      '/v1/audio/transcriptions',
      '/v1/audio/speech',
      '/v1/audio/voices',
      '/v1/images',
      '/v1/images/generations',
      '/v1/images/edits',
      '/v1/requests/{request_id}',
      '/v1/requests'
    ]) {
      expect(paths).toHaveProperty([p])
    }
  })

  it('constrains the image "model" field to an enum when image models are installed', () => {
    const s = openApiSpec(8439, {}, ['flux-schnell', 'sd-turbo']) as ImagePathSpec
    const modelSchema =
      s.paths['/v1/images'].post.requestBody.content['application/json'].schema.properties.model
    expect(modelSchema.enum).toEqual(['flux-schnell', 'sd-turbo'])
  })

  it('leaves the image "model" field unconstrained when no image models are installed', () => {
    const s = openApiSpec(8439, {}, []) as ImagePathSpec
    const modelSchema =
      s.paths['/v1/images'].post.requestBody.content['application/json'].schema.properties.model
    expect(modelSchema.enum).toBeUndefined()
    expect(modelSchema.type).toBe('string')
  })

  it('lists installed image model names in the description, or a prompt to install one', () => {
    const withModels = (
      openApiSpec(8439, {}, ['flux-schnell']) as { info: { description: string } }
    ).info.description
    expect(withModels).toContain('flux-schnell')

    const without = (openApiSpec(8439, {}, []) as { info: { description: string } }).info
      .description
    expect(without).toContain('install one from the Models screen')
  })
})
