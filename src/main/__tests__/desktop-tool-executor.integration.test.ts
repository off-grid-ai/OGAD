/**
 * Turn-scoped Desktop tools through the real Shared generation loop and real LLM client. The
 * llama.cpp HTTP server and Electron profile are the only uncontrollable boundary fakes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OffGridApplication } from '@offgrid/application'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  installFakeActiveTextModel,
  startFakeLlamaServer,
  type FakeLlamaServer
} from './harness/fake-llama-server'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-desktop-tool-executor-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = profile

vi.mock('electron', () => ({
  app: { getPath: () => profile, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

let fake: FakeLlamaServer
let application: OffGridApplication
let releaseApplication: () => void

beforeAll(async () => {
  installFakeActiveTextModel(profile)
  const [{ createOffGridApplication }, { desktopModelWorkspacePorts }, applicationAccess] =
    await Promise.all([
      import('@offgrid/application'),
      import('../model-services'),
      import('../composition/application-access')
    ])
  application = createOffGridApplication({ models: desktopModelWorkspacePorts })
  releaseApplication = applicationAccess.registerDesktopApplication(application)
  await application.start()

  fake = await startFakeLlamaServer()
  const { llm } = await import('../llm')
  const service = llm as unknown as { port: number; initialized: boolean; paused: boolean }
  service.port = fake.port
  service.initialized = true
  service.paused = false
})

afterAll(async () => {
  await fake.close()
  await application.stop()
  releaseApplication()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

const tools = [
  {
    type: 'function',
    function: {
      name: 'lookup_release',
      description: 'Read the selected release channel.',
      parameters: {
        type: 'object',
        properties: { release: { type: 'string' } },
        required: ['release'],
        additionalProperties: false
      }
    }
  }
]

describe('Desktop tool execution through the Shared generation loop', () => {
  it('executes only in the registered turn and releases the session afterwards', async () => {
    const { generateDesktopText } = await import('../desktop-generation')
    const executions: Array<{ name: string; arguments: string; turnId?: string }> = []
    fake.enqueue(
      { toolCalls: [{ name: 'lookup_release', args: { release: 'candidate' } }] },
      { content: 'The stable release is ready.' }
    )

    const first = await generateDesktopText('Check the release.', {
      identity: { conversationId: 'chat-release', turnId: 'turn-release-1' },
      tools,
      toolHandling: 'execute',
      toolExecution: {
        prepare: (call) => ({
          ...call,
          arguments: JSON.stringify({ release: 'stable' })
        }),
        execute: async (call, context) => {
          executions.push({
            name: call.name,
            arguments: call.arguments,
            turnId: context.identity?.turnId
          })
          return { content: 'Stable channel: 0.0.43' }
        }
      }
    })

    expect(first.content).toBe('The stable release is ready.')
    expect(executions).toEqual([
      {
        name: 'lookup_release',
        arguments: JSON.stringify({ release: 'stable' }),
        turnId: 'turn-release-1'
      }
    ])
    expect(JSON.stringify(fake.requests[1])).toContain('Stable channel: 0.0.43')

    fake.enqueue(
      { toolCalls: [{ name: 'lookup_release', args: { release: 'stable' } }] },
      { content: 'No release session was active.' }
    )
    const second = await generateDesktopText('Check again.', {
      identity: { conversationId: 'chat-release', turnId: 'turn-release-1' },
      tools,
      toolHandling: 'execute'
    })
    expect(second.content).toBe('No release session was active.')
    expect(executions).toHaveLength(1)
    expect(JSON.stringify(fake.requests.at(-1))).toContain(
      'No Desktop tool execution session is active.'
    )
  })
})
