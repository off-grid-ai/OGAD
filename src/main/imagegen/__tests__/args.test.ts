import { describe, it, expect } from 'vitest'
import { buildCoreMLArgs, buildZImageArgs, buildStandardArgs, DEFAULT_NEGATIVE } from '../args'
import { standardImageModelDefaults } from '@offgrid/models'

// A helper: value that follows a flag in the argv (or undefined if the flag is absent).
function flagVal(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

describe('buildCoreMLArgs', () => {
  it('builds the ANE helper flag vector with the default 16 steps', () => {
    const args = buildCoreMLArgs({
      model: '/m/coreml',
      prompt: 'a cat',
      outPath: '/o.png',
      seed: 42
    })
    expect(flagVal(args, '--model')).toBe('/m/coreml')
    expect(flagVal(args, '--prompt')).toBe('a cat')
    expect(flagVal(args, '--output')).toBe('/o.png')
    expect(flagVal(args, '--steps')).toBe('16')
    expect(flagVal(args, '--seed')).toBe('42')
    expect(args).not.toContain('--negative')
  })
  it('honours an explicit step count and adds --negative only when non-empty', () => {
    const args = buildCoreMLArgs({
      model: 'm',
      prompt: 'p',
      outPath: 'o',
      seed: 1,
      steps: 8,
      negativePrompt: '  ugly  '
    })
    expect(flagVal(args, '--steps')).toBe('8')
    expect(flagVal(args, '--negative')).toBe('ugly') // trimmed
  })
  it('omits --negative for a whitespace-only negative prompt (edge)', () => {
    const args = buildCoreMLArgs({
      model: 'm',
      prompt: 'p',
      outPath: 'o',
      seed: 1,
      negativePrompt: '   '
    })
    expect(args).not.toContain('--negative')
  })
})

describe('buildZImageArgs', () => {
  const base = {
    model: '/m/zimage.gguf',
    llm: '/m/qwen.gguf',
    vae: '/m/ae.safetensors',
    prompt: 'a fox',
    outPath: '/o.png',
    seed: 7,
    threads: '6',
    previewArgs: ['--preview', 'proj']
  }
  it('uses the turbo defaults (768, 8 steps, cfg 1, euler) and the offload flags', () => {
    const args = buildZImageArgs(base)
    expect(flagVal(args, '-M')).toBe('img_gen')
    expect(flagVal(args, '--diffusion-model')).toBe('/m/zimage.gguf')
    expect(flagVal(args, '--llm')).toBe('/m/qwen.gguf')
    expect(flagVal(args, '--vae')).toBe('/m/ae.safetensors')
    expect(flagVal(args, '-W')).toBe('768')
    expect(flagVal(args, '-H')).toBe('768')
    expect(flagVal(args, '--steps')).toBe('8')
    expect(flagVal(args, '--cfg-scale')).toBe('1')
    expect(flagVal(args, '--sampling-method')).toBe('euler')
    expect(args).toContain('--offload-to-cpu')
    expect(args).toContain('--vae-on-cpu')
    expect(args).toContain('--diffusion-fa')
    expect(flagVal(args, '-t')).toBe('6')
    expect(flagVal(args, '-s')).toBe('7')
    expect(args.slice(-2)).toEqual(['--preview', 'proj']) // preview appended last
  })
  it('overrides size/steps/cfg when the caller supplies them', () => {
    const args = buildZImageArgs({ ...base, width: 1024, height: 512, steps: 12, cfgScale: 3 })
    expect(flagVal(args, '-W')).toBe('1024')
    expect(flagVal(args, '-H')).toBe('512')
    expect(flagVal(args, '--steps')).toBe('12')
    expect(flagVal(args, '--cfg-scale')).toBe('3')
  })
})

describe('buildStandardArgs', () => {
  const common = {
    prompt: 'a landscape',
    outPath: '/o.png',
    seed: 5,
    threads: '4',
    previewArgs: ['--preview', 'proj'],
    modelFlags: ['-m', '/m/model.gguf']
  }

  it('reflects the SHARED defaults for a full SDXL checkpoint (no duplication)', () => {
    const base = 'animagine-xl-4.0-Q8_0.gguf'
    const d = standardImageModelDefaults(base) // single source of truth
    const args = buildStandardArgs({ ...common, base })
    expect(flagVal(args, '-W')).toBe(String(d.defaultSize))
    expect(flagVal(args, '-H')).toBe(String(d.defaultSize))
    expect(flagVal(args, '--steps')).toBe(String(d.defaultSteps))
    expect(flagVal(args, '--cfg-scale')).toBe(String(d.defaultCfg))
    expect(flagVal(args, '--sampling-method')).toBe(d.sampler)
    expect(flagVal(args, '--scheduler')).toBe(d.scheduler)
    // full XL at default 1024 (>768) -> VAE-tiling on (no taesd)
    expect(args).toContain('--vae-tiling')
  })

  it('reflects the SHARED few-step defaults for a distilled Lightning model', () => {
    const base = 'sdxl-lightning-4step.gguf'
    const d = standardImageModelDefaults(base)
    const args = buildStandardArgs({ ...common, base })
    expect(flagVal(args, '--steps')).toBe(String(d.defaultSteps)) // 10, not 28
    expect(flagVal(args, '--cfg-scale')).toBe(String(d.defaultCfg)) // 2
    expect(flagVal(args, '--scheduler')).toBe('karras')
    // default 512 (<=768) -> no VAE-tiling
    expect(args).not.toContain('--vae-tiling')
  })

  it('passes model flags through verbatim (UNET-only diffusion + companions)', () => {
    const modelFlags = [
      '--diffusion-model',
      '/m/unet.gguf',
      '--clip_l',
      '/m/l',
      '--clip_g',
      '/m/g',
      '--vae',
      '/m/vae'
    ]
    const args = buildStandardArgs({ ...common, base: 'noob-xl.gguf', modelFlags })
    expect(flagVal(args, '--diffusion-model')).toBe('/m/unet.gguf')
    expect(flagVal(args, '--clip_l')).toBe('/m/l')
    expect(flagVal(args, '--vae')).toBe('/m/vae')
    expect(args).not.toContain('-m')
  })

  it('falls back to DEFAULT_NEGATIVE when no negative is given, else uses the trimmed one', () => {
    const a1 = buildStandardArgs({ ...common, base: 'sd-1.5.gguf' })
    expect(flagVal(a1, '-n')).toBe(DEFAULT_NEGATIVE)
    const a2 = buildStandardArgs({ ...common, base: 'sd-1.5.gguf', negativePrompt: '  blurry  ' })
    expect(flagVal(a2, '-n')).toBe('blurry')
  })

  it('honours explicit width/height/steps/cfg overrides', () => {
    const args = buildStandardArgs({
      ...common,
      base: 'sd-1.5.gguf',
      width: 640,
      height: 384,
      steps: 20,
      cfgScale: 5
    })
    expect(flagVal(args, '-W')).toBe('640')
    expect(flagVal(args, '-H')).toBe('384')
    expect(flagVal(args, '--steps')).toBe('20')
    expect(flagVal(args, '--cfg-scale')).toBe('5')
  })

  it('taesd path (fastVae) is preferred and suppresses VAE-tiling even on a large XL image', () => {
    const args = buildStandardArgs({
      ...common,
      base: 'animagine-xl.gguf',
      width: 1024,
      height: 1024,
      taesdPath: '/m/taesdxl.safetensors'
    })
    expect(flagVal(args, '--taesd')).toBe('/m/taesdxl.safetensors')
    expect(args).not.toContain('--vae-tiling')
  })

  it('adds VAE-tiling only for an XL model whose largest side exceeds 768', () => {
    // XL but at 768 -> no tiling
    const at768 = buildStandardArgs({
      ...common,
      base: 'animagine-xl.gguf',
      width: 768,
      height: 768
    })
    expect(at768).not.toContain('--vae-tiling')
    // XL at 1024 -> tiling
    const at1024 = buildStandardArgs({
      ...common,
      base: 'animagine-xl.gguf',
      width: 1024,
      height: 768
    })
    expect(at1024).toContain('--vae-tiling')
    // non-XL at 1024 -> still no tiling (isXL gate)
    const nonXl = buildStandardArgs({ ...common, base: 'sd-1.5.gguf', width: 1024, height: 1024 })
    expect(nonXl).not.toContain('--vae-tiling')
  })

  it('adds img2img flags with the default strength, and a custom strength when given', () => {
    const a1 = buildStandardArgs({ ...common, base: 'sd-1.5.gguf', initImage: '/in.png' })
    expect(flagVal(a1, '-i')).toBe('/in.png')
    expect(flagVal(a1, '--strength')).toBe('0.75')
    const a2 = buildStandardArgs({
      ...common,
      base: 'sd-1.5.gguf',
      initImage: '/in.png',
      strength: 0.4
    })
    expect(flagVal(a2, '--strength')).toBe('0.4')
  })

  it('omits img2img flags for txt2img', () => {
    const args = buildStandardArgs({ ...common, base: 'sd-1.5.gguf' })
    expect(args).not.toContain('-i')
    expect(args).not.toContain('--strength')
  })
})
