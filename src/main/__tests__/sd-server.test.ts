/**
 * Pure-helper tests for the persistent sd-server client. These lock the two
 * things that silently broke during bring-up:
 *   1. steps/method/guidance MUST be nested under `sample_params` — a top-level
 *      `sample_steps` is ignored by sd-server (it falls back to 20 steps), which
 *      is how an intended 4-step request quietly ran at 20.
 *   2. the finished image lives at result.images[0].b64_json.
 * Payloads mirror real sd-server responses captured during bring-up.
 */
import { describe, it, expect } from 'vitest'
import {
  buildSdServerContextArgs,
  contextKey,
  buildImgGenRequest,
  stepProgress,
  parseJobResult,
  describeSdFetchFailure
} from '../sd-server'

describe('buildSdServerContextArgs', () => {
  it('builds launch args with model, port, threads and flash-attn', () => {
    const args = buildSdServerContextArgs({
      modelPath: '/m/x.gguf',
      port: 8440,
      threads: 8,
      diffusionFa: true
    })
    expect(args).toEqual(['-m', '/m/x.gguf', '--listen-port', '8440', '--diffusion-fa', '-t', '8'])
  })

  it('omits --diffusion-fa when not requested', () => {
    expect(buildSdServerContextArgs({ modelPath: '/m/x.gguf', port: 8440, threads: 4 })).toEqual([
      '-m',
      '/m/x.gguf',
      '--listen-port',
      '8440',
      '-t',
      '4'
    ])
  })

  it('adds --taesd when a fast-VAE decoder path is given', () => {
    const args = buildSdServerContextArgs({
      modelPath: '/m/x.gguf',
      port: 8440,
      threads: 4,
      taesdPath: '/m/taesdxl.safetensors'
    })
    expect(args).toEqual([
      '-m',
      '/m/x.gguf',
      '--listen-port',
      '8440',
      '--taesd',
      '/m/taesdxl.safetensors',
      '-t',
      '4'
    ])
  })
})

describe('Qwen image server contract', () => {
  it('loads the diffusion, language, vision, and VAE components together', () => {
    const args = buildSdServerContextArgs({ modelPath: '/m/image.gguf', diffusionModel: true,
      llmPath: '/m/text.gguf', llmVisionPath: '/m/vision.gguf', vaePath: '/m/vae.safetensors', port: 8440, threads: 4 })
    expect(args).toEqual(['--diffusion-model', '/m/image.gguf', '--listen-port', '8440',
      '--llm', '/m/text.gguf', '--llm_vision', '/m/vision.gguf', '--vae', '/m/vae.safetensors', '-t', '4'])
  })
  it('sends source images and explicit sampling settings in the native edit request', () => {
    expect(buildImgGenRequest({ prompt: 'Make the circle blue', refImages: ['aW1hZ2U='],
      width: 256, height: 256, steps: 1, cfgScale: 1, sampleMethod: 'euler', scheduler: 'default' }))
      .toMatchObject({ ref_images: ['aW1hZ2U='], width: 256, height: 256,
        sample_params: { sample_steps: 1, sample_method: 'euler', scheduler: 'default', guidance: { txt_cfg: 1 } } })
  })
})

describe('contextKey', () => {
  it('changes when the model changes (forces a server restart)', () => {
    const a = contextKey({ modelPath: '/m/a.gguf', port: 8440 })
    const b = contextKey({ modelPath: '/m/b.gguf', port: 8440 })
    expect(a).not.toBe(b)
  })
  it('is stable for the same config', () => {
    const cfg = { modelPath: '/m/a.gguf', diffusionFa: true, threads: 8, port: 8440 }
    expect(contextKey(cfg)).toBe(contextKey({ ...cfg }))
  })
  it('changes when taesd is toggled (forces a restart to add/remove the decoder)', () => {
    const base = { modelPath: '/m/a.gguf', port: 8440 }
    expect(contextKey(base)).not.toBe(contextKey({ ...base, taesdPath: '/m/taesdxl.safetensors' }))
  })
})

describe('buildImgGenRequest', () => {
  it('nests steps/method/scheduler/guidance under sample_params (NOT top-level)', () => {
    const body = buildImgGenRequest({
      prompt: 'a cat',
      width: 512,
      height: 512,
      steps: 8,
      cfgScale: 2,
      sampleMethod: 'dpm++2m',
      scheduler: 'karras'
    })
    expect(body).not.toHaveProperty('sample_steps')
    const sp = body.sample_params as Record<string, unknown>
    expect(sp.sample_steps).toBe(8)
    expect(sp.sample_method).toBe('dpm++2m')
    expect(sp.scheduler).toBe('karras')
    expect(sp.guidance).toEqual({ txt_cfg: 2 })
    expect(body.width).toBe(512)
    expect(body.prompt).toBe('a cat')
  })

  it('applies the crisp fast defaults (512, 8 steps, dpm++2m, KARRAS, cfg 2) when unspecified', () => {
    const body = buildImgGenRequest({ prompt: 'x' })
    expect(body.width).toBe(512)
    expect(body.height).toBe(512)
    const sp = body.sample_params as Record<string, unknown>
    expect(sp.sample_steps).toBe(8)
    expect(sp.sample_method).toBe('dpm++2m')
    expect(sp.scheduler).toBe('karras')
    expect(sp.guidance).toEqual({ txt_cfg: 2 })
  })

  it('asks for step previews only when the caller shows them', () => {
    expect(buildImgGenRequest({ prompt: 'x' }, true)).toMatchObject({
      preview: 'proj',
      preview_interval: 1
    })
    expect(buildImgGenRequest({ prompt: 'x' })).not.toHaveProperty('preview')
  })

  it('sends a concrete seed, but omits it when -1 (random)', () => {
    expect(buildImgGenRequest({ prompt: 'x', seed: 42 }).seed).toBe(42)
    expect(buildImgGenRequest({ prompt: 'x', seed: -1 })).not.toHaveProperty('seed')
    expect(buildImgGenRequest({ prompt: 'x' })).not.toHaveProperty('seed')
  })
})

