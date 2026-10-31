import { describe, expect, it } from 'vitest'
import { backendChoices, normalizeBackendPreferences } from '../backend-preferences'

describe('stored backend choices', () => {
  it('accepts every value that can apply on the operating system', () => {
    expect(backendChoices('llm', 'darwin')).toEqual(['auto', 'metal', 'cpu'])
    expect(backendChoices('image', 'linux')).toEqual(['auto', 'cuda', 'vulkan', 'cpu'])
    expect(backendChoices('stt', 'win32')).toEqual(['auto', 'cuda', 'vulkan', 'cpu'])
    expect(backendChoices('tts', 'win32')).toEqual(['auto', 'cuda', 'directml', 'webgpu', 'cpu'])
    expect(backendChoices('embeddings', 'linux')).toEqual(['auto', 'cuda', 'webgpu', 'cpu'])
  })

  it('discards invalid or unsupported saved values', () => {
    const result = normalizeBackendPreferences(
      { llm: 'vulkan', tts: 'webgpu', image: 'unknown' },
      'darwin'
    )
    expect(result.llm).toBe('auto')
    expect(result.tts).toBe('webgpu')
    expect(result.image).toBe('auto')
  })
})
