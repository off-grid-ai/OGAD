/**
 * Pro-tier E2E for behavior that crosses the Electron and OS boundaries. Launches the real built
 * app with pro features active (OFFGRID_PRO=1, no license needed) against a fresh temp
 * profile, seeded with deterministic pro data (OFFGRID_SEED_PRO=force on the TEMP
 * profile - never the real one). Drives these paths end-to-end through the real main
 * process:
 *
 *  1. Replay only surfaces moments backed by a captured SCREEN — connector-only
 *     observations (Attio/Linear/Gmail with no screenshot) must not appear. Asserted
 *     against the live crm:replay-* IPC: every moment an entity returns lines up with a
 *     real captured frame.
 *  2. Text and pixel images cross the real OS clipboard, encrypted history, and restore IPC.
 *  3. Restoring a copied FILE (of any type, including images) puts a file-url (Finder
 *     pastes the file), the path as plain text (terminal pastes the path), and the file's
 *     native bytes (an editor pastes the content) on the OS clipboard. Driven through the
 *     real capture → restore loop, asserting the resulting NSPasteboard flavors.
 *  4. Vault copy controls write through the reliable main-process clipboard bridge.
 *
 * The file-flavor assertions are macOS-only because they use NSPasteboard via osascript. Requires
 * the pro package to be present - skipped in a core-only checkout, exactly as the build gates pro.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import { screenRecordingUnavailableReason } from './helpers/permissions'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Mirrors electron.vite.config's proExists gate: without the pro package, OFFGRID_PRO=1
// can't activate pro features, so these surfaces would render the free upgrade screen.
const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const execFileAsync = promisify(execFile)

let app: ElectronApplication
let page: Page
let userDataDir: string
let binDir: string

const nav = async (label: string): Promise<void> => {
  await page.getByRole('button', { name: label, exact: true }).first().click()
  await page.waitForTimeout(500)
}

// Replay serves the current frame through the local media server
// (http://127.0.0.1:<port>/m/<hash>/<base64url(absolutePath)>), not a custom protocol.
// Assert the rendered frame corresponds to the expected capture by decoding that path
// segment and matching the filename — robust to the /private realpath prefix, the port,
// and the async src swap when navigating frames.
const frameImage = (): ReturnType<Page['locator']> => page.locator('img[src*="/m/"]')
const expectFrameImage = async (expectedPath: string): Promise<void> => {
  await expect
    .poll(
      async () => {
        const src = await frameImage()
          .first()
          .getAttribute('src')
          .catch(() => null)
        if (!src) return null
        const tail = src.split('/').pop()?.split('?')[0] ?? ''
        try {
          return path.basename(Buffer.from(tail, 'base64url').toString('utf8'))
        } catch {
          return null
        }
      },
      { timeout: 20_000 }
    )
    .toBe(path.basename(expectedPath))
}

const waitForCapturedClip = async (
  contentType: 'text' | 'image' | 'file',
  textContent: string | null,
  excludedIds: string[] = []
): Promise<string> =>
  page.evaluate(
    async ({ expectedContentType, expectedTextContent, excludedClipIds }) => {
      const api = (
        window as unknown as {
          api: { proInvoke: (c: string, ...a: unknown[]) => Promise<unknown> }
        }
      ).api
      const deadline = Date.now() + 12000
      while (Date.now() < deadline) {
        const items = (await api.proInvoke('clipboard:list', 50)) as {
          id: string
          contentType: string
          textContent: string | null
        }[]
        const hit = items.find(
          (item) =>
            item.contentType === expectedContentType &&
            item.textContent === expectedTextContent &&
            !excludedClipIds.includes(item.id)
        )
        if (hit) return hit.id
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      throw new Error(
        `Timed out waiting for ${expectedContentType} clipboard item ${String(expectedTextContent)}`
      )
    },
    {
      expectedContentType: contentType,
      expectedTextContent: textContent,
      excludedClipIds: excludedIds
    }
  )

const restoreCapturedClip = async (id: string): Promise<boolean> =>
  page.evaluate(async (clipId) => {
    const api = (
      window as unknown as { api: { proInvoke: (c: string, ...a: unknown[]) => Promise<unknown> } }
    ).api
    return (await api.proInvoke('clipboard:restore', clipId)) as boolean
  }, id)

const expectSystemClipboardText = async (expected: string): Promise<void> => {
  await expect
    .poll(() => app.evaluate(async ({ clipboard }) => clipboard.readText()), { timeout: 3000 })
    .toBe(expected)
}

const launchProTestApp = async (headedForNativeHotkey = false): Promise<void> => {
  app = await launchOffGrid({
    extraArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '1', // force pro on without a license (pro code is bundled in this checkout)
      OFFGRID_SEED: 'force', // core chats, knowledge, and RAG schema used by cross-surface Search
      OFFGRID_SEED_PRO: 'force', // deterministic observations + entities + replay frames (TEMP profile only)
      OFFGRID_BIN_DIR: binDir,
      NODE_ENV: 'production',
      ...(headedForNativeHotkey ? { OFFGRID_E2E_HEADED: '1' } : {})
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Click through onboarding into the app shell.
  for (let i = 0; i < 8; i++) {
    const btn = page.getByRole('button', { name: /Continue|Start using Off Grid AI/i })
    if (!(await btn.isVisible().catch(() => false))) break
    await btn.click()
    await page.waitForTimeout(400)
  }
  try {
    await page.getByRole('button', { name: 'Expand sidebar' }).click({ timeout: 4000 })
  } catch {
    /* already open */
  }
  await page.waitForTimeout(500)
  // Seeding runs async on the main process after IPC setup — give it a beat to land.
  await page.waitForTimeout(1500)
}

