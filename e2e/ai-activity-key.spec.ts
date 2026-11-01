import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// Two real requests to the app's local API: one sent with the API key "laptop", one with no key.
// The AI activity window names the key on the first and nothing extra on the second. The model is
// a llama-server fixture executable; the gateway, keys and activity log are the app's own.

const freePort = async (): Promise<number> => {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as net.AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

test('AI activity names the API key that sent a request', async ({ playwright }) => {
  test.setTimeout(120_000)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ai-activity-key-'))
  const modelsDir = path.join(profile, 'models')
  const llamaDir = path.join(profile, 'bin', 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const gguf = Buffer.alloc(2_048)
  gguf.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'activity.gguf'), gguf)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'activity-model', primary: 'activity.gguf', mmproj: null })
  )
  fs.copyFileSync(
    path.resolve('e2e/fixtures/fake-llama-server.mjs'),
    path.join(llamaDir, 'llama-server')
  )
  fs.chmodSync(path.join(llamaDir, 'llama-server'), 0o755)
  const gatewayPort = await freePort()
  const app = await playwright._electron.launch({
    args: [process.env.OFFGRID_AI_ACTIVITY_APP ?? '.'],
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profile,
      OFFGRID_BIN_DIR: path.join(profile, 'bin'),
      OFFGRID_GATEWAY_PORT: String(gatewayPort),
      OFFGRID_E2E_ISOLATED_INSTANCE: '1',
      OFFGRID_E2E_HEADLESS: '1',
      OFFGRID_PRO: '0',
      OFFGRID_SEED: '',
      NO_PROXY: '127.0.0.1,localhost'
    }
  })
  try {
    const main = await app.firstWindow()
    await main.waitForFunction(() => !!window.api?.aiLogsOpenWindow)
    const ask = async (content: string, apiKey?: string): Promise<void> => {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({ messages: [{ role: 'user', content }], stream: false })
      })
      expect(response.status).toBe(200)
      await response.text()
    }
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
    // A request before any key exists, then a key named "laptop", made the way Settings makes
    // it, and a request sent with it.
    await ask('Open request')
    const { key } = await main.evaluate(() => window.api.createGatewayApiKey('laptop', null))
    await ask('Keyed request', key)

    const windowPromise = app.waitForEvent('window')
    await main.evaluate(() => window.api.aiLogsOpenWindow())
    const activity = await windowPromise
    const keyed = activity.getByRole('button', { name: /Keyed request/ })
    const open = activity.getByRole('button', { name: /Open request/ })
    await expect(keyed).toContainText('laptop', { timeout: 15_000 })
    await expect(open).toBeVisible()
    await expect(open).not.toContainText('laptop')
    await keyed.click()
    await expect(activity.getByTitle('API key')).toHaveText('laptop')
    await activity.screenshot({
      path: 'e2e/screenshots/ai-activity-key.png',
      animations: 'disabled'
    })
  } finally {
    await app.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
})
