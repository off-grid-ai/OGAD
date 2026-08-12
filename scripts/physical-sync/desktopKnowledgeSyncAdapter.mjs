#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node executes this physical-device harness directly as JavaScript. */

import { _electron as electron } from '@playwright/test'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '../..')
const appPath =
  process.env.DESKTOP_SYNC_APP_PATH ?? path.join(repoRoot, 'dist/mac-arm64/Off Grid AI Desktop.app')
const executablePath = path.join(appPath, 'Contents/MacOS/Off Grid AI Desktop')
const profilePath =
  process.env.DESKTOP_SYNC_PROFILE ??
  path.join(os.homedir(), 'Library/Application Support/Off Grid AI Desktop')
const artifactDir =
  process.env.DESKTOP_SYNC_ARTIFACT_DIR ??
  path.join(os.tmpdir(), 'offgrid-ios-macos-sync-artifacts')
const bundleId = process.env.DESKTOP_SYNC_BUNDLE_ID ?? 'co.getoffgridai.desktop.pro'

let electronApp
let page

const boundedTimeout = (value, fallback = 60_000) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 180_000) : fallback
}

const processIdsForExecutable = async () => {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='])
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(executablePath))
    .map((line) => Number(line.match(/^(\d+)/)?.[1]))
    .filter(Number.isInteger)
}

const listeningPortOwners = async () => {
  const owners = {}
  for (const port of [7878, 7879, 8439]) {
    try {
      const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
      const pids = stdout.trim().split(/\s+/).map(Number).filter(Number.isInteger)
      if (pids.length > 0) owners[port] = pids
    } catch {
      // lsof exits 1 when no process owns the port.
    }
  }
  return owners
}

const waitForExactAppExit = async () => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if ((await processIdsForExecutable()).length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('the existing packaged Desktop process did not quit within 15 seconds')
}

const quitPackagedApp = async () => {
  if ((await processIdsForExecutable()).length === 0) return
  await execFileAsync('osascript', ['-e', `tell application id "${bundleId}" to quit`]).catch(
    () => undefined
  )
  await waitForExactAppExit()
}

const requirePage = () => {
  if (!page) throw new Error('Desktop is not launched; send the launch action first')
  return page
}

const navButton = (label) =>
  requirePage()
    .getByRole('button', { name: new RegExp(`^${label}( Pro)?$`) })
    .first()

const openProjectKnowledge = async (projectName, timeoutMs) => {
  const activePage = requirePage()
  await navButton('Projects').click()
  await activePage.getByRole('heading', { name: 'Projects' }).waitFor({ timeout: timeoutMs })
  const project = activePage.getByRole('button', { name: projectName, exact: true }).first()
  await project.waitFor({ state: 'visible', timeout: timeoutMs })
  await project.click()
  const settings = activePage.getByRole('button', {
    name: 'Knowledge & settings',
    exact: true
  })
  await settings.click()
  await activePage.getByText('Knowledge base', { exact: true }).waitFor({
    state: 'visible',
    timeout: timeoutMs
  })
}

const documentName = (name) => requirePage().getByText(name, { exact: true }).last()

const readDocumentState = async (name) => {
  const activePage = requirePage()
  const present = await documentName(name)
    .isVisible()
    .catch(() => false)
  if (!present) return { present: false }
  const enabled = await activePage
    .getByRole('button', { name: `Disable ${name}`, exact: true })
    .isVisible()
    .catch(() => false)
  return { present: true, enabled }
}

const waitForDocument = async (args) => {
  const timeoutMs = boundedTimeout(args.timeoutMs, 90_000)
  const expectedPresent = args.present !== false
  await openProjectKnowledge(args.project, timeoutMs)
  const deadline = Date.now() + timeoutMs
  let observed = await readDocumentState(args.name)
  while (
    Date.now() < deadline &&
    (observed.present !== expectedPresent ||
      (expectedPresent && typeof args.enabled === 'boolean' && observed.enabled !== args.enabled))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    observed = await readDocumentState(args.name)
  }
  if (observed.present !== expectedPresent) {
    throw new Error(
      `${args.name} remained ${observed.present ? 'present' : 'absent'} after ${timeoutMs} ms`
    )
  }
  if (expectedPresent && typeof args.enabled === 'boolean' && observed.enabled !== args.enabled) {
    throw new Error(
      `${args.name} remained ${observed.enabled ? 'enabled' : 'disabled'} after ${timeoutMs} ms`
    )
  }
  return observed
}

const chooseMacFile = async (filePath) => {
  const script = `
on run argv
  set targetPath to item 1 of argv
  tell application "System Events"
    tell process "Off Grid AI Desktop"
      set frontmost to true
      repeat 100 times
        if exists sheet 1 of window 1 then exit repeat
        delay 0.1
      end repeat
      if not (exists sheet 1 of window 1) then error "file picker did not appear"
      keystroke "g" using {command down, shift down}
      delay 0.2
      keystroke targetPath
      key code 36
      delay 0.3
      key code 36
    end tell
  end tell
end run`
  await execFileAsync('osascript', ['-e', script, filePath])
}

