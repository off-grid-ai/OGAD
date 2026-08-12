/**
 * Activate the Pro licence ONCE for the e2e fixture, using the dev build itself.
 *
 * Why this exists: a licence cache is sealed with macOS safeStorage, and a Keychain item is ACL'd to the
 * application that created it. A licence activated by the SIGNED PACKAGED app therefore cannot be read by
 * the dev build the e2e launches (`electron .`) - it reads back as isPro:false, and every licensed spec
 * fails with "At least one device must have an active Pro license" while a perfectly good licence sits on
 * disk. So the fixture has to be created BY the dev build.
 *
 * No UI is involved: the app exposes license.activate over IPC, so this drives the same code path the
 * licence field does, then keeps the resulting profile as the fixture that e2e/helpers/launch.ts seeds
 * from. Run it once per machine (and again after a licence change):
 *
 *   node scripts/seed-e2e-license.mjs
 *
 * Reads the key from ~/.offgrid-e2e-license/key.txt (never committed, never printed).
 */
import { _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FIXTURE_DIR = process.env.OFFGRID_E2E_LICENSE_FIXTURE ?? path.join(os.homedir(), '.offgrid-e2e-license')
const PROFILE_DIR = path.join(FIXTURE_DIR, 'profile')
const KEY_FILE = path.join(FIXTURE_DIR, 'key.txt')
const COPY_OUT = ['license.json', 'device-fingerprint']

const fail = (message) => {
  console.error(`[seed-license] ${message}`)
  process.exit(1)
}

if (!fs.existsSync(KEY_FILE)) fail(`no key at ${KEY_FILE} - put the licence key there first`)
const key = fs.readFileSync(KEY_FILE, 'utf8').trim()
if (!key) fail(`${KEY_FILE} is empty`)

// A persistent profile, not a temp one: the whole point is a cache that survives this process.
fs.mkdirSync(PROFILE_DIR, { recursive: true })

const app = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    OFFGRID_USER_DATA: PROFILE_DIR,
    OFFGRID_PRO: '1',
    // Never show a window for this: it is a one-shot activation, not a session.
    OFFGRID_E2E_HEADLESS: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  const before = await page.evaluate(() => window.api.license.status())
  console.log(`[seed-license] before: isPro=${before?.isPro}`)

  // Activation waits up to 5s for pro's entitlement owner to register and, if it is not there yet,
  // reports "network_unavailable" - a READINESS timeout wearing a network error's clothes. Activating the
  // moment the window loads therefore fails on a cold start while the network is perfectly fine. So this
  // retries, and treats that particular reason as "not ready yet" rather than as a verdict.
  let result
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    result = await page.evaluate(async (licenceKey) => {
      try {
        return { ok: true, value: await window.api.license.activate(licenceKey) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }, key)
    const reason = result.ok ? result.value?.reason : undefined
    if (result.ok && result.value?.ok) break
    console.log(`[seed-license] attempt ${attempt}: ${result.ok ? (reason ?? 'refused') : result.error}`)
    if (result.ok && reason && reason !== 'network_unavailable') break
    await new Promise((resolve) => setTimeout(resolve, 4000))
  }
  if (!result.ok) fail(`activation threw: ${result.error}`)

  // Poll rather than assume: activation registers a machine over the network, and the cache is written
  // after that returns.
  let status = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    status = await page.evaluate(() => window.api.license.status())
    if (status?.isPro) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  if (!status?.isPro) {
    fail(`activation did not take: ${JSON.stringify({ status, outcome: result.value })}`)
  }
  console.log(`[seed-license] activated: tier=${status.tier ?? 'pro'}`)
} finally {
  await app.close().catch(() => {})
}

// The two files launch.ts seeds into each run's temp profile.
const missing = COPY_OUT.filter((name) => !fs.existsSync(path.join(PROFILE_DIR, name)))
if (missing.length) fail(`activation left no ${missing.join(', ')} in ${PROFILE_DIR}`)
for (const name of COPY_OUT) {
  fs.copyFileSync(path.join(PROFILE_DIR, name), path.join(FIXTURE_DIR, name))
}
console.log(`[seed-license] fixture updated: ${COPY_OUT.join(', ')} in ${FIXTURE_DIR}`)
