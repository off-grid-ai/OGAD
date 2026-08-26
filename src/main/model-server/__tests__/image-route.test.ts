import { describe, expect, it } from 'vitest'
import { pollProgress, shapeImageResponse } from '../image-route'

const OUT = {
  dataUrl: 'data:image/png;base64,UE5HQllURVM=',
  path: '/ud/generated-images/img-1.png',
  prompt: 'a lighthouse in a storm',
  seed: 42,
  model: 'flux-schnell',
  syncId: 'sync-123'
}

describe('shapeImageResponse', () => {
  it('returns b64_json by default, carrying the mesh sync_id for dedupe', () => {
    const body = shapeImageResponse(OUT, 'b64_json') as {
      data: [{ b64_json: string; sync_id: string; revised_prompt: string; seed: number }]
    }
    expect(body.data[0].b64_json).toBe('UE5HQllURVM=')
    expect(body.data[0].sync_id).toBe('sync-123')
    expect(body.data[0].revised_prompt).toBe(OUT.prompt)
    expect(body.data[0].seed).toBe(42)
  })

  it('returns a file url when asked, and omits sync_id when the job had none', () => {
    const { syncId: _unused, ...noSync } = OUT
    const body = shapeImageResponse(noSync, 'url') as { data: [Record<string, unknown>] }
    expect(body.data[0].url).toBe(`file://${OUT.path}`)
    expect('b64_json' in body.data[0]).toBe(false)
    expect('sync_id' in body.data[0]).toBe(false)
  })
})

describe('pollProgress', () => {
  const running = { phase: 'running', stage: 'generating', progress: { step: 12, total: 30 } } as never

  it('reports stage + step for a running image request', () => {
    expect(pollProgress('image', 'running', running)).toEqual({
      stage: 'generating',
      step: 12,
      total: 30
    })
  })

  it('stays silent for other kinds, other statuses, and an idle job service', () => {
    expect(pollProgress('chat', 'running', running)).toBeNull()
    expect(pollProgress('image', 'queued', running)).toBeNull()
    expect(pollProgress('image', 'completed', running)).toBeNull()
    expect(
      pollProgress('image', 'running', { phase: 'idle', stage: null, progress: null } as never)
    ).toBeNull()
  })

  it('reports the stage alone while there are no sampler steps yet (enhancing)', () => {
    expect(
      pollProgress('image', 'running', {
        phase: 'running',
        stage: 'enhancing',
        progress: null
      } as never)
    ).toEqual({ stage: 'enhancing' })
  })
})
