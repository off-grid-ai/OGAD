import { describe, it, expect } from 'vitest'
import {
  isImageModelFile,
  hasCheckpointExt,
  stripCheckpointExt,
  ensureCheckpointExt
} from '../model-filter'

describe('isImageModelFile', () => {
  it('accepts Qwen-Image 2.1 diffusion GGUF variants', () => {
    expect(isImageModelFile('qwen_image_2.1-Q4_K.gguf')).toBe(true)
  })
  it('accepts a known diffusion .gguf family', () => {
    expect(isImageModelFile('dreamshaper-xl-turbo.gguf')).toBe(true)
    expect(isImageModelFile('sdxl-lightning-4step.gguf')).toBe(true)
    expect(isImageModelFile('juggernaut-xl-v9.gguf')).toBe(true)
    expect(isImageModelFile('animagine-xl-4.0-Q8_0.gguf')).toBe(true)
  })

  it('accepts any .safetensors as a custom checkpoint', () => {
    expect(isImageModelFile('MyCivitaiModel.safetensors')).toBe(true)
  })

  it('rejects a .gguf that is not a known diffusion family (a stray LLM)', () => {
    expect(isImageModelFile('some-random-13b.gguf')).toBe(false)
  })

  it('excludes LLMs and companion files (gemma, qwen encoder, ae VAE, clip, t5)', () => {
    expect(isImageModelFile('gemma-3-4b.gguf')).toBe(false)
    expect(isImageModelFile('qwen3-4b-instruct-q4.gguf')).toBe(false)
    expect(isImageModelFile('ae.safetensors')).toBe(false)
    expect(isImageModelFile('clip_l.safetensors')).toBe(false)
    expect(isImageModelFile('sdxl-vae.safetensors')).toBe(false)
    expect(isImageModelFile('model-t5xxl.safetensors')).toBe(false)
  })

  it('excludes non-diffusion companions (whisper .bin, TTS .onnx, mmproj)', () => {
    expect(isImageModelFile('ggml-base.bin')).toBe(false)
    expect(isImageModelFile('kokoro.onnx')).toBe(false)
    expect(isImageModelFile('mmproj-f16.gguf')).toBe(false)
  })

  it('rejects an unrelated extension (edge)', () => {
    expect(isImageModelFile('notes.txt')).toBe(false)
  })

  it('EXCLUDE wins even over a .safetensors that would otherwise pass', () => {
    // a clip .safetensors is excluded despite the .safetensors accept branch
    expect(isImageModelFile('clip_g.safetensors')).toBe(false)
  })
})

describe('checkpoint-extension helpers (LoRA / checkpoint files)', () => {
  it('hasCheckpointExt matches the four checkpoint extensions, case-insensitively', () => {
    for (const ext of ['safetensors', 'ckpt', 'gguf', 'pt']) {
      expect(hasCheckpointExt(`model.${ext}`)).toBe(true)
      expect(hasCheckpointExt(`model.${ext.toUpperCase()}`)).toBe(true)
    }
    expect(hasCheckpointExt('model.bin')).toBe(false)
    expect(hasCheckpointExt('model')).toBe(false)
  })

  it('stripCheckpointExt removes the extension for a display name', () => {
    expect(stripCheckpointExt('dreamshaper.safetensors')).toBe('dreamshaper')
    expect(stripCheckpointExt('flux.gguf')).toBe('flux')
    expect(stripCheckpointExt('no-ext')).toBe('no-ext')
  })

  it('ensureCheckpointExt defaults a bare LoRA name to .safetensors, leaves an extension alone', () => {
    expect(ensureCheckpointExt('mylora')).toBe('mylora.safetensors')
    expect(ensureCheckpointExt('mylora.safetensors')).toBe('mylora.safetensors')
    expect(ensureCheckpointExt('mylora.ckpt')).toBe('mylora.ckpt')
  })
})