test.beforeAll(async () => {
  test.skip(!PRO_PRESENT, 'pro package not present — pro features cannot activate')
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-pro-'))
  binDir = path.join(userDataDir, 'e2e-bin')
  const whisper = path.join(binDir, 'whisper', 'whisper-cli')
  fs.mkdirSync(path.dirname(whisper), { recursive: true })
  fs.writeFileSync(whisper, '#!/bin/sh\nprintf "synthetic e2e dictation\\n"\n', { mode: 0o755 })
  const modelsDir = path.join(userDataDir, 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.writeFileSync(path.join(modelsDir, 'ggml-base.bin'), 'synthetic whisper model')
  await launchProTestApp()
})

test.afterAll(async () => {
  await app?.close()
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('Replay is unlocked in the pro build (renders the manager, not the upgrade screen)', async () => {
  await nav('Replay')
  await expect(page.getByText('Off Grid AI Pro · Available now')).toHaveCount(0)
  // The seeded day has frames, so the film + scrubber render.
  await expect(page.getByText(/frames?$/).first()).toBeVisible()
})

test('Replay moments are backed by a captured screen — connector-only moments are dropped', async () => {
  // Exercise the live crm:replay-* IPC exactly as the screen does (same day window).
  const result = await page.evaluate(async () => {
    const api = (
      window as unknown as { api: Record<string, (...a: unknown[]) => Promise<unknown>> }
    ).api
    const sec = (await api.crmReplayDefaultDay()) as number
    const d = new Date(sec * 1000)
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const s = Math.floor(start / 1000)
    const e = Math.floor((start + 86400000) / 1000)
    const frames = (await api.crmReplayFrames(s, e)) as { ts: number }[]
    const threads = (await api.crmReplayThreads(s, e)) as { entityId?: number }[]
    const seg = threads.find((t) => typeof t.entityId === 'number')
    if (!seg || seg.entityId == null)
      return { ok: false, reason: 'no entity thread', frames: frames.length }
    const day = (await api.crmReplayEntityDay(seg.entityId, s, e)) as {
      scenes: { ts: number; surface: string | null }[]
    }
    return {
      ok: true,
      entityId: seg.entityId,
      frameTs: frames.map((f) => f.ts),
      scenes: day.scenes
    }
  })

  expect(result.ok, `setup: ${(result as { reason?: string }).reason ?? ''}`).toBe(true)
  const r = result as { frameTs: number[]; scenes: { ts: number; surface: string | null }[] }
  // The entity (drawn from a work thread) has on-screen activity this day.
  expect(r.scenes.length).toBeGreaterThan(0)
  // The invariant the fix enforces: every moment shown lines up with a captured
  // screen frame. A connector-only observation (no screenshot) would have a ts with
  // no matching frame — before the fix it leaked through here.
  const frameTs = new Set(r.frameTs)
  for (const sc of r.scenes) {
    const hasFrame = r.frameTs.some((t) => Math.abs(t - sc.ts) <= 5) || frameTs.has(sc.ts)
    expect(hasFrame, `moment at ${sc.ts} (${sc.surface}) has no captured screen`).toBe(true)
  }
})

test('Replay renders every synthetic capture in chronological order with usable timestamps', async () => {
  await nav('Replay')

  const dayWindow = await page.evaluate(async () => {
    const api = (
      window as unknown as { api: Record<string, (...args: unknown[]) => Promise<unknown>> }
    ).api
    const dayStartSec = (await api.crmReplayDefaultDay()) as number
    const day = new Date(dayStartSec * 1000)
    const startSec = Math.floor(
      new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() / 1000
    )
    const endSec = startSec + 86400
    const replayFrames = (await api.crmReplayFrames(startSec, endSec)) as {
      ts: number
      path: string
      app: string | null
      caption: string | null
    }[]
    return {
      startMs: startSec * 1000,
      endMs: endSec * 1000,
      frames: replayFrames.map((frame) => ({
        ...frame,
        fullTime: new Date(frame.ts * 1000).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit'
        }),
        shortTime: new Date(frame.ts * 1000).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit'
        })
      }))
    }
  })
  const capturePaths = fs
    .readdirSync(path.join(userDataDir, 'captures'))
    .filter((name) => /^capture-\d+\.png$/.test(name))
    .filter((name) => {
      const timestamp = Number(/^capture-(\d+)\.png$/.exec(name)![1])
      return timestamp >= dayWindow.startMs && timestamp < dayWindow.endMs
    })
    .sort((a, b) => {
      const timestamp = (name: string): number => Number(/^capture-(\d+)\.png$/.exec(name)![1])
      return timestamp(a) - timestamp(b)
    })
    .map((name) => path.join(userDataDir, 'captures', name))

  const { frames } = dayWindow

  expect(frames.length).toBeGreaterThan(2)
  expect(frames.map((frame) => frame.path)).toEqual(capturePaths)

  const commentary = page.locator('aside')
  const assertCurrentFrame = async (index: number): Promise<void> => {
    const frame = frames[index]!
    await expectFrameImage(frame.path)
    await expect(commentary.getByText(frame.app ?? 'Screen', { exact: true })).toBeVisible()
    await expect(commentary.getByText(frame.fullTime, { exact: true })).toBeVisible()
    if (frame.caption) {
      await expect(commentary.getByText(frame.caption, { exact: true })).toBeVisible()
    }
    await expect(page.getByText(frame.shortTime, { exact: true }).first()).toBeVisible()
    await expect(page.getByText(`${index + 1}/${frames.length}`, { exact: true })).toBeVisible()
  }

  await assertCurrentFrame(frames.length - 1)
  for (let index = frames.length - 2; index >= 0; index--) {
    await page.keyboard.press('ArrowLeft')
    await assertCurrentFrame(index)
  }
  for (let index = 1; index < frames.length; index++) {
    await page.keyboard.press('ArrowRight')
    await assertCurrentFrame(index)
  }
})

