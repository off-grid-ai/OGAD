import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

// A fresh profile where the app answers two real requests through its local API: a chat turn and
// an image. The models are fixture executables (llama-server, sd-cli); the gateway, the activity
// log and its window are the app's own.
const freePort = async (): Promise<number> => {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as net.AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

const IMAGE_MODEL = 'sdxl-lightning-resident.gguf'
const TEXT_REPLY = 'Here is your weekly summary.'

test('AI activity uses the window, filters records, and keeps the main window open', async ({
  playwright
}, testInfo) => {
  test.setTimeout(180_000)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ai-activity-ui-'))
  const bin = path.join(profile, 'bin')
  const modelsDir = path.join(profile, 'models')
  fs.mkdirSync(path.join(bin, 'llama'), { recursive: true })
  fs.mkdirSync(path.join(bin, 'sd'), { recursive: true })
  fs.mkdirSync(modelsDir, { recursive: true })
  for (const [source, target] of [
    ['e2e/fixtures/fake-llama-server.mjs', 'llama/llama-server'],
    ['e2e/fixtures/app093-image-runtime-boundary.mjs', 'sd/sd-cli']
  ]) {
    fs.copyFileSync(path.resolve(source), path.join(bin, target))
    fs.chmodSync(path.join(bin, target), 0o755)
  }
  const gguf = Buffer.alloc(2_048)
  gguf.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'activity.gguf'), gguf)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'activity-model', primary: 'activity.gguf', mmproj: null })
  )
  fs.writeFileSync(
    path.join(modelsDir, IMAGE_MODEL),
    Buffer.from('GGUF first_stage_model conditioner text_encoder vae.'.repeat(80))
  )
  fs.writeFileSync(
    path.join(modelsDir, 'active-modalities.json'),
    JSON.stringify({ image: IMAGE_MODEL })
  )
  const gatewayPort = await freePort()
  const app = await playwright._electron.launch({
    args: [process.env.OFFGRID_AI_ACTIVITY_APP ?? '.'],
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profile,
      OFFGRID_BIN_DIR: bin,
      OFFGRID_GATEWAY_PORT: String(gatewayPort),
      OFFGRID_E2E_ISOLATED_INSTANCE: '1',
      OFFGRID_E2E_HEADLESS: '1',
      OFFGRID_PRO: '0',
      OFFGRID_SEED: '',
      NO_PROXY: '127.0.0.1,localhost'
    }
  })
  const post = async (route: string, body: unknown): Promise<void> => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    expect(response.status, await response.clone().text()).toBe(200)
    await response.text()
  }
  try {
    const main = await app.firstWindow()
    await main.waitForFunction(() => !!window.api?.aiLogsOpenWindow)
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`)).status
          } catch {
            return 0
          }
        },
        { timeout: 30_000 }
      )
      .toBe(200)
    await post('/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Summarise my week' }],
      stream: false
    })
    await post('/v1/images/generations', { prompt: 'A lighthouse at dusk', n: 1 })
    const originalUrl = main.url()
    const windowPromise = app.waitForEvent('window')
    await main.evaluate(() => window.api.aiLogsOpenWindow())
    const activity = await windowPromise
    await expect(activity.getByText(TEXT_REPLY).first()).toBeVisible({ timeout: 15_000 })
    await main.evaluate(() => window.api.aiLogsOpenWindow())
    expect(app.windows()).toHaveLength(2)
    expect(main.url()).toBe(originalUrl)
    for (const [width, height] of [
      [1600, 1000],
      [900, 700],
      [620, 600]
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          const window = BrowserWindow.getAllWindows().find((item) =>
            item.webContents.getURL().endsWith('#ai-activity')
          )!
          window.setSize(size[0]!, size[1]!)
        },
        [width!, height!]
      )
      for (const theme of ['light', 'dark']) {
        await activity.evaluate((value) => window.ogTheme.set(value as 'light' | 'dark'), theme)
        await activity.evaluate(() => document.fonts.ready)
        const layout = await activity.evaluate(() => {
          const bounds = document
            .querySelector('section[aria-label="AI activity"]')!
            .getBoundingClientRect()
          return {
            width: bounds.width,
            height: bounds.height,
            innerWidth,
            innerHeight,
            overflow: document.documentElement.scrollWidth > innerWidth
          }
        })
        expect(layout.width).toBe(layout.innerWidth)
        expect(layout.height).toBe(layout.innerHeight)
        expect(layout.overflow).toBe(false)
        await activity.screenshot({
          path: testInfo.outputPath(`activity-${theme}-${width}.png`),
          animations: 'disabled'
        })
      }
    }
    // Responses can be hidden: open the chat turn, and its response section goes.
    await activity
      .getByRole('button', { name: /Summarise my week/ })
      .first()
      .click()
    const response = activity.locator('pre').filter({ hasText: TEXT_REPLY })
    await expect(response.first()).toBeVisible()
    const shown = await response.count()
    await activity.getByRole('button', { name: 'Show', exact: true }).click()
    await activity.getByRole('menuitemcheckbox', { name: 'Responses', exact: true }).click()
    await activity.keyboard.press('Escape')
    await expect.poll(() => response.count()).toBeLessThan(shown)
    // And in the raw view of the same record.
    await activity.getByRole('radio', { name: 'Raw', exact: true }).click()
    await expect.poll(() => response.count()).toBeLessThan(shown)
    // The image filter shows the image request and not the chat turn.
    await activity.getByRole('radio', { name: 'Images', exact: true }).click()
    await expect(activity.getByText(/A lighthouse at dusk/).first()).toBeVisible()
    await expect(activity.getByText(/Summarise my week/)).toHaveCount(0)
    await activity.getByRole('button', { name: 'Clear history', exact: true }).click()
    await activity.getByRole('button', { name: 'Delete history', exact: true }).click()
    await expect(activity.getByText('No requests match these filters.')).toBeVisible()
    await activity.close()
    expect(main.isClosed()).toBe(false)
  } finally {
    await app.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
})
