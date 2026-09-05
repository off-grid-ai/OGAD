// Integration test for the main-side vision guard (D16) — REAL toolChat + REAL
// LLMService (fake llama socket) + REAL llm.hasVision() driven by a REAL active-model.json
// + a REAL mmproj file on disk. Faked only at true boundaries: the engine socket + Electron's
// dir. No hasVision mock — the guard's single source of truth (the active model's projector)
// is exercised for real, and we assert the terminal artifact: whether the image data URL
// actually reaches the model in the request payload.
import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  installFakeActiveTextModel,
  startFakeLlamaServer,
  type FakeLlamaServer
} from './harness/fake-llama-server'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-vision-it-'))
// Pin the data dir before any main module loads: runtime-env resolves it from this variable, so an
// unpinned test would read and WRITE the developer's real profile (<cwd>/.offgrid).
process.env.OFFGRID_DATA_DIR = TMP_DIR
vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  },
  ipcMain: {
    on: () => undefined,
    removeListener: () => undefined,
    handle: () => undefined,
    removeHandler: () => undefined
  }
}))

import { toolChat } from '../tools'
import { llm } from '../llm'
import { modelsDir } from '../runtime-env'

let fake: FakeLlamaServer
let imgPath: string
let stopApplication: (() => Promise<void>) | undefined

beforeAll(async () => {
  // The selected model is installed through the one durable selection the real shared inventory
  // reads, before the first inventory refresh; each test only decides whether its projector file exists.
  installFakeActiveTextModel(TMP_DIR)
  fake = await startFakeLlamaServer()
  const application = await import('../composition/application')
  await application.startDesktopApplication()
  stopApplication = application.stopDesktopApplication
  const svc = llm as unknown as { port: number; initialized: boolean; paused: boolean }
  svc.port = fake.port
  svc.initialized = true
  svc.paused = false
  fs.mkdirSync(modelsDir(), { recursive: true })
  // A real (tiny) image file the guard reads + base64-embeds when vision is on.
  imgPath = path.join(TMP_DIR, 'shot.png')
  fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])) // PNG magic bytes
})
beforeEach(() => {
  fake.reset()
})
afterAll(async () => {
  await stopApplication?.()
  await fake.close()
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('vision guard (D16) — real hasVision() drives image embedding', () => {
  it('does NOT embed the image when the active model has NO vision projector', async () => {
    // The selected model's projector file is absent -> hasVision() false.
    installFakeActiveTextModel(TMP_DIR, { projector: false })
    fake.enqueue({ content: 'ok' })
    await toolChat('describe this', [], { images: [imgPath] })
    const body = JSON.stringify(fake.requests[0]?.messages ?? [])
    expect(body).not.toContain('data:image') // attachment dropped for a text-only model
  })

  it('embeds the image when the active model HAS a vision projector present on disk', async () => {
    // The same selection with its projector file on disk -> hasVision() true.
    installFakeActiveTextModel(TMP_DIR)
    fake.enqueue({ content: 'A cat.' })
    const r = await toolChat('describe this', [], { images: [imgPath] })
    const body = JSON.stringify(fake.requests[0]?.messages ?? [])
    expect(body).toContain('data:image') // the attachment reached the vision model
    expect(r.answer).toBe('A cat.')
  })
})