test('Search opens Replay at the selected captured moment instead of a timeline boundary', async () => {
  const expected = await page.evaluate(async () => {
    const api = (
      window as unknown as { api: Record<string, (...args: unknown[]) => Promise<unknown>> }
    ).api
    const defaultDaySec = (await api.crmReplayDefaultDay()) as number
    const day = new Date(defaultDaySec * 1000)
    const startSec = Math.floor(
      new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() / 1000
    )
    const frames = (await api.crmReplayFrames(startSec, startSec + 86400)) as {
      ts: number
      path: string
      app: string | null
      caption: string | null
    }[]
    const middle = (frames.length - 1) / 2
    const interiorIndices = frames
      .map((_, index) => index)
      .filter((index) => index > 0 && index < frames.length - 1)
      .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))

    for (const selectedIndex of interiorIndices) {
      const selected = frames[selectedIndex]!
      const terms = (selected.caption?.match(/[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*/g) ?? [])
        .filter((term) => term.length >= 7)
        .sort((a, b) => b.length - a.length)
      for (const query of terms) {
        const hits = (await api.universalSearch(query, {
          limit: 8,
          semantic: false
        })) as {
          kind: string
          title: string
          snippet: string
          ts: number
          imagePath: string | null
        }[]
        const hitIndex = hits.findIndex(
          (candidate) => candidate.kind === 'screen' && candidate.imagePath === selected.path
        )
        const hit = hits[hitIndex]
        if (hit) {
          return {
            query,
            hit,
            hitIndex,
            selected,
            selectedIndex,
            frameCount: frames.length,
            fullTime: new Date(selected.ts * 1000).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
              second: '2-digit'
            })
          }
        }
      }
    }
    return null
  })

  expect(expected).not.toBeNull()
  if (!expected) throw new Error('Expected the synthetic search hit to have a Replay frame')
  expect(expected.selectedIndex).toBeGreaterThan(0)
  expect(expected.selectedIndex).toBeLessThan(expected.frameCount - 1)
  expect(expected.hit.imagePath).toBe(expected.selected.path)

  await page.keyboard.press('Meta+K')
  const search = page.getByRole('dialog', { name: 'Search Off Grid AI' })
  await expect(search).toBeVisible()
  await search.getByRole('combobox').fill(expected.query)
  const result = search
    .getByText('Results', { exact: true })
    .locator('..')
    .getByRole('option')
    .nth(expected.hitIndex)
  await expect(result).toBeVisible()
  await expect(result).toContainText(expected.hit.title)
  await expect(result).toContainText(expected.hit.snippet)
  await result.click()

  await expect(search).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Replay', exact: true })).toBeVisible()
  await expectFrameImage(expected.selected.path)
  const commentary = page.locator('aside')
  await expect(
    commentary.getByText(expected.selected.app ?? 'Screen', { exact: true })
  ).toBeVisible()
  await expect(commentary.getByText(expected.fullTime, { exact: true })).toBeVisible()
  await expect(commentary.getByText(expected.hit.snippet, { exact: true })).toBeVisible()
  await expect(
    page.getByText(`${expected.selectedIndex + 1}/${expected.frameCount}`, { exact: true })
  ).toBeVisible()
})

