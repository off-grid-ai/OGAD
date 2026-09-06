/* eslint-disable @typescript-eslint/explicit-function-return-type -- Playwright JavaScript harness */
// PRO screenshot harness — launches the built app with Pro ACTIVE and a SYNTHETIC
// demo seed in an ISOLATED profile (never the real DB), then captures each pro
// screen. Output: pro/docs/screenshots/ (private repo). No blur — data is fake.
//   node scripts/screenshots-pro.mjs
import { _electron as electron } from '@playwright/test'
import { mkdirSync } from 'fs'
import {
  createEvidenceProfile,
  evidenceEnvironment,
  removeEvidenceProfile
} from './release-evidence-profile.mjs'

const OUT = 'pro/docs/screenshots'
mkdirSync(OUT, { recursive: true })
const PROFILE = createEvidenceProfile('pro-tour')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
// Remove demo-only overlays before each shot: the setup nudge and the meeting
// recording indicator (auto-triggered; not meaningful in a static demo).
const killNudge = (win) =>
  win
    .evaluate(() => {
      for (const el of document.querySelectorAll('div')) {
        const t = el.textContent || ''
        if (
          el.className?.includes?.('fixed') &&
          (t.includes('Finish setting up Off Grid AI Pro') || t.includes('click to stop'))
        )
          el.remove()
      }
    })
    .catch(() => {})

async function launch({ seedCore = false, seedPro = false } = {}) {
  const app = await electron.launch({
    args: ['.'],
    env: evidenceEnvironment({
      profile: PROFILE,
      pro: true,
      seedCore,
      seedPro,
      extra: { OFFGRID_NO_SERVICES: '1' }
    })
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (!w) return
    // Capture at the largest available display for a roomy view of the bento.
    const displays = screen.getAllDisplays()
    const big = displays.reduce(
      (a, b) => (b.workAreaSize.width > a.workAreaSize.width ? b : a),
      displays[0]
    )
    const { x, y, width, height } = big.workArea
    w.setBounds({ x, y, width, height })
  })
  return { app, win }
}

// Launch 1: seed the isolated DB (main process) + mark onboarding done, then quit.
let { app, win } = await launch({ seedCore: true, seedPro: true })
await wait(6000) // let activateMain + seedProDemo finish
await win.evaluate(async () => {
  localStorage.setItem('onboarding_completed', 'true')
  localStorage.setItem('offgrid:disable-capture', '1') // no live auto-record in the demo
  localStorage.setItem('og-theme', 'light') // capture in light mode (uniform gallery)
  // The Notifications inbox loads from localStorage (useNotifications), not the DB,
  // so seed synthetic approvals + to-dos here or the screen captures empty. Same
  // fictional people/projects as the rest of the demo seed.
  const min = (m) => new Date(Date.now() - m * 60000).toISOString()
  localStorage.setItem(
    'my-memories-notifications',
    JSON.stringify([
      {
        id: 'n1',
        type: 'approval',
        title: 'Reply to Sam Shafer re: pilot rollout',
        message: 'Off Grid AI drafted a reply about the v0.8.0 timeline. Approve to send.',
        timestamp: min(4),
        read: false,
        approvalId: 1
      },
      {
        id: 'n2',
        type: 'todo',
        title: "Review Tom's fix for the llama.cpp UI regression",
        message: 'Pulled from your screen activity in the llama.cpp repo.',
        timestamp: min(38),
        read: false,
        actionId: 1
      },
      {
        id: 'n3',
        type: 'approval',
        title: 'Create Linear issue: /v1/images edits endpoint',
        message: 'Add to the Gateway v1 milestone with the streaming acceptance criteria.',
        timestamp: min(72),
        read: false,
        approvalId: 2
      },
      {
        id: 'n4',
        type: 'todo',
        title: 'Send Priya the BFSI compliance deck before Friday',
        message: 'And loop in Daniel on the Northwind metrics before the kickoff.',
        timestamp: min(96),
        read: true,
        actionId: 2
      },
      {
        id: 'n5',
        type: 'todo',
        title: 'Have the privacy one-pager ready for Helio Labs',
        message: 'Extracted from your dictation about the pilot kickoff prep.',
        timestamp: min(140),
        read: false,
        actionId: 3
      },
      {
        id: 'n6',
        type: 'info',
        title: 'Synced with Priya on the v0.8.0 cut',
        message: 'Day view updated with the latest timeline.',
        timestamp: min(220),
        read: true
      }
    ])
  )
  // Build the keyword search index over the seeded observations so Search has results.
  try {
    await window.api?.proInvoke?.('search:reindex')
  } catch {
    /* model-less FTS still builds */
  }
})
await wait(4000) // let the reindex finish
await app.close()

// Launch 2: into the shell with seeded data (seed flag set → no re-seed).
;({ app, win } = await launch())
await wait(3500)
const shot = async (name) => {
  await wait(1100)
  await killNudge(win)
  await wait(150)
  await win.screenshot({ path: `${OUT}/${name}.png` })
  console.log('✓', name)
}
const nav = async (label) => {
  try {
    await win.getByRole('button', { name: label, exact: false }).first().click({ timeout: 6000 })
    await wait(1800)
  } catch (e) {
    console.error('nav fail:', label, e.message)
  }
}

try {
  await win.getByRole('button', { name: 'Expand sidebar' }).click({ timeout: 4000 })
} catch {
  /* open */
}
try {
  await win.getByRole('button', { name: 'Dismiss' }).click({ timeout: 3000 })
} catch {
  /* no nudge */
}
await wait(600)
await shot('00-launch')
for (const [label, file] of [
  ['Day', 'pro-day'],
  ['Reflect', 'pro-reflect'],
  ['Replay', 'pro-replay'],
  ['Meetings', 'pro-meetings'],
  ['Actions', 'pro-actions'],
  ['Entities', 'pro-entities'],
  ['Search', 'pro-search'],
  ['Notifications', 'pro-notifications'],
  ['Voice', 'pro-voice'],
  ['Clipboard', 'pro-clipboard']
]) {
  await nav(label)
  if (file === 'pro-search') {
    try {
      const box = win.getByPlaceholder(/Search everything/i)
      await box.click({ timeout: 4000 })
      await box.fill('release notes')
      await wait(2500) // let FTS + semantic results land
    } catch (e) {
      console.error('search type', e.message)
    }
  }
  await shot(file)
}
await app.close()
removeEvidenceProfile(PROFILE)
console.log('done →', OUT)
