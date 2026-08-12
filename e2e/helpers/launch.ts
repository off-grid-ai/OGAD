import { _electron as electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The ONE seam every spec launches the app through.
 *
 * Two targets, chosen by env so the same specs verify both:
 *
 *   (default)                     -> the DEV build: `electron .` over the source tree
 *   OFFGRID_E2E_TARGET=packaged   -> the PRODUCTION build: the installed, signed, notarized
 *                                    .app bundle
 *
 * Why it matters: a green dev-build run says nothing about the artifact users install. Signing,
 * notarization, the ASAR integrity fuses, and the bundled llama-server/whisper binaries with
 * their @rpath closure only exist in the packaged app — and that is precisely where releases
 * have broken before. Specs previously hardcoded `args: ['.']`, so the production build could
 * not be exercised at all.
 *
 * Callers pass only what varies (env, extra Chromium flags); the target decision lives here,
 * so adding a target needs no spec changes.
 */

const PACKAGED_BUNDLE = process.env.OFFGRID_PACKAGED_APP ?? '/Applications/Off Grid AI Desktop.app'

export const packagedExecutable = (): string =>
  path.join(PACKAGED_BUNDLE, 'Contents', 'MacOS', 'Off Grid AI Desktop')

export const targetIsPackaged = (): boolean => process.env.OFFGRID_E2E_TARGET === 'packaged'

export const packagedAppBundle = (): string => PACKAGED_BUNDLE

/** Reason the packaged target can't run, or null when it can. */
export const packagedTargetUnavailable = (): string | null => {
  if (!targetIsPackaged()) return null
  if (process.platform !== 'darwin') return 'the packaged target is macOS-only'
  if (!fs.existsSync(packagedExecutable())) {
    return `no installed app at ${PACKAGED_BUNDLE} (set OFFGRID_PACKAGED_APP to point elsewhere)`
  }
  return null
}

/**
 * Seed a cached Pro license into the launch profile so pro-dependent specs can run against the
 * PACKAGED build.
 *
 * Why this is needed: getForcedProActivation (src/main/bootstrap/pro-activation.ts) honours
 * OFFGRID_PRO=1 only when NOT packaged — a shipped app deliberately cannot be unlocked by an env
 * var, it must satisfy a real license check. So in a packaged run every pro spec failed with
 * "No handler registered for 'vault:init' / 'clipboard:list'", because pro never activated.
 *
 * Why a CACHED fixture rather than activating per run: each spec uses a fresh temp profile, and
 * Keygen claims a machine slot per device fingerprint. Activating per launch would register a new
 * machine on every app start (20+ per suite run). Instead we activate ONCE out-of-band and copy
 * the resulting license.json + device-fingerprint in, so every run reuses the SAME machine slot
 * and validates offline from cache — zero additional activations.
 *
 * Seeded ONLY when the spec asks for pro (OFFGRID_PRO=1). Specs that pass OFFGRID_PRO=0 assert
 * free-tier UI (locked tabs, upgrade screens) and must stay unlicensed — '0' forces free even
 * when packaged, so those stay deterministic.
 *
 * The fixture lives OUTSIDE the repo (default ~/.offgrid-e2e-license) and holds a real license
 * key — never commit it, never print its contents.
 */
const LICENSE_FIXTURE_FILES = ['license.json', 'device-fingerprint']

export const licenseFixtureDir = (): string =>
  process.env.OFFGRID_E2E_LICENSE_FIXTURE ?? path.join(os.homedir(), '.offgrid-e2e-license')

export const licenseFixtureAvailable = (): boolean =>
  LICENSE_FIXTURE_FILES.every((f) => fs.existsSync(path.join(licenseFixtureDir(), f)))

const seedLicense = (env: Record<string, string>): void => {
  const userDataDir = env.OFFGRID_USER_DATA
  if (!userDataDir || env.OFFGRID_PRO !== '1' || !licenseFixtureAvailable()) return
  fs.mkdirSync(userDataDir, { recursive: true })
  for (const file of LICENSE_FIXTURE_FILES) {
    fs.copyFileSync(path.join(licenseFixtureDir(), file), path.join(userDataDir, file))
  }
}

/**
 * Collect what the e2e run actually executes, so it stops being invisible.
 *
 * 25 specs drive the real app - devices-sync.spec.ts alone stands up a synthetic peer with a real
 * SyncEngine, StateSync, FileTransferManager and ClipboardSyncCoordinator - and none of it counted
 * towards coverage, because Playwright launches Electron as its own process and nothing instrumented it.
 * Files exercised only here read 0%, and "absent from the report" read as "nothing executes this".
 *
 * Node writes V8 coverage itself when NODE_V8_COVERAGE names a directory, so the main process needs no
 * instrumentation library - only the variable. Each launch appends its own JSON files, so a whole suite
 * accumulates into one directory and c8 turns it into an Istanbul report afterwards:
 *
 *   OFFGRID_E2E_COVERAGE=/tmp/cov-e2e npm run test:e2e
 *   ../shared/node_modules/.bin/c8 report --temp-directory=/tmp/cov-e2e \
 *     --src=src --src=pro --reporter=json --report-dir=/tmp/cov-e2e-istanbul
 *
 * Off by default: writing coverage on every developer run costs time and disk for no benefit, and a
 * variable that is absent leaves Electron behaving exactly as it did before.
 *
 * The RENDERER is not covered by this - V8 coverage here is the main process only. Renderer coverage
 * needs page.coverage.startJSCoverage per spec plus a sourcemap remap through the electron-vite bundle,
 * which is the remaining half of this job.
 */
const withCoverage = (env: Record<string, string>): Record<string, string> => {
  const directory = process.env.OFFGRID_E2E_COVERAGE
  if (!directory) return env
  fs.mkdirSync(directory, { recursive: true })
  return { ...env, NODE_V8_COVERAGE: directory }
}

export interface LaunchOptions {
  env?: Record<string, string | undefined>
  /** Extra Chromium/Electron flags (e.g. fake media devices). Applied to both targets. */
  extraArgs?: string[]
}

export const launchOffGrid = async (options: LaunchOptions = {}): Promise<ElectronApplication> => {
  const env = withCoverage({ ...process.env, ...options.env } as Record<string, string>)
  const extraArgs = options.extraArgs ?? []

  if (targetIsPackaged()) {
    const unavailable = packagedTargetUnavailable()
    if (unavailable) throw new Error(`Cannot launch the packaged app: ${unavailable}`)
    // A packaged build ignores OFFGRID_PRO=1, so pro specs need a real cached license.
    seedLicense(env)
    // A packaged app loads its own app.asar — passing '.' would point it at the repo instead.
    return electron.launch({ executablePath: packagedExecutable(), args: extraArgs, env })
  }
  // The DEV target needs it too, and for a different reason than pro activation: OFFGRID_PRO=1 unlocks
  // the pro SURFACES, but joining a mesh consumes a licensed seat, so pairing asks the entitlement layer
  // for a credential and refuses with "Pro license pairing is unavailable on this device" when there is
  // none. Seeding is a no-op when the spec asked for a free build or the fixture is absent, so specs that
  // assert free-tier UI stay unlicensed and deterministic.
  seedLicense(env)
  return electron.launch({ args: ['.', ...extraArgs], env })
}
