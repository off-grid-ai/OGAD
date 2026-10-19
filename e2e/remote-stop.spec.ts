/**
 * Stop on a remote model stops the answer on screen at once, without switching tabs.
 *
 * Real app; the only boundary is an OpenAI-compatible model server inside this test. The first
 * turn answers quickly, but the requests the app makes after a turn (a title, a follow-up
 * suggestion) answer slowly, so that turn's run is still finishing when the second turn starts.
 * The second turn streams numbered words until the client disconnects. Pressing Stop must close
 * the request and freeze the answer where it is. (The defect: an older run in the same chat took
 * the Stop request and the answer kept streaming until a tab switch.)
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

const MODEL = 'remote-stop-model'
const FIRST = 'Say hello for the remote stop check.'
const SECOND = 'Count words slowly for the remote stop check.'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let server: http.Server
let endpoint: string
/** When the server saw the streaming request close, in epoch ms. */
let streamClosedAt: number | null = null

const lastUserText = (body: { messages?: { role: string; content: unknown }[] }): string => {
  const users = (body.messages ?? []).filter((message) => message.role === 'user')
  return JSON.stringify(users[users.length - 1]?.content ?? '')
}

const sse = (response: http.ServerResponse, text: string): void => {
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
  )
}

const finish = (response: http.ServerResponse, text: string, stream: boolean): void => {
  if (!stream) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: text } }] })
    )
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  sse(response, text)
  response.end('data: [DONE]\n\n')
}

const startModelServer = async (): Promise<void> => {
  server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }))
      return
    }
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const body = JSON.parse(raw || '{}') as {
        stream?: boolean
        messages?: { role: string; content: unknown }[]
      }
      const last = lastUserText(body)
      if (last.includes(SECOND) && !last.includes('The user asked:')) {
        // Streams numbered words until the client goes away.
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        let n = 0
        const timer = setInterval(() => sse(response, `tok${++n} `), 120)
        response.on('close', () => {
          clearInterval(timer)
          streamClosedAt ??= Date.now()
        })
        return
      }
      if (last.includes(FIRST) && !last.includes('The user asked:')) {
        finish(response, 'Hello from the remote model.', body.stream === true)
        return
      }
      // A title or follow-up suggestion: slow, so the first turn's run is still finishing.
      setTimeout(() => finish(response, 'NONE', body.stream === true), 8_000)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}

/** The highest numbered word showing in the chat. */
const shownWords = (): Promise<number> =>
  page.evaluate(() => {
    const numbers = [...document.body.innerText.matchAll(/tok(\d+)/g)]
    return numbers.reduce((max, match) => Math.max(max, Number(match[1])), 0)
  })

test.describe('Stop on a remote model', () => {
  test.skip(targetIsPackaged(), 'This boundary is for the source-built E2E target.')
  test.describe.configure({ timeout: 120_000 })

  test.beforeEach(async () => {
    streamClosedAt = null
    await startModelServer()
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-remote-stop-'))
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_PRO: '0',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await completeOnboarding(page)
    // The remote server is the precondition, set the way Settings → Remote saves it.
    await page.evaluate(
      async ({ url, model }) =>
        (
          window as unknown as {
            api: { setRemoteVisionServer: (update: unknown) => Promise<unknown> }
          }
        ).api.setRemoteVisionServer({
          provider: 'custom',
          name: 'Remote stop server',
          endpoint: url,
          model,
          modelCatalog: [{ id: model, name: 'Remote stop model', kind: 'text' }]
        }),
      { url: endpoint, model: MODEL }
    )
  })

  test.afterEach(async () => {
    await app?.close().catch(() => undefined)
    app = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('Stop freezes the streaming answer and closes the request, without a tab switch', async () => {
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    const composer = page.getByRole('textbox', { name: 'Message' })
    await composer.fill(FIRST)
    await composer.press('Enter')
    await expect(page.getByText('Hello from the remote model.').first()).toBeVisible({
      timeout: 30_000
    })

    // The second turn starts while the first is still finishing its slow follow-up requests.
    await composer.fill(SECOND)
    await composer.press('Enter')
    await expect.poll(shownWords, { timeout: 30_000 }).toBeGreaterThanOrEqual(5)

    const stop = page.getByRole('button', { name: 'Stop generating', exact: true })
    await stop.click()
    const stoppedAt = Date.now()

    // The request closes promptly, the Stop control goes, and the answer stays where it stopped.
    await expect.poll(() => streamClosedAt, { timeout: 5_000 }).not.toBeNull()
    expect(streamClosedAt! - stoppedAt).toBeLessThan(2_000)
    await expect(stop).toBeHidden({ timeout: 5_000 })
    const frozen = await shownWords()
    // Stop keeps what was shown; an emptied answer must not pass as "unchanged".
    expect(frozen).toBeGreaterThan(0)
    await page.waitForTimeout(1_500)
    expect(await shownWords()).toBe(frozen)
  })
})
