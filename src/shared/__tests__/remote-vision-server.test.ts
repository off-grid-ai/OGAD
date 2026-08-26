import { describe, expect, it } from 'vitest'
import {
  parseRemoteVisionModelId,
  remoteVisionApiBase,
  remoteVisionEndpoint,
  remoteVisionInventoryModels,
  remoteVisionModelId,
  remoteVisionProviderForEndpoint
} from '../remote-vision-server'

describe('remoteVisionEndpoint', () => {
  it.each([
    ['ollama', 'http://127.0.0.1:11434/v1'],
    ['lmstudio', 'http://127.0.0.1:1234/v1'],
    ['ogad', 'http://127.0.0.1:7878/v1']
  ] as const)('uses the Mobile-compatible default for %s', (provider, expected) => {
    expect(remoteVisionEndpoint(provider, '')).toBe(expected)
  })

  it('normalizes a custom OpenAI-compatible base URL', () => {
    expect(remoteVisionEndpoint('custom', 'https://models.example/v1///')).toBe(
      'https://models.example/v1'
    )
  })

  it('keeps local inference free of a remote endpoint', () => {
    expect(remoteVisionEndpoint('local', 'https://models.example/v1')).toBe('')
  })
})

describe('remote server form normalization', () => {
  it('adds the OpenAI-compatible API prefix only when it is missing', () => {
    expect(remoteVisionApiBase('http://192.168.1.50:7878')).toBe('http://192.168.1.50:7878/v1')
    expect(remoteVisionApiBase('https://models.example/v1/')).toBe('https://models.example/v1')
  })

  it('keeps provider detection internal to the connection owner', () => {
    expect(remoteVisionProviderForEndpoint('http://localhost:11434/v1')).toBe('ollama')
    expect(remoteVisionProviderForEndpoint('https://openrouter.ai/api/v1')).toBe('openrouter')
    expect(remoteVisionProviderForEndpoint('https://models.example/v1')).toBe('custom')
  })
})

describe('remote model inventory ids', () => {
  it('round-trips server and model ids without collisions', () => {
    const id = remoteVisionModelId('home:server', 'google/gemma 4:e12b')
    expect(parseRemoteVisionModelId(id)).toEqual({
      serverId: 'home:server',
      modelId: 'google/gemma 4:e12b'
    })
  })

  it('rejects local and malformed ids', () => {
    expect(parseRemoteVisionModelId('google/gemma-4')).toBeNull()
    expect(parseRemoteVisionModelId('remote-vision:only-one-part')).toBeNull()
  })

  it('projects saved servers into available remote vision models', () => {
    expect(
      remoteVisionInventoryModels([
        {
          id: 'home',
          name: 'Home server',
          provider: 'custom',
          endpoint: 'https://models.example/v1',
          model: 'google/gemma-4',
          hasApiKey: true
        }
      ])
    ).toEqual([
      expect.objectContaining({
        id: 'remote-vision:home:google%2Fgemma-4',
        name: 'google/gemma-4',
        kind: 'vision',
        org: 'Home server',
        files: [],
        tags: ['Remote'],
        remoteServerId: 'home'
      })
    ])
  })
})
