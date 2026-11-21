/**
 * Desktop performance journeys, run nightly (npm run perf:e2e). Each test measures one thing and
 * adds it to one results file; perf/trend.mjs then compares that file with the recent nightly runs
 * and fails on a regression.
 *
 * Measured:
 *   - cold start: launch to the first usable window (the shell's Chat button), on a profile that
 *     finished onboarding, median of three launches; plus a first-run launch to the onboarding CTA
 *   - idle: CPU % and memory per process type from app.getAppMetrics() over 10 s of doing nothing
 *   - journeys: renderer cost of sending a chat message, opening Settings, and opening Notes with
 *     1,000 notes, from CDP Performance.getMetrics deltas and long tasks
 *
 * Only the native model executable is fake (the same fixture APP-045 uses), so the chat journey
 * runs the real IPC, streaming and rendering. Nothing here touches analytics.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid } from '../../e2e/helpers/launch'
import { completeOnboarding } from '../../e2e/helpers/onboarding'
import { gotoSettings, navButton } from '../../e2e/helpers/settings'

const resultsFile =
  process.env.PERF_RESULTS ?? path.join(process.cwd(), 'perf', 'results', 'desktop-e2e.json')
const NOTES = 1_000
const REPLY = 'APP-045 local first chunk arrives, then completes offline.'

type Metrics = Record<string, number>
const results: Record<string, Metrics> = {}

let userDataDir: string
let binDir: string
let notesDir: string
let app: ElectronApplication | null = null
let page: Page

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
const round = (value: number, places = 1): number => Number(value.toFixed(places))

const waitForExit = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

const closeApp = async (): Promise<void> => {
  const running = app
  if (!running) return
  app = null
  const child = running.process()
  await running.close()
  await waitForExit(child)
}

const launch = async (): Promise<number> => {
  const started = performance.now()
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_BIN_DIR: binDir,
      OFFGRID_APP045_AUDIT_FILE: path.join(userDataDir, 'model-audit.jsonl'),
      OFFGRID_PRO: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  return started
}

/** Long tasks of the renderer since the observer started, kept on window for the journeys to read. */
const watchLongTasks = async (): Promise<void> => {
  await page.evaluate(() => {
    const w = window as unknown as { __perfLongTasks?: number[] }
    if (w.__perfLongTasks) return
    w.__perfLongTasks = []
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__perfLongTasks!.push(entry.duration)
    }).observe({ type: 'longtask', buffered: true })
  })
}

const takeLongTasks = (): Promise<number[]> =>
  page.evaluate(() => {
    const w = window as unknown as { __perfLongTasks?: number[] }
    return w.__perfLongTasks?.splice(0) ?? []
  })

const RENDERER_METRICS = [
  'TaskDuration',
  'ScriptDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
  'LayoutCount',
  'RecalcStyleCount',
  'JSHeapUsedSize',
  'Nodes'
]

/** Run a journey and record its wall time, renderer CPU (CDP deltas) and long tasks. */
const measureJourney = async (name: string, journey: () => Promise<void>): Promise<void> => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const read = async (): Promise<Metrics> => {
    const { metrics } = await cdp.send('Performance.getMetrics')
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
  }
  await watchLongTasks()
  await takeLongTasks()
  const before = await read()
  const started = performance.now()
  await journey()
  const wall = performance.now() - started
  const after = await read()
  const longTasks = await takeLongTasks()
  await cdp.detach()

  const delta = (key: string): number => (after[key] ?? 0) - (before[key] ?? 0)
  const entry: Metrics = { wallMs: round(wall) }
  for (const key of RENDERER_METRICS) {
    if (key.endsWith('Duration')) entry[`${key}Ms`] = round(delta(key) * 1000)
    else if (key === 'JSHeapUsedSize') entry.jsHeapMB = round((after[key] ?? 0) / 1_048_576)
    else if (key === 'Nodes') entry.domNodes = after[key] ?? 0
    else entry[key] = delta(key)
  }
  entry.longTaskCount = longTasks.length
  entry.longTaskMs = round(longTasks.reduce((sum, d) => sum + d, 0))
  entry.longestTaskMs = round(Math.max(0, ...longTasks))
  results[name] = entry
}

const stageModelBoundary = (): void => {
  const modelsDir = path.join(userDataDir, 'models')
  const llamaDir = path.join(binDir, 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'perf-local.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'perf-local-model', primary: 'perf-local.gguf', mmproj: null })
  )
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'app045-streaming-llama-server.mjs'),
    executable
  )
  fs.chmodSync(executable, 0o755)
}

