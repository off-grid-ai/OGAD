import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatDiagnosticLog,
  flushDiagnosticLog,
  installIpcDiagnostics,
  writeDiagnosticLog,
  type IpcHandlerRegistrar
} from '../diagnostics-log'
import { formatConsoleMessage } from '../diagnostics-log'

const originalLogPath = process.env.OFFGRID_DIAGNOSTIC_LOG
const roots: string[] = []

afterEach(async () => {
  await flushDiagnosticLog()
  if (originalLogPath === undefined) delete process.env.OFFGRID_DIAGNOSTIC_LOG
  else process.env.OFFGRID_DIAGNOSTIC_LOG = originalLogPath
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('diagnostic log', () => {
  it('formats metadata as one readable line without multiline injection', () => {
    expect(
      formatDiagnosticLog('2026-07-20T00:00:00.000Z', 'info', 'tts', 'worker.started', {
        mode: 'on-demand',
        chars: 42,
        detail: 'first\nsecond',
        omitted: undefined
      })
    ).toBe(
      '2026-07-20T00:00:00.000Z INFO [tts] worker.started mode="on-demand" chars=42 detail="first second"'
    )
  })

  it('redacts credentials from legacy console events before persistence', () => {
    expect(
      formatConsoleMessage([
        'download failed token=private-token',
        { model: 'kokoro', apiKey: 'private-key', progress: 42 }
      ])
    ).toBe(
      'download failed token=[redacted] {"model":"kokoro","apiKey":"[redacted]","progress":42}'
    )
  })

  it('writes consecutive events to the configured private log file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-diagnostics-'))
    roots.push(root)
    const logPath = path.join(root, 'nested', 'desktop.log')
    process.env.OFFGRID_DIAGNOSTIC_LOG = logPath

    writeDiagnosticLog('tts', 'request.started', { requestId: 'tts-1', chars: 10 })
    writeDiagnosticLog('tts', 'request.completed', { requestId: 'tts-1', wavBytes: 100 })
    await flushDiagnosticLog()

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('INFO [tts] request.started requestId="tts-1" chars=10')
    expect(lines[1]).toContain('INFO [tts] request.completed requestId="tts-1" wavBytes=100')
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600)
  })

  it('traces real handler lifecycles at the Electron boundary without logging payloads', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ipc-diagnostics-'))
    roots.push(root)
    const logPath = path.join(root, 'desktop.log')
    process.env.OFFGRID_DIAGNOSTIC_LOG = logPath

    type Handler = (event: unknown, ...args: unknown[]) => unknown
    const handlers = new Map<string, Handler>()
    const registrar: IpcHandlerRegistrar = {
      handle: (channel, listener) => handlers.set(channel, listener)
    }

    installIpcDiagnostics(registrar)
    installIpcDiagnostics(registrar)
    registrar.handle('chat:send', (_event, ...args) => {
      expect(args).toEqual(['private prompt text'])
      return { reply: String(args[0]).length }
    })
    registrar.handle('models:download', () => {
      const error = new Error('request failed token=private-token') as Error & { code: string }
      error.code = 'DOWNLOAD_FAILED'
      throw error
    })

    await expect(handlers.get('chat:send')?.({}, 'private prompt text')).resolves.toEqual({
      reply: 19
    })
    await expect(handlers.get('models:download')?.({})).rejects.toThrow('request failed')
    await flushDiagnosticLog()

    const output = fs.readFileSync(logPath, 'utf8')
    const started = output.match(/request\.started requestId="([^"]+)" channel="chat:send"/)
    expect(started?.[1]).toBeTruthy()
    expect(output).toContain(
      `request.completed requestId="${started?.[1]}" channel="chat:send" durationMs=`
    )
    expect(output).toContain('channel="models:download"')
    expect(output).toContain('errorCode="DOWNLOAD_FAILED"')
    expect(output).toContain('token=[redacted]')
    expect(output).not.toContain('private-token')
    expect(output).not.toContain('private prompt text')
    expect(output).not.toContain('reply')
    expect(output.match(/tracing\.installed/g)).toHaveLength(1)
  })
})
