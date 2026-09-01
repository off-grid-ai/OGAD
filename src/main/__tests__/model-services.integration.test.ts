/**
 * The Desktop composition root must project the same persisted selections through
 * the shared LLMService that the existing IPC model manager returns. The filesystem
 * is the only test boundary; catalog, inventory, selection codecs, and projections
 * are all production code.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CATALOG } from '@offgrid/models'

const previousDataDir = process.env.OFFGRID_DATA_DIR
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-services-'))
const modelDirectory = path.join(profile, 'models')

beforeAll(() => {
  process.env.OFFGRID_DATA_DIR = profile
  fs.mkdirSync(modelDirectory, { recursive: true })
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Desktop shared model-service composition', () => {
  it('uses one canonical inventory and active selection projection', async () => {
    const text = CATALOG.find(
      (model) =>
        (model.kind === 'text' || model.kind === 'vision') &&
        model.availability !== 'coming_soon' &&
        model.files.length > 0
    )
    const image = CATALOG.find(
      (model) =>
        model.kind === 'image' &&
        model.availability !== 'coming_soon' &&
        model.files.length > 0 &&
        model.runtime !== 'mflux'
    )
    if (!text || !image) throw new Error('The catalog needs text and image fixtures.')

    for (const model of [text, image]) {
      for (const file of model.files) {
        fs.writeFileSync(path.join(modelDirectory, file.name), Buffer.alloc(64, 1))
      }
    }
    const textPrimary = text.files.find((file) => file.role !== 'mmproj')?.name
    const textProjector = text.files.find((file) => file.role === 'mmproj')?.name ?? null
    if (!textPrimary) throw new Error('The text fixture needs a primary file.')
    fs.writeFileSync(
      path.join(modelDirectory, 'active-model.json'),
      JSON.stringify({ id: text.id, primary: textPrimary, mmproj: textProjector })
    )
    const imagePrimary = image.files.find((file) => file.role !== 'mmproj')?.name
    if (!imagePrimary) throw new Error('The image fixture needs a primary file.')
    fs.writeFileSync(
      path.join(modelDirectory, 'active-modalities.json'),
      JSON.stringify({ image: imagePrimary })
    )

    const manager = await import('../models-manager')
    const { desktopModelServices } = await import('../model-services')
    const inventory = await desktopModelServices.refresh()

    expect(inventory.find((model) => model.id === text.id)).toMatchObject({
      modality: 'text',
      source: 'local',
      installed: true,
      adapterId: 'desktop.llama'
    })
    expect(inventory.find((model) => model.id === image.id)).toMatchObject({
      modality: 'image',
      source: 'local',
      installed: true,
      adapterId: 'desktop.image'
    })
    expect(desktopModelServices.llm.active('text').selectedId).toBe(text.id)
    expect(desktopModelServices.llm.active('image').selectedId).toBe(image.id)
    expect(manager.getActiveModalities()).toMatchObject({ text: text.id, image: image.id })
    expect(await manager.getActiveModelIds()).toEqual(expect.arrayContaining([text.id, image.id]))
  })
})