const stageNotes = (): void => {
  fs.mkdirSync(notesDir, { recursive: true })
  for (let i = 1; i <= NOTES; i++) {
    const id = String(i).padStart(4, '0')
    fs.writeFileSync(
      path.join(notesDir, `Perf note ${id}.md`),
      `# Perf note ${id}\n\nMeeting notes, a budget line and a link to [[Perf note ${String(
        (i % NOTES) + 1
      ).padStart(4, '0')}]].\n`
    )
  }
}

const shellReady = (): Promise<void> =>
  expect(navButton(page, 'Chat')).toBeVisible({ timeout: 60_000 })

const dismissCaptureNotice = async (): Promise<void> => {
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-perf-'))
  binDir = path.join(userDataDir, 'bin')
  notesDir = path.join(userDataDir, 'perf-notes')
  stageModelBoundary()
  stageNotes()
})

test.afterAll(async () => {
  await closeApp()
  fs.mkdirSync(path.dirname(resultsFile), { recursive: true })
  fs.writeFileSync(
    resultsFile,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        machine: `${os.platform()} ${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}`,
        results
      },
      null,
      2
    ) + '\n'
  )
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('cold start: first run, then three launches of an onboarded profile', async () => {
  const firstStarted = await launch()
  await expect(
    page
      .getByRole('button', {
        name: /^(Continue|Show me how it works|Set up my models|Start using Off Grid AI|Skip, set it up)/i
      })
      .first()
  ).toBeVisible({ timeout: 60_000 })
  const firstRun = performance.now() - firstStarted
  await completeOnboarding(page)
  await shellReady()
  await closeApp()

  const launches: number[] = []
  for (let i = 0; i < 3; i++) {
    const started = await launch()
    await shellReady()
    launches.push(performance.now() - started)
    await closeApp()
  }
  results.startup = {
    firstRunToOnboardingMs: round(firstRun),
    coldStartMedianMs: round(median(launches)),
    coldStartWorstMs: round(Math.max(...launches))
  }
})

test('idle: CPU and memory per process over 10 s', async () => {
  await launch()
  await shellReady()
  await dismissCaptureNotice()
  // Let startup work (indexes, model probe, timers) settle before calling it idle.
  await page.waitForTimeout(15_000)
  const sample = (): Promise<{ type: string; cpu: number; memoryKB: number }[]> =>
    app!.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map((m) => ({
        type: m.type,
        cpu: m.cpu.percentCPUUsage,
        memoryKB: m.memory.workingSetSize
      }))
    )
  await sample() // percentCPUUsage counts from the previous call
  await page.waitForTimeout(10_000)
  const processes = await sample()

  const idle: Metrics = { processCount: processes.length }
  let cpu = 0
  let memoryKB = 0
  for (const p of processes) {
    const key = p.type.toLowerCase()
    idle[`${key}CpuPercent`] = round((idle[`${key}CpuPercent`] ?? 0) + p.cpu, 2)
    idle[`${key}MemoryMB`] = round((idle[`${key}MemoryMB`] ?? 0) + p.memoryKB / 1024)
    cpu += p.cpu
    memoryKB += p.memoryKB
  }
  idle.totalCpuPercent = round(cpu, 2)
  idle.totalMemoryMB = round(memoryKB / 1024)
  results.idle = idle
})

test('journey: open Settings', async () => {
  await measureJourney('openSettings', async () => {
    await gotoSettings(page)
    // Let the entrance settle, as a person would wait to read it.
    await page.waitForTimeout(1_500)
  })
})

test('journey: send a chat message and read the reply', async () => {
  await navButton(page, 'Chat').click()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await expect(composer).toBeVisible()
  await dismissCaptureNotice()
  await measureJourney('chatSend', async () => {
    await composer.fill('Measure how heavy one chat turn is.')
    await page.keyboard.press('Enter')
    await expect(page.getByText(REPLY, { exact: true }).last()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden()
  })
})

test('journey: open Notes with 1,000 notes and scroll the list', async () => {
  await page.evaluate(
    (dir) =>
      (
        window as unknown as { api: { proInvoke: (c: string, d: string) => Promise<unknown> } }
      ).api.proInvoke('notes:set-library', dir),
    notesDir
  )
  await measureJourney('openNotes', async () => {
    await navButton(page, 'Notes').click()
    const tree = page.getByRole('tree')
    await expect(tree.getByText('Perf note 0001', { exact: false }).first()).toBeVisible({
      timeout: 60_000
    })
    // Scroll down the list a hundred notes at a time, to the last one.
    for (let i = 100; i <= NOTES; i += 100) {
      const note = tree.getByText(`Perf note ${String(i).padStart(4, '0')}`).first()
      await note.scrollIntoViewIfNeeded()
      await expect(note).toBeVisible()
    }
  })
})
