/**
 * Multimodal knowledge journey through the production IPC, extraction router, native adapters,
 * RAG engine, SQLite store, scoped chat prompt, deletion, and profile reopen. The local embedding,
 * vision, and speech executables are controlled at their process boundaries; Off Grid AI code stays real.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startFakeLlamaServer, type FakeLlamaServer } from './harness/fake-llama-server'
import { SYNTHETIC_PDF } from './fixtures/synthetic-pdf'

interface IpcEvent {
  sender: { send: (channel: string, payload: unknown) => void }
}
type IpcHandler = (event: IpcEvent, ...args: unknown[]) => unknown

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-multimodal-rag-'))
const FIXTURES_DIR = path.join(PROFILE_DIR, 'fixtures')
const BIN_DIR = path.join(PROFILE_DIR, 'bin')
const handlers = new Map<string, IpcHandler>()
const progressEvents: Array<{ channel: string; payload: unknown }> = []
const boundary = vi.hoisted(() => ({ selectedPaths: [] as string[] }))

vi.mock('electron', () => ({
  app: {
    getPath: () => PROFILE_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.40',
    on: () => undefined
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
    on: () => undefined
  },
  BrowserWindow: { fromWebContents: () => undefined },
  clipboard: { readText: () => '', writeText: () => undefined },
  systemPreferences: {
    isTrustedAccessibilityClient: () => true,
    getMediaAccessStatus: () => 'granted'
  },
  shell: { openExternal: async () => undefined, openPath: async () => '' },
  desktopCapturer: { getSources: async () => [] },
  dialog: {
    showOpenDialog: async () => ({
      canceled: boundary.selectedPaths.length === 0,
      filePaths: [...boundary.selectedPaths]
    })
  }
}))

vi.mock('@xenova/transformers', () => ({
  env: {},
  pipeline: async () => async (text: string) => {
    if (text.includes('FAIL_EMBED_AURORA')) throw new Error('synthetic embedding interruption')
    const normalized = text.toLowerCase()
    const keys = [
      'image_aurora',
      'video_aurora',
      'audio_aurora',
      'pdf_aurora',
      'docx_aurora',
      'text_aurora',
      'other_aurora'
    ]
    const data = new Float32Array(384)
    keys.forEach((key, index) => {
      data[index] = normalized.includes(key) ? 1 : 0
    })
    return { data }
  }
}))

vi.mock('@lancedb/lancedb', () => ({
  connect: async () => ({ tableNames: async () => [] })
}))

const event: IpcEvent = {
  sender: {
    send: (channel, payload) => progressEvents.push({ channel, payload })
  }
}
let fake: FakeLlamaServer

function handler(channel: string): IpcHandler {
  const registered = handlers.get(channel)
  expect(registered, `${channel} must be registered`).toBeTypeOf('function')
  return registered!
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return (await handler(channel)(event, ...args)) as T
}

async function bootApplicationModules(): Promise<void> {
  handlers.clear()
  const [{ setupIPC }, { setupRagIPC }, { llm }] = await Promise.all([
    import('../ipc'),
    import('../rag-ipc'),
    import('../llm')
  ])
  const service = llm as unknown as { port: number; initialized: boolean; paused: boolean }
  service.port = fake.port
  service.initialized = true
  service.paused = false
  setupIPC()
  setupRagIPC()
}

async function createDocx(filePath: string): Promise<void> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  )
  zip
    .folder('_rels')!
    .file(
      '.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    )
  zip
    .folder('word')!
    .file(
      'document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX_AURORA records the signed accessibility decision for the launch.</w:t></w:r></w:p></w:body></w:document>'
    )
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }))
}

function createNativeFixtures(): void {
  const ffmpeg = path.resolve('resources/bin/ffmpeg')
  const audio = path.join(FIXTURES_DIR, 'briefing.wav')
  const video = path.join(FIXTURES_DIR, 'walkthrough.mp4')
  execFileSync(ffmpeg, [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-y',
    audio
  ])
  execFileSync(ffmpeg, [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=#34D399:s=320x240:d=6',
    '-c:v',
    'mpeg4',
    '-y',
    video
  ])
}

beforeAll(async () => {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true })
  fs.mkdirSync(path.join(BIN_DIR, 'whisper'), { recursive: true })
  fs.mkdirSync(path.join(PROFILE_DIR, 'models'), { recursive: true })
  fs.symlinkSync(path.resolve('resources/bin/ffmpeg'), path.join(BIN_DIR, 'ffmpeg'))
  const whisper = path.join(BIN_DIR, 'whisper', 'whisper-cli')
  fs.writeFileSync(
    whisper,
    '#!/bin/sh\nprintf "%s\\n" "AUDIO_AURORA confirms the narrated release review is complete."\n'
  )
  fs.chmodSync(whisper, 0o755)
  fs.writeFileSync(path.join(PROFILE_DIR, 'models', 'ggml-base.bin'), 'synthetic model boundary')
  fs.writeFileSync(path.join(PROFILE_DIR, 'models', 'mmproj.gguf'), Buffer.from('gguf'))
  fs.writeFileSync(
    path.join(PROFILE_DIR, 'models', 'active-model.json'),
    JSON.stringify({ primary: 'vision-model.gguf', mmproj: 'mmproj.gguf' })
  )

  const { configureRuntime } = await import('../runtime-env')
  configureRuntime({ dataDir: PROFILE_DIR, binRoots: [BIN_DIR] })
  fake = await startFakeLlamaServer()
  await bootApplicationModules()
})

afterAll(async () => {
  const { getDB } = await import('../database')
  if (getDB().open) getDB().close()
  await fake.close()
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
})

describe('multimodal import, scoped answer, deletion, and reopen', () => {
  it('indexes every supported medium and rolls back failed files without cross-project leakage', async () => {
    const files = {
      text: path.join(FIXTURES_DIR, 'notes.md'),
      pdf: path.join(FIXTURES_DIR, 'decision.pdf'),
      docx: path.join(FIXTURES_DIR, 'memo.docx'),
      audio: path.join(FIXTURES_DIR, 'briefing.wav'),
      video: path.join(FIXTURES_DIR, 'walkthrough.mp4'),
      image: path.join(FIXTURES_DIR, 'diagram.png'),
      damaged: path.join(FIXTURES_DIR, 'damaged.pdf'),
      interrupted: path.join(FIXTURES_DIR, 'interrupted.md'),
      other: path.join(FIXTURES_DIR, 'other.md')
    }
    fs.writeFileSync(files.text, 'TEXT_AURORA says the desktop checklist owner is Maya.')
    fs.writeFileSync(files.pdf, SYNTHETIC_PDF)
    await createDocx(files.docx)
    createNativeFixtures()
    await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#34D399' }
    })
      .png()
      .toFile(files.image)
    fs.writeFileSync(files.damaged, 'not a valid PDF')
    fs.writeFileSync(files.interrupted, 'FAIL_EMBED_AURORA must roll back its document row.')
    fs.writeFileSync(files.other, 'OTHER_AURORA belongs only to the private sibling project.')

    const selectedProject = await invoke<string>('projects:create', { name: 'Aurora launch' })
    const otherProject = await invoke<string>('projects:create', { name: 'Private sibling' })
    await invoke('projects:update', selectedProject, { includeMemory: false })
    await invoke('projects:update', otherProject, { includeMemory: false })

    fake.enqueue({ content: 'VIDEO_AURORA shows the emerald release status board.' })
    fake.enqueue({ content: 'IMAGE_AURORA shows the signed launch architecture diagram.' })
    boundary.selectedPaths = [
      files.text,
      files.pdf,
      files.docx,
      files.audio,
      files.video,
      files.image,
      files.damaged,
      files.interrupted
    ]
    const selectedBatch = await invoke<{ added: number }>('projects:add-documents', selectedProject)
    expect(
      selectedBatch,
      JSON.stringify(progressEvents.filter(({ channel }) => channel === 'projects:index-progress'))
    ).toEqual({ added: 6 })

    boundary.selectedPaths = [files.other]
    expect(await invoke('projects:add-documents', otherProject)).toEqual({ added: 1 })

    const documents = await invoke<Array<{ id: number; name: string; kind: string }>>(
      'projects:list-documents',
      selectedProject
    )
    expect(new Set(documents.map(({ kind }) => kind))).toEqual(
      new Set(['text', 'pdf', 'docx', 'audio', 'video', 'image'])
    )
    expect(documents.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(['damaged.pdf', 'interrupted.md'])
    )
    expect(
      progressEvents.filter(
        ({ channel, payload }) =>
          channel === 'projects:index-progress' && (payload as { stage?: string }).stage === 'error'
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ payload: expect.objectContaining({ name: 'damaged.pdf' }) }),
        expect.objectContaining({ payload: expect.objectContaining({ name: 'interrupted.md' }) })
      ])
    )

    const conversationId = 'aurora-multimodal-chat'
    await invoke('rag:create-conversation', conversationId, 'Aurora evidence', selectedProject)
    fake.enqueue({ content: 'The architecture diagram records the signed launch plan.' })
    const answer = await invoke<{
      answer: string
      context: { sources: Array<{ name: string }> }
    }>(
      'rag:chat',
      'What does IMAGE_AURORA show?',
      'All',
      [],
      selectedProject,
      conversationId,
      false,
      'aurora-answer',
      false,
      []
    )
    expect(answer.answer).toBe('The architecture diagram records the signed launch plan.')
    expect(answer.context.sources[0]?.name).toBe('diagram.png')
    const prompt = JSON.stringify(fake.requests.at(-1)?.messages ?? [])
    expect(prompt).toContain('IMAGE_AURORA shows the signed launch architecture diagram')
    expect(prompt).not.toContain('OTHER_AURORA')
    await invoke('rag:add-message', conversationId, 'user', 'What does IMAGE_AURORA show?')
    await invoke('rag:add-message', conversationId, 'assistant', answer.answer)

    const imageDocument = documents.find(({ name }) => name === 'diagram.png')!
    await invoke('projects:delete-document', imageDocument.id)
    expect(fs.existsSync(files.image)).toBe(true)
    fake.enqueue({ content: 'The deleted image is no longer available as evidence.' })
    const afterDelete = await invoke<{ context: { sources: Array<{ name: string }> } }>(
      'rag:chat',
      'What does IMAGE_AURORA show now?',
      'All',
      [],
      selectedProject,
      conversationId,
      false,
      'aurora-after-delete',
      false,
      []
    )
    expect(afterDelete.context.sources.map(({ name }) => name)).not.toContain('diagram.png')
    expect(JSON.stringify(fake.requests.at(-1)?.messages ?? [])).not.toContain(
      'IMAGE_AURORA shows the signed launch architecture diagram'
    )

    const { getDB } = await import('../database')
    const db = getDB()
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM rag_documents WHERE project_id = ?')
        .get(selectedProject)
    ).toEqual({ count: 5 })
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM rag_chunks WHERE content LIKE '%FAIL_EMBED_AURORA%'"
        )
        .get()
    ).toEqual({ count: 0 })
    db.close()

    vi.resetModules()
    await bootApplicationModules()
    expect(await invoke('projects:list-documents', selectedProject)).toHaveLength(5)
    expect(await invoke('rag:get-messages', conversationId)).toEqual([
      expect.objectContaining({ role: 'user', content: 'What does IMAGE_AURORA show?' }),
      expect.objectContaining({ role: 'assistant', content: answer.answer })
    ])
    const reopenedDb = (await import('../database')).getDB()
    expect(
      reopenedDb
        .prepare("SELECT COUNT(*) AS count FROM rag_chunks WHERE content LIKE '%IMAGE_AURORA%'")
        .get()
    ).toEqual({ count: 0 })
  }, 60_000)
})