describe('parseJobResult', () => {
  it('extracts the PNG from a completed job', () => {
    const out = parseJobResult({
      status: 'completed',
      result: { images: [{ b64_json: 'QUJD', index: 0 }], output_format: 'png' }
    })
    expect(out).toEqual({ done: true, ok: true, pngBase64: 'QUJD', progress: undefined })
  })

  it('flags a completed-but-empty job as a failure (no silent success)', () => {
    const out = parseJobResult({ status: 'completed', result: { images: [] } })
    expect(out.done).toBe(true)
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/no image/i)
  })

  it('surfaces the server error on a failed job', () => {
    const out = parseJobResult({ status: 'failed', error: 'out of memory' })
    expect(out).toMatchObject({ done: true, ok: false, error: 'out of memory' })
  })

  it('surfaces the resolved seed when the server reports one (reproducible -1)', () => {
    // seed may live on the job, the result, or the image entry.
    expect(
      parseJobResult({ status: 'completed', seed: 123, result: { images: [{ b64_json: 'QQ' }] } })
        .seed
    ).toBe(123)
    expect(
      parseJobResult({ status: 'completed', result: { seed: 456, images: [{ b64_json: 'QQ' }] } })
        .seed
    ).toBe(456)
    expect(
      parseJobResult({ status: 'completed', result: { images: [{ b64_json: 'QQ', seed: 789 }] } })
        .seed
    ).toBe(789)
    // absent -> undefined (caller falls back to the requested seed)
    expect(
      parseJobResult({ status: 'completed', result: { images: [{ b64_json: 'QQ' }] } }).seed
    ).toBeUndefined()
  })

  it('treats queued/running as not-done and forwards progress', () => {
    expect(parseJobResult({ status: 'queued', queue_position: 0 }).done).toBe(false)
    expect(parseJobResult({ status: 'running', progress: 0.5 })).toMatchObject({
      done: false,
      progress: 0.5
    })
  })
})

describe('step previews', () => {
  const running = {
    status: 'generating',
    progress: 0.25,
    preview: { b64_json: 'cG5n', step: 3, total_steps: 20, pass: 1 }
  }

  it('reads the running preview with its step and total', () => {
    expect(parseJobResult(running)).toMatchObject({
      done: false,
      preview: { pngBase64: 'cG5n', step: 3, total: 20 }
    })
    expect(parseJobResult({ ...running, preview: { b64_json: 'cG5n' } })).not.toHaveProperty(
      'preview'
    )
  })

  it('reports a new preview image, then only the step while the image is unchanged', () => {
    const outcome = parseJobResult(running)
    expect(stepProgress(outcome, 8, '')).toEqual({
      step: 3,
      total: 20,
      preview: 'data:image/png;base64,cG5n'
    })
    expect(stepProgress(outcome, 8, 'cG5n')).toEqual({ step: 3, total: 20 })
  })

  it('falls back to fractional progress, and to nothing without it', () => {
    expect(stepProgress(parseJobResult({ status: 'running', progress: 0.5 }), 8, '')).toEqual({
      step: 4,
      total: 8
    })
    expect(stepProgress(parseJobResult({ status: 'queued' }), 8, '')).toBeNull()
  })
})

describe('describeSdFetchFailure — actionable error when the resident server dies mid-job', () => {
  it('surfaces the server stderr tail when the process crashed (never a bare "fetch failed")', () => {
    const msg = describeSdFetchFailure(
      false,
      ['ggml_metal: out of memory', 'sd-server aborting'],
      new TypeError('fetch failed')
    )
    expect(msg).toContain('crashed')
    expect(msg).toContain('out of memory') // the actionable cause, not "fetch failed"
    expect(msg).not.toBe('fetch failed')
  })

  it('says "became unreachable" and falls back to the raw error when there is no stderr', () => {
    const msg = describeSdFetchFailure(true, [], new TypeError('fetch failed'))
    expect(msg).toContain('became unreachable')
    expect(msg).toContain('fetch failed') // no stderr captured → surface the raw reason
  })

  it('keeps only the last few stderr lines (a wall of logs is not actionable)', () => {
    const many = Array.from({ length: 20 }, (_, i) => `line${i}`)
    const msg = describeSdFetchFailure(false, many, 'x')
    expect(msg).toContain('line19') // most recent kept
    expect(msg).not.toContain('line0') // old lines trimmed
  })
})