test('Capture and processing share one actionable Settings detail with keyboard drill-back', async () => {
  // Pause/Resume/Restart only render while capture is permitted; a denied host shows the
  // product's "Review permissions" state instead, which is correct and not what this asserts.
  const screenRecordingReason = await screenRecordingUnavailableReason(app)
  test.skip(screenRecordingReason !== null, screenRecordingReason ?? '')
  await nav('Settings')
  await page.getByRole('button', { name: /Capture & processing/ }).click()

  await expect(page.getByText('Pipeline: Accessibility text + local vision')).toBeVisible()
  await expect(page.getByText('Frame queue', { exact: true })).toBeVisible()
  const captureActions = page.getByRole('button', {
    name: /^(Pause capture|Resume capture|Restart capture)$/
  })
  await expect(captureActions).toHaveCount(1)
  await expect(captureActions).toBeEnabled()
  await expect(page.getByRole('button', { name: /Re-process today/ })).toBeVisible()
  await expect(page.getByText('Proactive delivery', { exact: true })).toBeVisible()
  await expect(page.getByText('Model memory', { exact: true })).toBeVisible()
  await expect(page.getByText('Processing priority', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/pro-capture-processing.png', fullPage: true })

  await page.keyboard.press('Meta+[')
  await expect(page.getByText(/All settings/i)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Capture & processing/ })).toBeVisible()
})

