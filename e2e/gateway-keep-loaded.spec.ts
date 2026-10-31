/**
 * Keep several models loaded: on the Gateway screen the person ticks the chat models to keep
 * loaded, sees what they take in memory, and saves. The gateway then runs them in llama.cpp's
 * router and sends a request naming a kept model straight to it. Real app, real gateway; the only
 * fake is the native llama-server executable, which speaks the router's HTTP contract.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { GATEWAY_PORT } from '../src/shared/ports'
import { ggufFile } from './helpers/gguf'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'
import { assertEnginePortsFree } from './helpers/ports'
import { closeAndWait, gotoScreen, mainWindow } from './helpers/windows'

const SMALL = 'unsloth/Qwen3.5-0.8B-GGUF'
const LARGER = 'unsloth/Qwen3.5-2B-GGUF'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

/** A client's chat request to the gateway: the reply's text, as the client reads it. */
const ask = (model: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }] })
    const request = http.request(
      {
        host: '127.0.0.1',
        port: GATEWAY_PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      },
      (response) => {
        let raw = ''
        response.on('data', (chunk) => (raw += chunk))
        response.on('end', () => {
          try {
            resolve(
              (JSON.parse(raw) as { choices?: { message?: { content?: string } }[] }).choices?.[0]
                ?.message?.content ?? raw
            )
          } catch {
            resolve(raw)
          }
        })
      }
    )
    request.on('error', reject)
    request.end(body)
  })

function stageModels(): void {
  const models = path.join(profileDir, 'models')
  fs.mkdirSync(models, { recursive: true })
  fs.writeFileSync(path.join(models, 'Qwen3.5-0.8B-Q4_K_M.gguf'), ggufFile())
  fs.writeFileSync(path.join(models, 'mmproj-Qwen3.5-0.8B-BF16.gguf'), ggufFile())
  fs.writeFileSync(path.join(models, 'Qwen3.5-2B-Q4_K_M.gguf'), ggufFile())
  fs.writeFileSync(path.join(models, 'mmproj-Qwen3.5-2B-BF16.gguf'), ggufFile())
  fs.writeFileSync(
    path.join(models, 'active-model.json'),
    JSON.stringify({
      id: SMALL,
      primary: 'Qwen3.5-0.8B-Q4_K_M.gguf',
      mmproj: 'mmproj-Qwen3.5-0.8B-BF16.gguf'
    })
  )
  const llamaDir = path.join(profileDir, 'bin', 'llama')
  fs.mkdirSync(llamaDir, { recursive: true })
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'keep-loaded-llama-server.mjs'),
    executable
  )
  fs.chmodSync(executable, 0o755)
}

const launch = async (): Promise<void> => {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await mainWindow(app)
  await completeOnboarding(page)
}

test.describe('Gateway keep loaded', () => {
  test.beforeEach(async () => {
    await assertEnginePortsFree()
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-keep-loaded-'))
    stageModels()
    await launch()
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('kept models are picked on the Gateway screen, load together, and answer by name', async () => {
    test.setTimeout(3 * 60_000)
    await gotoScreen(page, 'Gateway')
    const kept = page.getByRole('region', { name: 'Keep loaded' })
    const small = kept.getByRole('checkbox', { name: /Keep Qwen 3\.5 0\.8B loaded/ })
    const larger = kept.getByRole('checkbox', { name: /Keep Qwen 3\.5 2B loaded/ })
    await expect(small).not.toBeChecked()
    await expect(larger).not.toBeChecked()

    // Ticking shows what the set takes before anything loads.
    await small.click()
    await larger.click()
    await expect(kept.getByRole('meter', { name: /used by kept models/ }).first()).toBeVisible()
    await expect(kept.getByText(/\d+ threads/)).toBeVisible()
    await expect(kept.getByRole('alert')).toHaveCount(0)

    await kept.getByRole('button', { name: 'Keep loaded' }).click()
    await expect(kept.getByRole('button', { name: 'Keep loaded' })).toHaveCount(0)
    await expect(kept.getByText('loaded', { exact: true })).toHaveCount(2, { timeout: 30_000 })
    await page.screenshot({ path: 'e2e/screenshots/gateway-keep-loaded.png' })

    // A client naming a kept model is answered by that model in the router, with the planned
    // threads and no busy-waiting.
    expect(await ask(LARGER)).toMatch(new RegExp(`^kept ${LARGER} threads=\\d+ poll=0$`))
    expect(await ask(SMALL)).toMatch(new RegExp(`^kept ${SMALL} threads=\\d+ poll=0$`))

    // The set is kept across a relaunch and loads again with the gateway.
    await closeAndWait(app!)
    await launch()
    await gotoScreen(page, 'Gateway')
    const relaunched = page.getByRole('region', { name: 'Keep loaded' })
    await expect(
      relaunched.getByRole('checkbox', { name: /Keep Qwen 3\.5 2B loaded/ })
    ).toBeChecked()
    await expect(relaunched.getByText('loaded', { exact: true })).toHaveCount(2, {
      timeout: 30_000
    })
    expect(await ask(LARGER)).toMatch(new RegExp(`^kept ${LARGER} `))
  })
})
