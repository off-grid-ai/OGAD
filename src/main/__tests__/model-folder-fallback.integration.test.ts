import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { speechCapabilities } from '@offgrid/executorch-speech'
import { flushDiagnosticLog } from '../diagnostics-log'
import { prepareVoiceAssets } from '../tts'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureRuntime, modelsDir } from '../runtime-env'
import { addModelScanFolder, removeModelScanFolder } from '../model-storage-choice'
import { modelReadDirectories, resolveModelAsset, resolveModelPackage } from '../model-paths'
import { ActiveModalityStore, getActiveModal } from '../active-models'
import { listImageModels, resolveTaesd } from '../imagegen'
import { whisperModel, smallWhisperModel } from '../transcription/whisper-cli'
import { CATALOG } from '@offgrid/models'
import {
  listInstalled,
  deleteModel,
  activateModel,
  getCatalog,
  getLocalModels,
  getActiveModel,
  downloadModel,
  setActiveModel,
  getVisionStatuses,
  getTransferableModel,
  BONSAI_2
} from '../models-manager'
import { leaveModelStorage } from '../model-storage-move'
import {
  readModelStorageChoice,
  readPendingModelCleanup,
  readModelScanFolders
} from '../model-storage-choice'
import { LLMService } from '../llm'
import { MTP_COMPANIONS } from '../models/catalog-logic'
import { readDownloaded } from '../downloaded-models'
import { taesdFilename } from '../../shared/image-defaults'

