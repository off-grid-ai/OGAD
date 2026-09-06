/**
 * Locks the per-model generation defaults — the single source of truth shared by
 * BOTH image runtimes (persistent sd-server + one-shot sd-cli). The rule that
 * matters for quality: a FULL (non-distilled) checkpoint like animagine must keep
 * its ~28-step / real-CFG budget (dropping steps wrecks the image), while a
 * distilled Lightning/Turbo/DMD2 model is a crisp few-step model — 8 steps, cfg 2,
 * and (critically) the KARRAS schedule; the default `discrete` schedule undercooks
 * few-step sigmas and smears the output.
 */
import { describe, it, expect } from 'vitest'
import { imageTaesdFilename, standardImageModelDefaults } from '@offgrid/models'

describe('standardImageModelDefaults', () => {
  it('keeps full SDXL (animagine) at high quality: 1024, 28 steps, real CFG, discrete schedule', () => {
    const d = standardImageModelDefaults('animagine-xl-4.0-Q8_0.gguf')
    expect(d.isXL).toBe(true)
    expect(d.fewStep).toBe(false)
    expect(d.defaultSize).toBe(1024)
    expect(d.defaultSteps).toBe(28)
    expect(d.defaultCfg).toBe(7)
    expect(d.sampler).toBe('dpm++2m')
    expect(d.scheduler).toBe('discrete')
  })

  it('gives distilled Lightning the approved fast config: 512, 10 steps, cfg 2, dpm++2m, KARRAS', () => {
    const d = standardImageModelDefaults('sdxl-lightning-4step.gguf')
    expect(d.fewStep).toBe(true)
    expect(d.defaultSize).toBe(512)
    expect(d.defaultSteps).toBe(10)
    expect(d.defaultCfg).toBe(2)
    expect(d.sampler).toBe('dpm++2m')
    expect(d.scheduler).toBe('karras')
  })

  it('treats dreamshaper turbo as the approved fast config (512 / 10 / karras)', () => {
    const d = standardImageModelDefaults('dreamshaper-xl-v2-turbo-Q8_0.gguf')
    expect(d.fewStep).toBe(true)
    expect(d.defaultSize).toBe(512)
    expect(d.defaultSteps).toBe(10)
    expect(d.scheduler).toBe('karras')
  })

  it('recognizes DMD2 / Hyper as distilled few-step', () => {
    expect(standardImageModelDefaults('some-dmd2-xl.gguf').fewStep).toBe(true)
    expect(standardImageModelDefaults('hyper-sdxl.gguf').fewStep).toBe(true)
  })

  it('defaults a plain SD1.5 checkpoint to 512 / 28 steps / discrete', () => {
    const d = standardImageModelDefaults('dreamshaper_8.safetensors')
    expect(d.isXL).toBe(false)
    expect(d.defaultSize).toBe(512)
    expect(d.defaultSteps).toBe(28)
    expect(d.scheduler).toBe('discrete')
  })
})

describe('imageTaesdFilename', () => {
  it('uses the SDXL-specific decoder for XL models', () => {
    expect(imageTaesdFilename('animagine-xl-4.0-Q8_0.gguf')).toBe('taesdxl.safetensors')
    expect(imageTaesdFilename('sdxl-lightning-4step.gguf')).toBe('taesdxl.safetensors')
  })
  it('uses the base decoder for SD1.5 / non-XL models', () => {
    expect(imageTaesdFilename('dreamshaper_8.safetensors')).toBe('taesd.safetensors')
  })
})