test('Clipboard is unlocked in the pro build', async () => {
  await nav('Clipboard')
  await expect(page.getByText('Off Grid AI Pro · Available now')).toHaveCount(0)
  await expect(page.getByPlaceholder('Search content or tags…')).toBeVisible()
})

test('Clipboard quick-open renders populated content on the first native hotkey press', async () => {
  if (process.platform === 'darwin') {
    // This is the only journey that must inject a real macOS key event. The normal E2E launch is
    // deliberately non-focusable so it cannot steal a developer's keyboard; AppleScript cannot
    // target that process. Relaunch this one journey with the existing headed E2E override, then
    // restore the headless app for every later test.
    await app.close()
    await launchProTestApp(true)
  }
  try {
    await nav('Clipboard')
    if (process.platform === 'darwin') {
      expect(
        await app.evaluate(({ globalShortcut }) =>
          globalShortcut.isRegistered('CommandOrControl+Shift+C')
        )
      ).toBe(true)
      await app.evaluate(({ app: electronApp, BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.show()
        electronApp.focus({ steal: true })
      })
      const focused = await expect
        .poll(
          () =>
            app.evaluate(
              ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused() ?? false
            ),
          { timeout: 5_000 }
        )
        .toBe(true)
        .then(() => true)
        .catch(() => false)
      const electronPid = app.process().pid
      const { stdout: frontmostOutput } = await execFileAsync('/usr/bin/osascript', [
        '-e',
        'tell application "System Events" to unix id of first application process whose frontmost is true'
      ])
      const frontmostPid = Number.parseInt(frontmostOutput.trim(), 10)
      test.skip(
        !focused || frontmostPid !== electronPid,
        'requires unlocked macOS session with the headed E2E app frontmost'
      )
    }
    // Electron emits the window event at construction time, while its URL is still about:blank.
    // Capture that first window, then prove that the same window reaches the clipboard route.
    const popupOpened = app.waitForEvent('window', { timeout: 10_000 })
    if (process.platform === 'darwin') {
      await execFileAsync('/usr/bin/osascript', [
        '-e',
        'tell application "System Events" to keystroke "c" using {command down, shift down}'
      ])
    } else {
      await page.getByRole('button', { name: 'Open quick clipboard' }).click()
    }
    const popup = await popupOpened
    await popup.waitForURL(/#clip-popup$/, { timeout: 10_000 })
    await popup.waitForLoadState('domcontentloaded')

    await expect(popup.getByPlaceholder('Search content or tags…')).toBeVisible()
    await expect(popup.getByText('Nothing copied yet')).toHaveCount(0)
    await expect(popup.getByText('↑↓ navigate · ↵ paste · esc close')).toBeVisible()
    await popup.screenshot({ path: 'e2e/screenshots/pro-clipboard-quick-open.png' })
    await popup.keyboard.press('Escape')
  } finally {
    if (process.platform === 'darwin') {
      await app.close()
      await launchProTestApp()
    }
  }
})

test('Voice is unlocked in the pro build (renders the dictation library)', async () => {
  await nav('Voice')
  await expect(page.getByText('Off Grid AI Pro · Available now')).toHaveCount(0)
  // The real screen: a search box, the dictation CTA, and the file-transcribe entry.
  await expect(page.getByPlaceholder('Search transcripts')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start dictation' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Transcribe file' })).toBeVisible()
})

