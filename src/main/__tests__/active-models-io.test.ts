/** Real filesystem coverage for the canonical Desktop selection persistence port. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeModelRouteId } from '@offgrid/models'

import { DesktopModelSelectionPersistence } from '../model-selection-persistence'

let tmpDir: string
let store: DesktopModelSelectionPersistence

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-selections-'))
  store = new DesktopModelSelectionPersistence(() => tmpDir)
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('DesktopModelSelectionPersistence', () => {
  it('returns null only when the selection file is absent', () => {
    expect(store.read('image')).toBeNull()
  })

  it('raises a typed failure for corrupt selection state', () => {
    fs.writeFileSync(path.join(tmpDir, 'model-selections.json'), '{ invalid')
    expect(() => store.read('image')).toThrowError(
      expect.objectContaining({
        name: 'ModelSelectionPersistenceError',
        code: 'MODEL_SELECTION_CORRUPT',
        filePath: path.join(tmpDir, 'model-selections.json')
      })
    )
  })

  it('raises a typed failure when selection state cannot be read', () => {
    const selectionFile = path.join(tmpDir, 'model-selections.json')
    fs.writeFileSync(selectionFile, '{}')
    const read = fs.readFileSync.bind(fs)
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file, options) => {
      if (String(file) === selectionFile) throw denied
      return read(file, options as never)
    }) as typeof fs.readFileSync)
    try {
      expect(() => store.read('image')).toThrowError(
        expect.objectContaining({
          name: 'ModelSelectionPersistenceError',
          code: 'MODEL_SELECTION_READ_FAILED',
          filePath: selectionFile
        })
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('round-trips canonical route identities without losing the provider model id', () => {
    const routeId = encodeModelRouteId({
      adapterId: 'desktop.image',
      providerId: 'local',
      modelId: 'org/image-model'
    })
    store.write('image', routeId)
    store.projectLegacyModality('image', 'org/image-model')

    expect(store.readCanonical('image')).toBe(routeId)
    expect(store.projectedModelId('image')).toBe('org/image-model')
    expect(
      JSON.parse(fs.readFileSync(path.join(tmpDir, 'active-modalities.json'), 'utf8'))
    ).toEqual({ image: 'org/image-model' })
  })

  it('updates one projection without clobbering another and clears with null', () => {
    store.projectLegacyModality('image', 'image-1')
    store.projectLegacyModality('voice', 'voice-1')
    store.projectLegacyModality('image', null)

    expect(store.projectedModelId('image')).toBeNull()
    expect(store.projectedModelId('voice')).toBe('voice-1')
  })

  it('migrates a canonical legacy remote text route on first read', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'remote-vision-server.json'),
      JSON.stringify({
        activeServerId: 'server-1',
        servers: [{ id: 'server-1', provider: 'openai', model: 'gemini' }]
      })
    )
    const selected = store.read('text')
    expect(selected).toMatch(/^model-route:v1:/)
    expect(store.readCanonical('text')).toBe(selected)
  })
})