const preflight = async () => {
  let accessibility = false
  try {
    const { stdout } = await execFileAsync('osascript', [
      '-e',
      'tell application "System Events" to get UI elements enabled'
    ])
    accessibility = stdout.trim() === 'true'
  } catch {
    accessibility = false
  }
  const observed = {
    appPath,
    profilePath,
    appExists: fs.existsSync(executablePath),
    profileExists: fs.existsSync(profilePath),
    accessibility,
    runningPids: await processIdsForExecutable(),
    portOwners: await listeningPortOwners()
  }
  if (!observed.appExists) {
    throw new Error(`no packaged app exists at ${appPath}; build it before launch`)
  }
  if (!observed.profileExists) {
    throw new Error(`the preserved Desktop profile does not exist at ${profilePath}`)
  }
  if (!observed.accessibility) {
    throw new Error('macOS Accessibility access is required to drive the native file picker')
  }
  return observed
}

const launch = async (args) => {
  await preflight()
  await quitPackagedApp()
  const remainingOwners = await listeningPortOwners()
  if (Object.keys(remainingOwners).length > 0) {
    throw new Error(
      `model ports are already owned by another process: ${JSON.stringify(remainingOwners)}`
    )
  }
  electronApp = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      OFFGRID_ALLOW_UNSIGNED_ARTIFACT: '1',
      OFFGRID_USER_DATA: profilePath
    }
  })
  page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await navButton('Devices').waitFor({ state: 'visible', timeout: 30_000 })
  if (args.peerName) {
    await navButton('Devices').click()
    await page
      .getByText(args.peerName, { exact: true })
      .first()
      .waitFor({
        state: 'visible',
        timeout: boundedTimeout(args.timeoutMs, 60_000)
      })
  }
  return {
    launched: true,
    peerName: args.peerName ?? null,
    profilePath
  }
}

const addFixture = async (args) => {
  const filePath = path.resolve(args.path)
  if (!fs.statSync(filePath).isFile()) throw new Error(`fixture is not a file: ${filePath}`)
  const timeoutMs = boundedTimeout(args.timeoutMs, 120_000)
  await openProjectKnowledge(args.project, timeoutMs)
  await requirePage().getByRole('button', { name: 'Add files', exact: true }).click()
  await chooseMacFile(filePath)
  const name = path.basename(filePath)
  const observed = await waitForDocument({
    project: args.project,
    name,
    present: true,
    enabled: true,
    timeoutMs
  })
  return { ...observed, name, filePath }
}

const toggleDocument = async (args) => {
  const timeoutMs = boundedTimeout(args.timeoutMs, 90_000)
  await openProjectKnowledge(args.project, timeoutMs)
  const current = await readDocumentState(args.name)
  if (!current.present) throw new Error(`${args.name} is not present on Desktop`)
  if (current.enabled !== args.enabled) {
    const action = args.enabled ? 'Enable' : 'Disable'
    await requirePage()
      .getByRole('button', { name: `${action} ${args.name}`, exact: true })
      .click()
  }
  return waitForDocument({ ...args, present: true, timeoutMs })
}

const deleteDocument = async (args) => {
  const timeoutMs = boundedTimeout(args.timeoutMs, 90_000)
  await openProjectKnowledge(args.project, timeoutMs)
  const current = await readDocumentState(args.name)
  if (!current.present) return current
  await requirePage()
    .getByRole('button', { name: `Delete ${args.name}`, exact: true })
    .click()
  return waitForDocument({ ...args, present: false, timeoutMs })
}

const screenshot = async (args) => {
  fs.mkdirSync(artifactDir, { recursive: true })
  const safeName = String(args.name ?? 'desktop')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-|-$/g, '')
  const target = path.join(artifactDir, `${safeName || 'desktop'}.png`)
  await requirePage().screenshot({ path: target })
  return { artifacts: [target] }
}

const handlers = {
  preflight,
  launch,
  'wait-document': waitForDocument,
  'add-fixture': addFixture,
  'toggle-document': toggleDocument,
  'delete-document': deleteDocument,
  screenshot
}

const runRequest = async (request) => {
  const action = String(request.action ?? '')
  const handler = handlers[action]
  if (!handler) throw new Error(`unsupported Desktop action: ${action}`)
  const result = await handler(request.args ?? {})
  return {
    schemaVersion: 1,
    id: request.id,
    action,
    status: 'ok',
    observed: result?.artifacts ? undefined : result,
    artifacts: result?.artifacts
  }
}

const cleanup = async () => {
  await electronApp?.close().catch(() => undefined)
  electronApp = undefined
  page = undefined
}

const serve = async () => {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of input) {
    if (!line.trim()) continue
    let request
    try {
      request = JSON.parse(line)
      const response = await runRequest(request)
      process.stdout.write(`${JSON.stringify(response)}\n`)
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          id: request?.id ?? null,
          action: request?.action ?? null,
          status: 'error',
          error: error instanceof Error ? error.message : String(error)
        })}\n`
      )
    }
  }
  await cleanup()
}

process.once('SIGINT', () => {
  void cleanup().finally(() => process.exit(130))
})
process.once('SIGTERM', () => {
  void cleanup().finally(() => process.exit(143))
})

if (process.argv[2] !== 'serve') {
  process.stderr.write('usage: node scripts/physical-sync/desktopKnowledgeSyncAdapter.mjs serve\n')
  process.exit(2)
}

await serve()
