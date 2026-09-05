/**
 * ExecuTorch speech journey across the real asset cache, native process protocol, and WAV output.
 * Network and the heavyweight native executable are the only controlled boundaries.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OffGridApplication } from '@offgrid/application'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-executorch-tts-'))
const dataDir = path.join(root, 'data')
const resourceDir = path.join(root, 'resources')
const executable = path.join(resourceDir, 'bin', 'executorch-speech')
const inputRecord = path.join(root, 'speech-input.txt')
const voiceRecord = path.join(root, 'speech-voice.txt')
const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalResourceDir = process.env.OFFGRID_RESOURCE_DIR
let application: OffGridApplication
let releaseApplication: (() => void) | undefined

process.env.OFFGRID_DATA_DIR = dataDir
process.env.OFFGRID_RESOURCE_DIR = resourceDir

vi.mock('electron', () => ({
  app: {
    getPath: () => dataDir,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeAll(async () => {
  const [applicationModule, applicationAccess, modelServices] = await Promise.all([
    import('@offgrid/application'),
    import('../composition/application-access'),
    import('../model-services')
  ])
  application = applicationModule.createOffGridApplication({
    models: modelServices.desktopModelWorkspacePorts
  })
  releaseApplication = applicationAccess.registerDesktopApplication(application)
  await application.start()
})

afterAll(async () => {
  await application.stop()
  releaseApplication?.()
  restoreEnv('OFFGRID_DATA_DIR', originalDataDir)
  restoreEnv('OFFGRID_RESOURCE_DIR', originalResourceDir)
  fs.rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('ExecuTorch TTS asset integration', () => {
  it('downloads an uncached voice once, then speaks the exact reply from its cache', async () => {
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(
      executable,
      `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const value = flag => args[args.indexOf(flag) + 1]
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  fs.writeFileSync('${inputRecord}', input)
  fs.writeFileSync('${voiceRecord}', value('--voice'))
  fs.writeFileSync(value('--output'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60, 1)]))
})
`,
      { mode: 0o755 }
    )

    const requestedUrls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        requestedUrls.push(String(input))
        const body = Buffer.from(`synthetic speech asset ${requestedUrls.length}`)
        return new Response(new Uint8Array(body), {
          status: 200,
          headers: { 'content-length': String(body.length) }
        })
      })
    )

    const { prepareVoiceAssets, synthesize } = await import('../tts')
    const progress: number[] = []
    await prepareVoiceAssets('af_river', ({ percentage }) => {
      if (percentage !== null) progress.push(percentage)
    })

    expect(requestedUrls.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toBe(100)
    const downloadsAfterPrepare = requestedUrls.length

    const selection = await application.models.select({
      modality: 'voice',
      modelId: 'software-mansion/executorch-kokoro'
    })
    if (!selection.ok)
      throw new Error(
        `The prepared voice model could not be selected: ${JSON.stringify(selection.failure)}`
      )

    const spoken = await synthesize('A local reply with code', 'af_river')

    expect(requestedUrls).toHaveLength(downloadsAfterPrepare)
    expect(spoken.dataUrl).toMatch(/^data:audio\/wav;base64,/)
    expect(
      Buffer.from(spoken.dataUrl.split(',')[1]!, 'base64').subarray(0, 4).toString('ascii')
    ).toBe('RIFF')
    expect(fs.readFileSync(inputRecord, 'utf8')).toBe('A local reply with code')
    expect(path.basename(fs.readFileSync(voiceRecord, 'utf8'))).toContain('af_river.bin')
  }, 30_000)
})
