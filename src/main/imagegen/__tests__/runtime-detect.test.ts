import { describe, it, expect } from 'vitest'
import { isZImageModel } from '@offgrid/application'
import { hasMlmodelc, isQuantizedModel, isMfluxModelId } from '../runtime-detect'

describe('hasMlmodelc', () => {
  it('true when a directory listing contains a .mlmodelc resource', () => {
    expect(hasMlmodelc(['config.json', 'Unet.mlmodelc', 'merges.txt'])).toBe(true)
  })
  it('matches case-insensitively', () => {
    expect(hasMlmodelc(['TextEncoder.MLMODELC'])).toBe(true)
  })
  it('false when no entry ends in .mlmodelc', () => {
    expect(hasMlmodelc(['model.gguf', 'vae.safetensors'])).toBe(false)
  })
  it('false on an empty listing (edge)', () => {
    expect(hasMlmodelc([])).toBe(false)
  })
  it('does not match a substring that is not the suffix', () => {
    expect(hasMlmodelc(['notes.mlmodelc.txt'])).toBe(false)
  })
})

describe('isZImageModel', () => {
  it('matches z-image, z_image and zimage spellings', () => {
    expect(isZImageModel('Z-Image-Turbo.gguf')).toBe(true)
    expect(isZImageModel('z_image_turbo.gguf')).toBe(true)
    expect(isZImageModel('zimage.gguf')).toBe(true)
  })
  it('false for an unrelated checkpoint', () => {
    expect(isZImageModel('dreamshaper-xl.gguf')).toBe(false)
  })
})

describe('isQuantizedModel', () => {
  it('true for q8_0 / Q4_K quant markers with each separator', () => {
    expect(isQuantizedModel('animagine-xl-Q8_0.gguf')).toBe(true)
    expect(isQuantizedModel('model.q4_k.gguf')).toBe(true)
    expect(isQuantizedModel('model_q5.gguf')).toBe(true)
  })
  it('false for a full-precision (f16) checkpoint', () => {
    expect(isQuantizedModel('sdxl-base-f16.safetensors')).toBe(false)
  })
  it('false when a q is not followed by a digit (edge)', () => {
    expect(isQuantizedModel('quality-model.gguf')).toBe(false)
  })
})

describe('isMfluxModelId (re-exported)', () => {
  // MFLUX_MODELS is currently empty (mflux dormant) so nothing is an mflux id.
  it('false for undefined and for any string while the mflux catalog is empty', () => {
    expect(isMfluxModelId(undefined)).toBe(false)
    expect(isMfluxModelId('mlx/anything')).toBe(false)
  })
})