let profile: string
let oldRoot: string
let newRoot: string
function asset(root: string, name: string, value = 'synthetic model fixture'): string {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
  return fs.realpathSync(file)
}
beforeEach(() => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-folder-fallback-')))
  oldRoot = path.join(profile, 'old')
  newRoot = path.join(profile, 'new')
  fs.mkdirSync(oldRoot)
  fs.mkdirSync(newRoot)
  configureRuntime({ dataDir: profile, modelsDir: newRoot })
  addModelScanFolder(profile, oldRoot)
})
afterEach(async () => {
  await flushDiagnosticLog()
  configureRuntime({ dataDir: undefined, modelsDir: undefined })
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('models left in their previous folder', () => {
  it('copies metadata on Leave files and keeps chat, settings, registry and MTP after restart', async () => {
    const id = 'unsloth/gemma-4-E4B-it-GGUF'
    const entry = CATALOG.find((model) => model.id === id)!
    const primary = entry.files.find((file) => file.role === 'primary')!.name
    for (const file of entry.files) asset(oldRoot, file.name, `GGUF${'x'.repeat(1024)}`)
    const companion = MTP_COMPANIONS[id]
    const str = (value: string): Buffer => {
      const length = Buffer.alloc(8)
      length.writeBigUInt64LE(BigInt(Buffer.byteLength(value)))
      return Buffer.concat([length, Buffer.from(value)])
    }
    const u32 = (value: number): Buffer => {
      const bytes = Buffer.alloc(4)
      bytes.writeUInt32LE(value)
      return bytes
    }
    const header = Buffer.alloc(24)
    header.write('GGUF')
    header.writeUInt32LE(3, 4)
    header.writeBigUInt64LE(2n, 16)
    const sidecar = asset(oldRoot, companion.name)
    fs.writeFileSync(
      sidecar,
      Buffer.concat([
        header,
        str('general.architecture'),
        u32(8),
        str('gemma4-assistant'),
        str('gemma4-assistant.nextn_predict_layers'),
        u32(4),
        u32(1)
      ])
    )
    fs.truncateSync(sidecar, companion.sizeBytes)
    asset(oldRoot, 'active-model.json', JSON.stringify({ id, primary, mmproj: null }))
    const settings = { temperature: 0.23, ctxSize: 8192, topK: 17, speculativeDecoding: 'mtp' }
    asset(oldRoot, 'llm-settings.json', JSON.stringify(settings))
    asset(oldRoot, 'custom.gguf', `GGUF${'x'.repeat(1024)}`)
    asset(
      oldRoot,
      'downloaded-models.json',
      JSON.stringify([
        { id: 'fixture/custom', name: 'Custom', kind: 'text', files: ['custom.gguf'] }
      ])
    )
    asset(
      oldRoot,
      'local-models.json',
      JSON.stringify([
        { id: 'local:fixture', name: 'Local', kind: 'text', primary: 'local.gguf', sizeBytes: 1028 }
      ])
    )
    asset(oldRoot, 'local.gguf', `GGUF${'x'.repeat(1024)}`)
    asset(oldRoot, 'active-modalities.json', JSON.stringify({ image: 'fixture-image' }))
    for (const name of [
      'downloads.json',
      'remote-vision-server.json',
      'managed-storage-files.json',
      '.cache/executorch-speech/index.json'
    ])
      asset(oldRoot, name, '{}')
    leaveModelStorage(profile, oldRoot, newRoot)
    // Read the durable folder choice and create a new service, as startup does.
    configureRuntime({ dataDir: profile, modelsDir: readModelStorageChoice(profile)! })
    for (const name of [
      'downloads.json',
      'remote-vision-server.json',
      'managed-storage-files.json',
      '.cache/executorch-speech/index.json'
    ])
      expect(fs.readFileSync(path.join(newRoot, name), 'utf8')).toBe('{}')
    expect(readPendingModelCleanup(profile)).toEqual([])
    const restarted = new LLMService()
    expect(restarted.activeModelInfo()).toEqual({ id, vision: false })
    expect(restarted.getSettings()).toMatchObject({ ...settings, supportsMtp: true })
    expect(restarted.launchArgs()).toEqual(
      expect.arrayContaining(['-m', path.join(oldRoot, primary), '--spec-draft-model', sidecar])
    )
    expect(getActiveModel()).toBe(id)
    expect(await listInstalled()).toEqual(
      expect.arrayContaining([id, 'fixture/custom', 'local:fixture'])
    )
    expect(getLocalModels().filter((model) => model.id.startsWith('external:'))).toEqual([])
    expect(readDownloaded(newRoot)[0]!.files).toEqual([path.join(oldRoot, 'custom.gguf')])
    expect((await getTransferableModel('fixture/custom'))?.files).toEqual([
      { name: 'custom.gguf', path: path.join(oldRoot, 'custom.gguf'), sizeBytes: 1028 }
    ])
    const catalog = (await getCatalog()).models as Array<{ id: string; tags: string[] }>
    expect(catalog.filter((model) => model.id === id)).toHaveLength(1)
    expect(catalog.find((model) => model.id === id)!.tags).not.toContain('External')
    expect((await getVisionStatuses())[id]).toMatchObject({ mtpInstalled: true })
    expect(
      JSON.parse(fs.readFileSync(path.join(newRoot, 'active-modalities.json'), 'utf8'))
    ).toEqual({ image: 'fixture-image' })
    // Selecting the catalog row again must keep resolving its old weights.
    expect(await setActiveModel(id)).toEqual({ success: true })
    expect(new LLMService().activeModelInfo()?.id).toBe(id)
    expect(fs.readFileSync(path.join(oldRoot, 'llm-settings.json'), 'utf8')).toBe(
      JSON.stringify(settings)
    )
  })

  it('keeps local text and vision registry entries resolvable after Leave', async () => {
    const entries = [
      {
        id: 'local:text-fixture',
        name: 'Text',
        kind: 'text',
        primary: 'local-text.gguf',
        sizeBytes: 1028
      },
      {
        id: 'local:vision-fixture',
        name: 'Vision',
        kind: 'vision',
        primary: 'local-vision.gguf',
        mmproj: 'local-mmproj.gguf',
        sizeBytes: 1028
      }
    ]
    for (const name of ['local-text.gguf', 'local-vision.gguf', 'local-mmproj.gguf']) {
      asset(oldRoot, name, `GGUF${'x'.repeat(1024)}`)
    }
    asset(oldRoot, 'local-models.json', JSON.stringify(entries))
    leaveModelStorage(profile, oldRoot, newRoot)
    configureRuntime({ modelsDir: readModelStorageChoice(profile)! })
    expect(getLocalModels()).toEqual(
      expect.arrayContaining(
        entries.map((entry) => ({
          ...entry,
          primary: path.join(oldRoot, entry.primary),
          ...(entry.mmproj ? { mmproj: path.join(oldRoot, entry.mmproj) } : {})
        }))
      )
    )
    expect(await listInstalled()).toEqual(expect.arrayContaining(entries.map((entry) => entry.id)))
    for (const entry of entries) {
      const model = await getTransferableModel(entry.id)
      expect(model?.files.map((file) => file.path)).toEqual(
        [entry.primary, entry.mmproj]
          .filter((name): name is string => !!name)
          .map((name) => path.join(oldRoot, name))
      )
    }
  })

  it('reads scan-folder assets with an offline chosen folder and refuses downloads clearly', async () => {
    const file = asset(oldRoot, 'ggml-tiny.bin')
    fs.rmdirSync(newRoot)
    expect(resolveModelAsset('ggml-tiny.bin')).toBe(file)
    expect(whisperModel()).toBe(file)
    const entry = CATALOG.find((model) => model.kind === 'text')!
    await expect(downloadModel(entry.id)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Connect the drive or choose another folder.')
    })
    expect(fs.existsSync(newRoot)).toBe(false)
  })

  it('keeps scan-folder chat models in the catalog, including Desktop-only entries', async () => {
    for (const entry of [CATALOG.find((model) => model.kind === 'text')!, BONSAI_2]) {
      for (const file of entry.files) asset(oldRoot, file.name, `GGUF${'x'.repeat(1024)}`)
      expect(await listInstalled()).toContain(entry.id)
    }
    expect(getLocalModels().filter((model) => model.id.startsWith('external:'))).toEqual([])
  })

  it('keeps the folder choice and metadata intact when the destination has conflicting metadata', () => {
    // The earlier metadata copy must be removed if a later metadata file conflicts.
    asset(oldRoot, 'active-model.json', JSON.stringify({ id: 'fixture', primary: 'fixture.gguf' }))
    asset(oldRoot, 'llm-settings.json', JSON.stringify({ temperature: 0.2 }))
    asset(newRoot, 'llm-settings.json', 'existing destination settings')
    expect(() => leaveModelStorage(profile, oldRoot, newRoot)).toThrow(
      'already contains llm-settings.json'
    )
    expect(readModelStorageChoice(profile)).toBeNull()
    expect(readModelScanFolders(profile)).toEqual([oldRoot])
    expect(fs.existsSync(path.join(newRoot, 'active-model.json'))).toBe(false)
    expect(fs.readFileSync(path.join(newRoot, 'llm-settings.json'), 'utf8')).toBe(
      'existing destination settings'
    )
    expect(
      JSON.parse(fs.readFileSync(path.join(oldRoot, 'active-model.json'), 'utf8'))
    ).toMatchObject({ id: 'fixture' })
  })

  it('prepares a complete indexed voice cache from a scan folder while storage is offline', async () => {
    const voice = speechCapabilities.voices.find(
      (entry) => !['en-us', 'en-gb'].includes(entry.language)
    )!
    expect(voice).toBeDefined()
    const index: Record<string, { url: string; bytes: number }> = {}
    for (const [kind, url] of Object.entries(voice.assets)) {
      if (typeof url !== 'string') continue
      const name = `${kind}-${createHash('sha256').update(url).digest('hex').slice(0, 12)}-${path.basename(new URL(url).pathname)}`
      asset(oldRoot, `.cache/executorch-speech/${name}`, 'voice fixture')
      index[name] = { url, bytes: Buffer.byteLength('voice fixture') }
    }
    const contents = JSON.stringify(index)
    asset(oldRoot, '.cache/executorch-speech/index.json', contents)
    fs.rmdirSync(newRoot)
    await expect(prepareVoiceAssets(voice.id)).resolves.toBeUndefined()
    expect(fs.existsSync(newRoot)).toBe(false)
    expect(fs.readFileSync(path.join(oldRoot, '.cache/executorch-speech/index.json'), 'utf8')).toBe(
      contents
    )
    const file = Object.keys(index)[0]!
    fs.unlinkSync(path.join(oldRoot, '.cache/executorch-speech', file))
    await expect(prepareVoiceAssets(voice.id)).rejects.toThrow(
      'Connect the drive or choose another folder.'
    )
    expect(fs.existsSync(newRoot)).toBe(false)
  })

  it('lists catalog media from the old folder, activates it, and refuses to delete its files', async () => {
    for (const kind of ['image', 'voice', 'transcription']) {
      const entry = CATALOG.find(
        (model) => model.kind === kind && model.files.length > 0 && model.runtime !== 'mflux'
      )!
      expect(entry).toBeDefined()
      for (const file of entry.files) asset(oldRoot, file.name)
      expect(await listInstalled()).toContain(entry.id)
      expect(await activateModel(entry.id)).toEqual({ success: true })
      expect(await deleteModel(entry.id)).toMatchObject({ success: false })
      for (const file of entry.files)
        expect(fs.existsSync(path.join(oldRoot, file.name))).toBe(true)
    }
  })

  it('keeps image and transcription models available after changing the base folder', () => {
    asset(oldRoot, 'dreamshaper-xl-v2-turbo-Q8_0.gguf')
    const tiny = asset(oldRoot, 'ggml-tiny.bin')
    const large = asset(oldRoot, 'ggml-large-v3-turbo.bin')
    const decoderName = taesdFilename('dreamshaper-xl-v2-turbo-Q8_0.gguf')
    const decoder = asset(oldRoot, decoderName)
    expect(listImageModels()).toContain('dreamshaper-xl-v2-turbo-Q8_0.gguf')
    expect(whisperModel()).toBe(large)
    expect(smallWhisperModel()).toBe(tiny)
    expect(resolveTaesd('dreamshaper-xl-v2-turbo-Q8_0.gguf')).toBe(decoder)
    expect(modelsDir()).toBe(newRoot)
    expect(fs.readdirSync(newRoot)).toEqual([])
  })

  it('preserves selected modalities and saves later choices only in the new folder', () => {
    const old = new ActiveModalityStore(() => oldRoot)
    old.set('image', 'dreamshaper-xl-v2-turbo-Q8_0.gguf')
    old.set('transcription', 'ggml-tiny.bin')
    asset(oldRoot, 'ggml-tiny.bin')
    asset(oldRoot, 'ggml-large-v3-turbo.bin')
    expect(whisperModel()).toBe(fs.realpathSync(path.join(oldRoot, 'ggml-tiny.bin')))
    const current = new ActiveModalityStore()
    current.set('speech', 'kokoro')
    expect(getActiveModal('image')).toBe(old.get('image'))
    current.set('image', null)
    expect(getActiveModal('image')).toBeNull()
    expect(old.get('image')).toBe('dreamshaper-xl-v2-turbo-Q8_0.gguf')
    expect(old.get('speech')).toBeNull()
  })

  it('gives the new folder priority and removes only the old folder reference', () => {
    asset(oldRoot, 'ggml-base.bin', 'old')
    const newer = asset(newRoot, 'ggml-base.bin', 'new')
    expect(resolveModelAsset('ggml-base.bin')).toBe(newer)
    removeModelScanFolder(profile, fs.realpathSync(oldRoot))
    expect(modelReadDirectories()).toEqual([newRoot])
    expect(fs.readFileSync(path.join(oldRoot, 'ggml-base.bin'), 'utf8')).toBe('old')
  })

  it('uses a complete voice package and does not mix partial installations', () => {
    const names = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_fp16.onnx']
    const oldCache = path.join(oldRoot, '.cache/onnx-community/Kokoro-82M-v1.0-ONNX')
    const newCache = path.join(newRoot, '.cache/onnx-community/Kokoro-82M-v1.0-ONNX')
    for (const name of names) asset(oldCache, name)
    asset(newCache, names[0]!)
    expect(resolveModelPackage(names, [newCache, oldCache])).toBe(fs.realpathSync(oldCache))
    fs.unlinkSync(path.join(oldCache, names[0]!))
    expect(resolveModelPackage(names, [newCache, oldCache])).toBeNull()
  })

  it('ignores a missing drive and rejects traversal and links outside the folder', () => {
    const secret = asset(profile, 'outside.bin')
    fs.symlinkSync(secret, path.join(oldRoot, 'linked.bin'))
    expect(resolveModelAsset('linked.bin')).toBeNull()
    expect(resolveModelAsset('../outside.bin')).toBeNull()
    expect(resolveModelAsset('..\\outside.bin')).toBeNull()
    expect(resolveModelAsset(secret)).toBeNull()
    fs.rmSync(oldRoot, { recursive: true })
    const available = asset(newRoot, 'ggml-base.bin')
    expect(whisperModel()).toBe(available)
    expect(fs.existsSync(oldRoot)).toBe(false)
  })
})
