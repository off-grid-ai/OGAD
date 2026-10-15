/**
 * GPU fault recovery: a GPU that stops responding never breaks a chat or changes the model.
 *
 * The rendered app, the HTTP client's fault classifier, the shared chat fallback policy, the
 * same-model restart, the backend ladder, the CPU-only launch flags (`--device none`), the runtime
 * status and the Settings row are production code. One fake stands at the native boundary: a
 * llama-server that reports where it placed the model and answers "500 Compute error" for as many
 * questions as its fault plan lists (e2e/fixtures/gpu-fault-llama-server.mjs).
 *
 * Proves, from what the user sees:
 *  - one fault: the same model restarts and the answer arrives, with no notice;
 *  - two faults: the same model answers on the CPU, the chat says so once, Settings shows CPU,
 *    and "Try the GPU again" puts it back on the GPU.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

const CPU_NOTICE = 'Chat moved to the CPU. The GPU stopped responding. Replies will be slower.'

let app: ElectronApplication | null = null
let page: Page
let rootDir: string
let llamaDir: string

function installModelBoundary(profileDir: string): string {
  const modelsDir = path.join(profileDir, 'models')
  const binDir = path.join(profileDir, 'bin')
  llamaDir = path.join(binDir, 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'gpu-fault.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'gpu-fault-model', primary: 'gpu-fault.gguf', mmproj: null })
  )
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'gpu-fault-llama-server.mjs'),
    executable
  )
  fs.chmodSync(executable, 0o755)
  return binDir
}

function planFaults(remaining: number): void {
  fs.writeFileSync(path.join(llamaDir, 'faults.json'), JSON.stringify({ remaining }))
}

async function ask(text: string, reply: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill(text)
  await composer.press('Enter')
  await expect(page.getByText(text, { exact: true }).last()).toBeVisible()
  await expect(page.getByText(reply, { exact: true }).last()).toBeVisible({ timeout: 90_000 })
}

/** The chat engine's row in Settings → Text: its "Now:" line. */
async function openChatBackendRow(): Promise<ReturnType<Page['getByText']>> {
  await page.getByTitle('Active models').click()
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
  const row = page.getByText(/^Now: /).first()
  await expect(row).toBeVisible()
  return row
}

test.describe('GPU fault recovery', () => {
  test.skip(targetIsPackaged(), 'This native-boundary fixture is for the source-built E2E target.')
  test.skip(process.platform !== 'darwin', 'The fixture stands in for the macOS Metal engine.')
  test.describe.configure({ mode: 'serial', timeout: 240_000 })

  test.beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gpu-fault-'))
    const profileDir = path.join(rootDir, 'profile')
    const binDir = installModelBoundary(profileDir)
    planFaults(0)
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: binDir,
        OFFGRID_EMBEDDINGS_OFFLINE: '1',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await completeOnboarding(page)
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible()
    const captureDismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
    if (await captureDismiss.isVisible().catch(() => false)) await captureDismiss.click()
  })

  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    const launches = path.join(llamaDir, 'launches.jsonl')
    if (testInfo.status !== testInfo.expectedStatus && fs.existsSync(launches)) {
      console.log(fs.readFileSync(launches, 'utf8'))
    }
    const running = app
    app = null
    if (running) await running.close()
    if (path.basename(rootDir).startsWith('offgrid-gpu-fault-')) {
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('one GPU fault restarts the same model and the answer still arrives', async () => {
    await ask('GPU check: hello', 'Answered on the GPU.')
    planFaults(1)
    await ask('GPU check: once more', 'Answered on the GPU.')
    await expect(page.getByText(CPU_NOTICE)).toHaveCount(0)
  })

  test('a second fault moves the same model to the CPU, says so once, and the GPU comes back on request', async () => {
    await ask('GPU check: hello', 'Answered on the GPU.')
    planFaults(2)
    await ask('GPU check: keep going', 'Answered on the CPU.')
    // The notice sits above the answer (the sidebar preview may repeat its text).
    await expect(page.getByText(CPU_NOTICE).first()).toBeVisible()
    await expect(page.getByText('Answered on the CPU.', { exact: true }).last()).toBeVisible()

    const row = await openChatBackendRow()
    await expect(row).toContainText('Now: CPU')
    await page.getByRole('button', { name: 'Try the GPU again' }).first().click()
    await expect(row).toContainText('Metal · all layers on GPU', { timeout: 60_000 })
  })
})
