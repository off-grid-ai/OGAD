// Smoke test for a BUILT/packaged Off Grid AI app (assertion-based).
// Launches the app on an isolated profile, drives onboarding, and asserts every
// core screen renders + the onboarding orbit isn't collapsed.
//
//   APP_BIN="/Volumes/Off Grid AI 0.0.18-arm64/Off Grid AI.app/Contents/MacOS/Off Grid AI" \
//   node scripts/smoke-test.mjs
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// APP_BIN = a packaged app executable; unset = launch the local build (`electron .`).
const APP_BIN = process.env.APP_BIN

const profile = mkdtempSync(join(tmpdir(), 'ogsmoke-'))
let pass = 0,
  fail = 0
const smoke = {
  wait(ms) {
    return new Promise((resolveWait) => setTimeout(resolveWait, ms))
  },
  record(name, condition) {
    if (condition) {
      pass++
      console.log(`  ✓ ${name}`)
    } else {
      fail++
      console.error(`  ✗ ${name}`)
    }
  },
  async pageText() {
    return (
      (await win
        .locator('body')
        .innerText()
        .catch(() => '')) || ''
    )
  },
  async clickContinue() {
    const btn = win.getByRole('button', { name: /Continue|Start using Off Grid AI/i }).first()
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {})
      await smoke.wait(1400)
      return true
    }
    return false
  },
  async navigate(label, expectedContent) {
    try {
      await win.getByRole('button', { name: label, exact: false }).first().click({ timeout: 5000 })
      await smoke.wait(1400)
      return expectedContent.test(await smoke.pageText())
    } catch {
      return false
    }
  }
}

const launchOpts = APP_BIN ? { executablePath: APP_BIN, args: [] } : { args: ['.'] }
const app = await electron.launch({
  ...launchOpts,
  env: { ...process.env, OFFGRID_USER_DATA: profile, OFFGRID_PRO: '0' }
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  if (w) {
    w.setSize(1480, 940)
    w.center()
  }
})
await smoke.wait(3500)

try {
  // 1) Onboarding shows on a fresh profile (step 1)
  smoke.record(
    'onboarding screen appears',
    /Continue|Every model|Private AI|Off Grid AI/i.test(await smoke.pageText())
  )

  // 2) Advance to the orbit step + assert the modality cards aren't collapsed.
  //    The orbit lives on step 2, so navigate there before measuring.
  await smoke.clickContinue() // step 1 -> step 2 (orbit)
  const labels = ['Image', 'Vision', 'Chat', 'Projects', 'Speech', 'Voice']
  const boxes = []
  for (const l of labels) {
    const b = await win
      .getByText(l, { exact: true })
      .first()
      .boundingBox()
      .catch(() => null)
    if (b) boxes.push({ l, x: b.x + b.width / 2, y: b.y + b.height / 2 })
  }
  let minDist = Infinity
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      minDist = Math.min(minDist, Math.hypot(boxes[i].x - boxes[j].x, boxes[i].y - boxes[j].y))
    }
  smoke.record(
    `onboarding orbit cards spaced (${boxes.length} cards, min gap ${Math.round(minDist)}px > 40)`,
    boxes.length >= 4 && minDist > 40
  )

  // 3) Finish onboarding into the app
  for (let i = 0; i < 4; i++) {
    if (!(await smoke.clickContinue())) break
  }
  await smoke.wait(1500)
  const appText = await smoke.pageText()

  // 4) No hard "Setup Required" wall in the core build
  smoke.record('no "Setup Required" wall (core build)', !/Setup Required/i.test(appText))

  // 5) Lands in the app (Models is the free default)
  smoke.record('lands on Models screen', /Models|Download models/i.test(appText))

  // 6) Core screens render
  smoke.record(
    'Chat renders',
    await smoke.navigate('Chat', /Start a conversation|Ask anything|New chat/i)
  )
  smoke.record('Projects renders', await smoke.navigate('Projects', /Projects|New chat|knowledge/i))
  smoke.record(
    'Gateway renders',
    await smoke.navigate('Gateway', /Gateway|127\.0\.0\.1:7878|OpenAI/i)
  )
  smoke.record(
    'Integrations renders',
    await smoke.navigate('Integrations', /Integrations|Connect a tool|Connect/i)
  )
} catch (e) {
  fail++
  console.error('  ✗ exception:', e.message)
} finally {
  await app.close()
}

console.log(`\nSMOKE: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
