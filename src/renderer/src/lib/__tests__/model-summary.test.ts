import { describe, it, expect } from 'vitest'
import {
  admitThinkingRequest,
  formatContextWindow,
  resolveActiveTextModel,
  resolveModelName
} from '../model-summary'

describe('formatContextWindow', () => {
  it('formats power-of-two token windows as compact K labels', () => {
    expect(formatContextWindow(4096)).toBe('4K')
    expect(formatContextWindow(8192)).toBe('8K')
    expect(formatContextWindow(32768)).toBe('32K')
    expect(formatContextWindow(131072)).toBe('128K')
  })

  it('shows small windows verbatim and omits unknown/zero', () => {
    expect(formatContextWindow(512)).toBe('512')
    expect(formatContextWindow(0)).toBeNull()
    expect(formatContextWindow(undefined)).toBeNull()
    expect(formatContextWindow(null)).toBeNull()
  })
})

describe('resolveModelName', () => {
  const models = [
    { id: 'qwen3-vl-2b', name: 'Qwen3-VL 2B' },
    { id: 'gemma-4-e2b', name: 'Gemma 4 E2B' }
  ]

  it('maps an active id to its display name', () => {
    expect(resolveModelName(models, 'qwen3-vl-2b')).toBe('Qwen3-VL 2B')
  })

  it('falls back to the id for an unknown model, null for no active id', () => {
    expect(resolveModelName(models, 'just-imported.gguf')).toBe('just-imported.gguf')
    expect(resolveModelName(models, null)).toBeNull()
    expect(resolveModelName(models, undefined)).toBeNull()
  })
})

describe('admitThinkingRequest', () => {
  it('admits thinking only when the active runtime explicitly supports it', () => {
    expect(admitThinkingRequest(true, 'Qwen', true)).toBe(true)
    expect(admitThinkingRequest(true, 'SmolVLM', false)).toBe(false)
    expect(admitThinkingRequest(true, 'Unknown model', null)).toBe(false)
    expect(admitThinkingRequest(true, null, true)).toBe(false)
  })

  it('keeps a disabled preference disabled', () => {
    expect(admitThinkingRequest(false, 'Qwen', true)).toBe(false)
  })
})

describe('resolveActiveTextModel', () => {
  const models = [
    { id: 'gemma', name: 'Gemma 4 E4B', capabilities: { thinking: false } },
    {
      id: 'remote:openrouter:stealth/ox-alpha',
      name: 'stealth/ox-alpha',
      remoteServerId: 'openrouter',
      capabilities: { thinking: true }
    }
  ]

  it('projects the active remote text model over the loaded local model', () => {
    expect(resolveActiveTextModel(models, 'remote:openrouter:stealth/ox-alpha')).toEqual({
      name: 'stealth/ox-alpha',
      remote: true,
      thinking: true
    })
  })

  it('uses the local model when no remote text model is active', () => {
    expect(resolveActiveTextModel(models, 'gemma')).toEqual({
      name: 'Gemma 4 E4B',
      remote: false,
      thinking: false
    })
  })

  it('keeps missing thinking evidence unknown', () => {
    expect(resolveActiveTextModel([{ id: 'smol', name: 'SmolVLM' }], 'smol')).toEqual({
      name: 'SmolVLM',
      remote: false,
      thinking: null
    })
  })

  it('uses only the canonical selected text identity when local and remote models are active', () => {
    expect(resolveActiveTextModel(models, 'gemma')).toEqual({
      name: 'Gemma 4 E4B',
      remote: false,
      thinking: false
    })
  })
})