test('Start dictation renders the recording widget on the first click', async () => {
  await nav('Voice')
  const overlayOpened = app.waitForEvent('window', {
    predicate: (candidate) => candidate.url().includes('#dictation'),
    timeout: 10_000
  })
  await page.getByRole('button', { name: 'Start dictation' }).first().click()
  const overlay = await overlayOpened
  await overlay.waitForLoadState('domcontentloaded')

  await expect(overlay.getByTitle('Stop dictation')).toBeVisible()
  await expect(overlay.getByText(/to stop/)).toBeVisible()
  await overlay.screenshot({ path: 'e2e/screenshots/pro-dictation-widget.png' })
  await overlay.getByTitle('Stop dictation').click()
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().includes('#dictation')
        )
        return window?.isVisible() ?? false
      })
    )
    .toBe(false)
  await expect(page.getByRole('button', { name: 'Start dictation' })).toBeVisible()
  await overlay.close()
})

test('Vault copy actions write username, revealed password, and URL to the OS clipboard', async () => {
  const entry = {
    title: 'E2E Vault Login',
    username: 'vault-user@offgrid.test',
    password: 'vault-password-e2e',
    url: 'https://vault-e2e.offgrid.test'
  }
  const seeded = await page.evaluate(async (input) => {
    const api = (
      window as unknown as { api: { proInvoke: (c: string, ...a: unknown[]) => Promise<unknown> } }
    ).api
    const initialized = (await api.proInvoke('vault:init', 'vault-master-password')) as {
      ok: boolean
      error?: string
    }
    if (!initialized.ok) return initialized
    return (await api.proInvoke('vault:entries:add', { ...input, type: 'login' })) as {
      ok: boolean
      error?: string
    }
  }, entry)
  expect(seeded.ok, seeded.error).toBe(true)

  await nav('Vault')
  await page.getByRole('button', { name: new RegExp(entry.title) }).click()

  const usernameRow = page.getByText('Username / Email', { exact: true }).locator('..')
  await usernameRow.getByRole('button', { name: 'Copy', exact: true }).click()
  await expectSystemClipboardText(entry.username)

  const passwordRow = page.getByText('Password', { exact: true }).locator('..')
  await passwordRow.getByTitle('Reveal').click()
  await passwordRow.getByRole('button', { name: 'Copy', exact: true }).click()
  await expectSystemClipboardText(entry.password)

  const websiteRow = page.getByText('Website', { exact: true }).locator('..')
  await websiteRow.getByRole('button', { name: 'Copy', exact: true }).click()
  await expectSystemClipboardText(entry.url)
})

test('Capturing and restoring text crosses the real OS clipboard and encrypted history', async () => {
  const payload = `off-grid clipboard text ${Date.now()}-${process.pid}`
  await app.evaluate(async ({ clipboard }, text) => {
    clipboard.clear()
    clipboard.writeText(text)
  }, payload)

  const capturedId = await waitForCapturedClip('text', payload)

  await app.evaluate(async ({ clipboard }) => {
    clipboard.writeText('clipboard overwritten before restore')
  })
  expect(await restoreCapturedClip(capturedId)).toBe(true)
  await expectSystemClipboardText(payload)
})

test('Capturing a pixel image persists its bytes and restores the bitmap', async () => {
  const existingImageIds = await page.evaluate(async () => {
    const api = (
      window as unknown as { api: { proInvoke: (c: string, ...a: unknown[]) => Promise<unknown> } }
    ).api
    const items = (await api.proInvoke('clipboard:list', 50, 'image')) as { id: string }[]
    return items.map((item) => item.id)
  })
  const sharp = (await import('sharp')).default
  const png = await sharp({
    create: { width: 37, height: 29, channels: 3, background: { r: 28, g: 211, b: 153 } }
  })
    .png()
    .toBuffer()
  await app.evaluate(async ({ clipboard, nativeImage }, base64) => {
    clipboard.clear()
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(base64, 'base64')))
  }, png.toString('base64'))

  const capturedId = await waitForCapturedClip('image', null, existingImageIds)
  await app.evaluate(async ({ clipboard }) =>
    clipboard.writeText('image overwritten before restore')
  )
  expect(await restoreCapturedClip(capturedId)).toBe(true)

  const restored = await app.evaluate(async ({ clipboard }) => {
    const image = clipboard.readImage()
    return { empty: image.isEmpty(), size: image.getSize() }
  })
  expect(restored.empty).toBe(false)
  expect(restored.size).toEqual({ width: 37, height: 29 })
})

