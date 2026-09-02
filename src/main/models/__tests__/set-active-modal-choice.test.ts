import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeModelRouteId } from '@offgrid/models'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-modal-choice-'))

vi.mock('electron', () => ({
  app: { getPath: () => PROFILE_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

beforeAll(async () => {
  // The application composition root registers the real shared model services.
  const { configureRuntime } = await import('../../runtime-env')
  configureRuntime({ dataDir: PROFILE_DIR })
  await import('../../model-services')
})

afterAll(() => {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
})

describe('setActiveModalChoice normalizes the modality (D26)', () => {
  it.each(['voice', 'speech'])(
    'accepts the %s vocabulary and clears the same speech selection',
    async (kind) => {
      const { setActiveModalChoice } = await import('../../models-manager')
      await expect(setActiveModalChoice(kind, null)).resolves.toEqual({ success: true })
    }
  )

  it('keeps text selection under the dedicated chat-model operation', async () => {
    const { setActiveModalChoice } = await import('../../models-manager')
    await expect(setActiveModalChoice('text', null)).resolves.toEqual({
      success: false,
      error: 'use setActiveModel for the chat LLM (text/vision)'
    })
  })
})

describe('model display identity', () => {
  it('uses the canonical server route when remote native ids overlap', async () => {
    const { projectModelIdentity } = await import('../../models-manager')
    const routeId = encodeModelRouteId({
      adapterId: 'desktop.remote-chat',
      serverId: 'server-b',
      modelId: 'qwen'
    })

    expect(
      projectModelIdentity(routeId, [
        {
          id: 'remote-a',
          name: 'Qwen on A',
          remoteServerId: 'server-a',
          remoteModelId: 'qwen'
        },
        {
          id: 'remote-b',
          name: 'Qwen on B',
          remoteServerId: 'server-b',
          remoteModelId: 'qwen'
        }
      ])
    ).toEqual({ modelId: routeId, modelName: 'Qwen on B' })
  })
})
