import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LLMService, SpeculativeDecodingMode } from '../../llm'
import { MTP_COMPANIONS, catalogEntryInstalled, visionStatus } from '../../models/catalog-logic'
import { readGgufMtpSupport } from '../../models/gguf-metadata'

const companion = MTP_COMPANIONS['unsloth/Qwen3.8-27B-GGUF']
const primary = 'Qwen3.8-27B-UD-Q4_K_M.gguf'

// A small GGUF metadata fixture on real disk. The sidecar is sparse, so its
// expected file size is faithful without allocating or reading model weights.
function gguf(file: string, embeddedMtp: boolean, size = 1024, metadataPadding = 0): void {
  const u32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32LE(value)
    return buffer
  }
  const u64 = (value: number): Buffer => {
    const buffer = Buffer.alloc(8)
    buffer.writeBigUInt64LE(BigInt(value))
    return buffer
  }
  const str = (value: string): Buffer =>
    Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)])
  const architecture = /gemma-4/i.test(file)
    ? path.basename(file).startsWith('mtp-') ? 'gemma4-assistant' : 'gemma4'
    : 'qwen35'
  const values = [Buffer.concat([str('general.architecture'), u32(8), str(architecture)])]
  if (metadataPadding) values.push(Buffer.concat([str('tokenizer.chat_template'), u32(8), str('x'.repeat(metadataPadding))]))
  if (embeddedMtp) values.push(Buffer.concat([str(`${architecture}.nextn_predict_layers`), u32(4), u32(1)]))
  fs.writeFileSync(
    file,
    Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(values.length), ...values])
  )
  fs.truncateSync(file, size)
}