test('Restoring a copied file puts BOTH the path text and the file-url on the clipboard', async () => {
  // 1. A real file on disk (written from the test process — Playwright's evaluate
  //    sandbox has no `require`), then simulate a Finder "copy file" by putting its
  //    file-url on the OS clipboard. The 500ms poller captures it into history.
  const { pathToFileURL } = await import('url')
  const fp = path.join(userDataDir, 'e2e-clip-sample.txt')
  fs.writeFileSync(fp, 'off-grid clipboard e2e payload')
  const copied = { fp, basename: path.basename(fp), fileUrl: pathToFileURL(fp).href }
  await app.evaluate(async ({ clipboard }, fileUrl) => {
    clipboard.clear()
    clipboard.writeBuffer('public.file-url', Buffer.from(fileUrl, 'utf8'))
  }, copied.fileUrl)

  // 2. Wait for capture, then restore that item via the real IPC.
  const restoredId = await waitForCapturedClip('file', copied.basename)

  expect(await restoreCapturedClip(restoredId)).toBe(true)

  // 3. The multi-flavor write runs through osascript (async); poll the pasteboard.
  const pb = await app.evaluate(async ({ clipboard }) => {
    const deadline = Date.now() + 6000
    let formats: string[] = []
    let text = ''
    while (Date.now() < deadline) {
      formats = clipboard.availableFormats()
      text = clipboard.readText()
      if (formats.includes('text/plain') && formats.includes('text/uri-list')) break
      await new Promise((res) => setTimeout(res, 200))
    }
    return { formats, text }
  })

  // Finder flavor (file-url) AND terminal flavor (plain-text path) both present.
  expect(pb.formats).toContain('text/uri-list')
  expect(pb.formats).toContain('text/plain')
  // The plain text is the file's path (so a terminal paste yields the path).
  expect(pb.text).toContain(copied.basename)
})

test('Restoring a copied IMAGE file still gives the terminal a path (plus pixels)', async () => {
  // An image file is still a file: pasting it into a terminal must yield the path, not
  // nothing. Regression for the image-only branch that wrote pixels and no text.
  const { pathToFileURL } = await import('url')
  // A real 48x48 PNG (a 1x1 is too small for readImage to register as a bitmap).
  const sharp = (await import('sharp')).default
  const png = await sharp({
    create: { width: 48, height: 48, channels: 3, background: { r: 200, g: 30, b: 90 } }
  })
    .png()
    .toBuffer()
  const fp = path.join(userDataDir, 'e2e-clip-image.png')
  fs.writeFileSync(fp, png)
  const copied = { basename: path.basename(fp), fileUrl: pathToFileURL(fp).href }
  await app.evaluate(async ({ clipboard }, fileUrl) => {
    clipboard.clear()
    clipboard.writeBuffer('public.file-url', Buffer.from(fileUrl, 'utf8'))
  }, copied.fileUrl)

  const restoredId = await waitForCapturedClip('file', copied.basename)
  expect(await restoreCapturedClip(restoredId)).toBe(true)

  const pb = await app.evaluate(async ({ clipboard }) => {
    const deadline = Date.now() + 6000
    let formats: string[] = []
    let text = ''
    let imageEmpty = true
    while (Date.now() < deadline) {
      formats = clipboard.availableFormats()
      text = clipboard.readText()
      imageEmpty = clipboard.readImage().isEmpty()
      if (formats.includes('text/plain') && !imageEmpty) break
      await new Promise((res) => setTimeout(res, 200))
    }
    return { formats, text, imageEmpty }
  })

  // Terminal path AND the file-url AND the image pixels — all from one copied image.
  expect(pb.formats).toContain('text/plain')
  expect(pb.text).toContain(copied.basename)
  expect(pb.imageEmpty, 'image pixels still on the clipboard for image editors').toBe(false)
})
