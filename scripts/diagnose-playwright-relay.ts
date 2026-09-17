import { app, BrowserWindow } from 'electron'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronPlaywrightRelay } from '../src/main/browser/electron-playwright-relay'
import { PlaywrightMcpSession } from '../src/main/browser/playwright-mcp-session'

app.setPath('userData', mkdtempSync(join(tmpdir(), 'offgrid-playwright-diagnostic-')))

async function main(): Promise<void> {
  await app.whenReady()
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><html><body><button>Diagnostic button</button></body></html>')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Diagnostic server has no port.')

  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await window.loadURL(`http://127.0.0.1:${address.port}`)
  const relay = new ElectronPlaywrightRelay({
    pages: () => [{ id: window.webContents.id, contents: window.webContents }],
    create: async (url) => {
      await window.loadURL(url)
      return { id: window.webContents.id, contents: window.webContents }
    },
    close: async () => window.close()
  })
  const session = new PlaywrightMcpSession(relay)
  const startedAt = Date.now()
  try {
    await session.connect()
    const result = await session.snapshot()
    console.log('[diagnose-playwright-relay] result', {
      durationMs: Date.now() - startedAt,
      isError: result.isError,
      text: result.text
    })
    if (result.isError) process.exitCode = 1
  } finally {
    await session.close().catch((error) =>
      console.error('[diagnose-playwright-relay] close failed', error)
    )
    window.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    app.quit()
  }
}

void main().catch((error) => {
  console.error('[diagnose-playwright-relay] failed', error)
  process.exitCode = 1
  app.quit()
})
