import { expect, test, type ElectronApplication } from '@playwright/test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import electronExecutable from 'electron'
import { launchOffGrid } from './helpers/launch'

let app: ElectronApplication | undefined
let profile: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app-restart-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
})

test.afterAll(() => {
  fs.rmSync(profile, { recursive: true, force: true })
})

async function launchAndReadPaths(): Promise<{ userData: string; models: string }> {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profile,
      OFFGRID_PRO: '0',
      OFFGRID_E2E_HEADLESS: '1',
      OFFGRID_E2E_ISOLATED_INSTANCE: '1',
      NODE_ENV: 'production'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return {
    userData: await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData')),
    models: await page.evaluate(async () => (await window.api.checkModelStatus()).modelsDir)
  }
}

test('keeps application and model storage in one selected profile across restart', async () => {
  const first = await launchAndReadPaths()
  expect(first).toEqual({ userData: profile, models: path.join(profile, 'models') })
  expect(fs.existsSync(path.join(profile, 'memories.db'))).toBe(true)

  await app?.close()
  app = undefined

  const second = await launchAndReadPaths()
  expect(second).toEqual(first)
  expect(fs.existsSync(path.join(profile, 'memories.db'))).toBe(true)
})

test('exits when an explicit profile cannot be established', async () => {
  const invalidProfile = path.join(profile, 'not-a-directory')
  fs.writeFileSync(invalidProfile, 'occupied by a file')
  const environment = {
    ...process.env,
    OFFGRID_USER_DATA: invalidProfile,
    OFFGRID_PRO: '0',
    OFFGRID_E2E_HEADLESS: '1',
    OFFGRID_E2E_ISOLATED_INSTANCE: '1',
    NODE_ENV: 'production'
  }
  delete environment.ELECTRON_RUN_AS_NODE

  const child = spawn(
    electronExecutable as unknown as string,
    [path.resolve('.'), '--server-only'],
    {
      cwd: path.resolve('.'),
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe']
    }
  )
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Electron continued after the explicit profile failed'))
    }, 15_000)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })

  expect(exitCode).toBe(1)
  expect(stderr).toContain('[userData] initialization failed')
})
