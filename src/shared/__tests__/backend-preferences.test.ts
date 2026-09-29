import { describe, expect, it } from 'vitest'
import { backendChoices, normalizeBackendPreferences, prioritizeBackend } from '../backend-preferences'

describe('model backend choices', () => {
  it('offers native backends by operating system and ONNX providers by model type', () => {
    expect(backendChoices('llm', 'darwin')).toEqual(['auto', 'metal', 'cpu'])
    expect(backendChoices('image', 'linux')).toEqual(['auto', 'cuda', 'vulkan', 'cpu'])
    expect(backendChoices('stt', 'win32')).toEqual(['auto', 'cuda', 'cpu'])
    expect(backendChoices('tts', 'win32')).toEqual(['auto', 'directml', 'webgpu', 'cpu'])
    expect(backendChoices('embeddings', 'linux')).toEqual(['auto', 'cuda', 'webgpu', 'cpu'])
  })

  it('discards invalid or unsupported saved values', () => {
    const result = normalizeBackendPreferences({ llm: 'vulkan', tts: 'webgpu', image: 'unknown' }, 'darwin')
    expect(result.llm).toBe('auto')
    expect(result.tts).toBe('webgpu')
    expect(result.image).toBe('auto')
  })

  it('tries a selected GPU first but keeps fallback engines', () => {
    const candidates = ['cuda', 'vulkan', 'cpu'] as const
    expect(prioritizeBackend([...candidates], 'vulkan', (value) => value)).toEqual(['vulkan', 'cuda', 'cpu'])
    expect(prioritizeBackend([...candidates], 'cpu', (value) => value)).toEqual(['cpu'])
  })
})