describe('MTP installation and persisted launch contract', () => {
  let profile: string
  const previousDataDir = process.env.OFFGRID_DATA_DIR

  beforeEach(() => {
    profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-mtp-')))
    fs.mkdirSync(path.join(profile, 'models'))
    process.env.OFFGRID_DATA_DIR = profile
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
    else process.env.OFFGRID_DATA_DIR = previousDataDir
    fs.rmSync(profile, { recursive: true, force: true })
  })

  async function load(
    selected = primary,
    embeddedMtp = false,
    speculativeDecoding: SpeculativeDecodingMode = 'mtp'
  ): Promise<LLMService> {
    const models = path.join(profile, 'models')
    gguf(path.join(models, selected), embeddedMtp)
    const { importLocalModel, setActiveModel } = await import('../../models-manager')
    const imported = await importLocalModel(path.join(models, selected))
    expect(imported.success).toBe(true)
    expect((await setActiveModel(imported.id!)).success).toBe(true)
    const { LLMService } = await import('../../llm')
    const service = new LLMService()
    await service.pause()
    await service.setSettings(
      {
        speculativeDecoding,
        draftModel: 'unrelated.gguf',
        gpuLayers: 99,
        ctxSize: 8192,
        kvCacheType: 'q4_0',
        flashAttn: true
      },
      { emitSync: false }
    )
    return new LLMService()
  }

  it('loads the matching sidecar after restart and keeps the unrelated draft out of the engine', async () => {
    const sidecar = path.join(profile, 'models', companion.name)
    gguf(sidecar, true, companion.sizeBytes)
    const service = await load()
    expect(service.getSettings()).toMatchObject({ supportsMtp: true, speculativeDecoding: 'mtp' })
    const args = service.launchArgs()
    expect(args).toEqual(
      expect.arrayContaining(['--spec-type', 'draft-mtp', '--spec-draft-model', sidecar])
    )
    expect(args[args.indexOf('--spec-draft-n-max') + 1]).toBe('2')
    expect(args[args.indexOf('--spec-draft-ngl') + 1]).toBe('99')
    expect(args).not.toContain('unrelated.gguf')
  })

  it('keeps embedded MTP working without loading an unrelated or unnecessary draft', async () => {
    const service = await load(primary, true)
    expect(service.getSettings().supportsMtp).toBe(true)
    expect(service.launchArgs()).toContain('draft-mtp')
    expect(service.launchArgs()).not.toContain('--spec-draft-model')
  })

  it('recognizes prediction heads after large tokenizer metadata', () => {
    const model = path.join(profile, 'models', 'late-mtp.gguf')
    gguf(model, true, 5 * 1024 * 1024, 4 * 1024 * 1024)
    expect(readGgufMtpSupport(model, fs)).toBe(true)
  })

  it('keeps the user draft token limit after restart and can return to Auto', async () => {
    const service = await load('Qwen3.5-9B-Q4_K_M.gguf', true)
    await service.pause()
    await service.setSettings({ speculativeDraftMax: 6 }, { emitSync: false })
    const { LLMService } = await import('../../llm')
    const restarted = new LLMService()
    expect(restarted.getSettings().speculativeDraftMax).toBe(6)
    await restarted.pause()
    await restarted.setSettings({ speculativeDraftMax: 0 }, { emitSync: false })
    expect(new LLMService().getSettings().speculativeDraftMax).toBe(0)
  })

  it.each([-1, 17, 2.5, NaN])('rejects an invalid draft token limit (%s)', async (limit) => {
    const service = await load(primary, true)
    await service.pause()
    await expect(service.setSettings({ speculativeDraftMax: limit }, { emitSync: false }))
      .rejects.toThrow('Draft token limit')
    expect(service.getSettings().speculativeDraftMax).toBe(0)
  })

  it('uses the installed MTP companion even when the target also declares native heads', async () => {
    const sidecar = path.join(profile, 'models', companion.name)
    gguf(sidecar, true, companion.sizeBytes)
    const service = await load(primary, true)
    const args = service.launchArgs()
    expect(args[args.indexOf('--spec-draft-model') + 1]).toBe(sidecar)
  })

  it('does not apply the selected model MTP setting to a runtime specialist', async () => {
    const service = await load(primary, true)
    gguf(path.join(profile, 'models', 'specialist.gguf'), false)
    service.useRuntimeModel({ id: 'local:specialist', primary: 'specialist.gguf', mmproj: null })
    expect(service.launchArgs()).not.toContain('draft-mtp')
    service.restoreSelectedModel()
    expect(service.launchArgs()).toContain('draft-mtp')
  })

  it.each(['missing', 'truncated', 'no-head', 'wrong-model'])(
    'does not enable MTP for a %s companion',
    async (condition) => {
      if (condition !== 'missing') {
        gguf(
          path.join(profile, 'models', companion.name),
          condition !== 'no-head',
          condition === 'truncated' ? 1024 : companion.sizeBytes
        )
      }
      const service = await load(condition === 'wrong-model' ? 'Qwen3.5-9B-Q4_K_M.gguf' : primary)
      expect(service.getSettings()).toMatchObject({
        supportsMtp: false,
        speculativeDecoding: 'off'
      })
      expect(service.launchArgs()).not.toContain('draft-mtp')
    }
  )

  it('does not offer the Qwen MTP companion to Bonsai Prism', async () => {
    gguf(path.join(profile, 'models', companion.name), true, companion.sizeBytes)
    const service = await load('Ternary-Bonsai-2-27B-PQ2_0.gguf')
    expect(service.getSettings()).toMatchObject({ supportsMtp: false, speculativeDecoding: 'off' })
    expect(service.launchArgs()).not.toContain('--spec-type')
    expect(service.launchArgs()).not.toContain('--spec-draft-model')
  })

  it.each([
    ['unsloth/gemma-4-E4B-it-GGUF', 'gemma-4-E4B-it-Q4_K_M.gguf'],
    ['unsloth/gemma-4-12b-it-GGUF', 'gemma-4-12b-it-Q4_K_M.gguf']
  ] as const)('offers %s MTP only after its matching companion is installed', async (id, selected) => {
    const { desktopCatalog } = await import('../../models-manager')
    const { LLMService } = await import('../../llm')
    const service = await load(selected, false, 'off')
    const file = MTP_COMPANIONS[id]
    const entry = (await desktopCatalog()).find((model) => model.id === id)
    expect(entry?.files).toContainEqual(file)
    expect(visionStatus(entry!, (name) => fs.existsSync(path.join(profile, 'models', name))))
      .toMatchObject({ supportsMtp: true, mtpInstalled: false })
    expect(service.getSettings()).toMatchObject({ supportsMtp: false, speculativeDecoding: 'off' })

    // Real, sparse metadata files exercise installation readiness without downloading weights.
    const wrong = MTP_COMPANIONS[id.includes('E4B')
      ? 'unsloth/gemma-4-12b-it-GGUF' : 'unsloth/gemma-4-E4B-it-GGUF']
    gguf(path.join(profile, 'models', wrong.name), true, wrong.sizeBytes)
    expect(service.getSettings().supportsMtp).toBe(false)
    const sidecar = path.join(profile, 'models', file.name)
    gguf(sidecar, true, file.sizeBytes - 1)
    expect(service.getSettings().supportsMtp).toBe(false)
    gguf(sidecar, true, file.sizeBytes)
    expect(visionStatus(entry!, (name) => fs.existsSync(path.join(profile, 'models', name))))
      .toMatchObject({ mtpInstalled: true })
    await service.pause()
    await service.setSettings({ speculativeDecoding: 'mtp' }, { emitSync: false })
    expect(new LLMService().getSettings()).toMatchObject({ supportsMtp: true, speculativeDecoding: 'mtp' })

    fs.unlinkSync(sidecar)
    expect(new LLMService().getSettings()).toMatchObject({ supportsMtp: false, speculativeDecoding: 'off' })
  })

  it.each([primary, 'Ternary-Bonsai-2-27B-PQ2_0.gguf'])(
    'preserves N-gram decoding for %s without adding an MTP companion',
    async (selected) => {
      gguf(path.join(profile, 'models', companion.name), true, companion.sizeBytes)
      const service = await load(selected, false, 'ngram')
      expect(service.getSettings().speculativeDecoding).toBe('ngram')
      const args = service.launchArgs()
      expect(args[args.indexOf('--spec-type') + 1]).toBe('ngram-cache')
      expect(args).not.toContain('--spec-draft-model')
      expect(args).not.toContain('--spec-draft-n-max')
    }
  )

  it('offers companion repair while leaving the main model installed', async () => {
    const { desktopCatalog } = await import('../../models-manager')
    const entry = (await desktopCatalog()).find((model) => model.id === 'unsloth/Qwen3.8-27B-GGUF')!
    expect(entry.files.some((file) => file.name === companion.name && file.role === 'aux')).toBe(
      true
    )
    const present = (name: string): boolean => name !== companion.name
    expect(catalogEntryInstalled(entry, present, () => false)).toBe(true)
    expect(visionStatus(entry, present)).toMatchObject({ supportsMtp: true, mtpInstalled: false })
    expect(visionStatus(entry, () => true)).toMatchObject({ supportsMtp: true, mtpInstalled: true })
  })
})
