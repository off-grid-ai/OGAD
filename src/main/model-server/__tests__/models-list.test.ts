import { describe, it, expect } from 'vitest'
import { tagLlmEntry, tagLlmEntries, modelEntry, ollamaMirror, specialistModelEntries, installedTextModelEntries } from '../models-list'

describe('remote specialist discovery', () => {
  it('advertises installed grounding and decision models without exposing missing models or Chat twice', () => {
    const catalog = [
      { id: 'ui-mate', name: 'UI-Mate', kind: 'computer_use' },
      { id: 'kev', name: 'Kev', kind: 'computer_use', tags: ['Decision'] },
      { id: 'missing', name: 'Missing', kind: 'computer_use' },
      { id: 'chat', name: 'Chat', kind: 'chat' }
    ]
    expect(specialistModelEntries(catalog, ['ui-mate', 'kev', 'chat'], 1)).toEqual([
      { id: 'ui-mate', name: 'UI-Mate', kind: 'vision', object: 'model', owned_by: 'off-grid', created: 1, capabilities: ['vision'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
      { id: 'kev', name: 'Kev', kind: 'chat', object: 'model', owned_by: 'off-grid', created: 1, capabilities: [], architecture: { input_modalities: ['text'], output_modalities: ['decisions'] } }
    ])
  })
})

describe('tagLlmEntry', () => {
  it('tags an entry with multimodal capability as vision', () => {
    expect(tagLlmEntry({ id: 'm', capabilities: ['multimodal'] })).toEqual({
      id: 'm',
      capabilities: ['multimodal'],
      kind: 'vision'
    })
  })

  it('tags an entry advertising vision as vision', () => {
    expect(tagLlmEntry({ id: 'm', capabilities: ['vision'] }).kind).toBe('vision')
  })

  it('tags an entry with neither as chat', () => {
    expect(tagLlmEntry({ id: 'm', capabilities: ['completion'] }).kind).toBe('chat')
  })

  it('tags an entry with no capabilities array as chat', () => {
    expect(tagLlmEntry({ id: 'm' }).kind).toBe('chat')
    expect(tagLlmEntry({ id: 'm', capabilities: 'nope' }).kind).toBe('chat')
  })

  it('preserves the original fields', () => {
    expect(tagLlmEntry({ id: 'm', object: 'model', extra: 1 })).toMatchObject({
      id: 'm',
      object: 'model',
      extra: 1
    })
  })
})

describe('tagLlmEntries', () => {
  it('tags every entry', () => {
    const out = tagLlmEntries([
      { id: 'a', capabilities: ['vision'] },
      { id: 'b', capabilities: [] }
    ])
    expect(out.map((m) => m.kind)).toEqual(['vision', 'chat'])
  })

  it('returns an empty list unchanged', () => {
    expect(tagLlmEntries([])).toEqual([])
  })
})

describe('modelEntry', () => {
  it('builds a canonical entry', () => {
    expect(modelEntry('kokoro', 'speech', 1000)).toEqual({
      id: 'kokoro',
      object: 'model',
      created: 1000,
      owned_by: 'off-grid',
      kind: 'speech'
    })
  })

  it('folds in extra fields (e.g. voices)', () => {
    expect(modelEntry('kokoro', 'speech', 1000, { voices: ['a', 'b'] })).toMatchObject({
      id: 'kokoro',
      kind: 'speech',
      voices: ['a', 'b']
    })
  })
})

describe('ollamaMirror', () => {
  it('mirrors id + kind into the ollama shape', () => {
    const data = [
      { id: 'x', kind: 'chat' },
      { id: 'y', kind: 'image' }
    ]
    expect(ollamaMirror(data)).toEqual([
      { name: 'x', model: 'x', type: 'model', kind: 'chat' },
      { name: 'y', model: 'y', type: 'model', kind: 'image' }
    ])
  })

  it('mirrors an empty list', () => {
    expect(ollamaMirror([])).toEqual([])
  })
})


describe('downloaded chat inventory', () => {
  it('includes inactive downloaded chat models and excludes task, missing and remote entries', () => {
    const catalog = [
      { id: 'text', name: 'Text', kind: 'text' },
      { id: 'vision', name: 'Vision', kind: 'vision' },
      { id: 'missing', name: 'Missing', kind: 'text' },
      { id: 'kev', name: 'Kev', kind: 'computer_use' },
      { id: 'remote', name: 'Remote', kind: 'text', remoteServerId: 'server' }
    ]
    expect(installedTextModelEntries(catalog, ['text', 'vision', 'kev', 'remote'], 1)).toEqual([
      { id: 'text', name: 'Text', kind: 'chat', object: 'model', owned_by: 'off-grid', created: 1, capabilities: [] },
      { id: 'vision', name: 'Vision', kind: 'vision', object: 'model', owned_by: 'off-grid', created: 1, capabilities: ['vision'] }
    ])
  })
})
