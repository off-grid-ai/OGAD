/**
 * Guards the "coming soon to your device" notice on the Pro UPGRADE (buy) screen.
 *
 * A prospective buyer on a platform where a feature isn't live yet must be told so -
 * otherwise they could buy expecting it to run locally. The notice is now gated
 * PER FEATURE (`platformNotice`, computed from `featureSupportsPlatform` +
 * `currentPlatform`), not a blanket `!isMac()`: a feature that IS ported to this
 * platform (e.g. Vault on Windows) shows no warning, while a not-yet-ported feature
 * still does. This is a source-reading guard - the repo has no React render harness
 * (no jsdom/testing-library), so we assert the wiring + copy by reading the
 * component, matching the pattern in main/__tests__/extract-prompt.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/src/components/pro/UpgradeScreen.tsx'),
  'utf-8'
)

// Scope every assertion to the UPGRADE (buy) branch of the aside ternary, so a test
// can't pass if the notice or the buy CTA drifts into the coming-soon branch. The
// upgrade branch runs from the per-feature notice gate to the shared cross-sell block.
const UPGRADE_BRANCH = SRC.slice(SRC.indexOf('platformNotice &&'), SRC.indexOf('Cross-sell'))
// The coming-soon branch is everything in the aside before the upgrade branch.
const COMINGSOON_BRANCH = SRC.slice(SRC.indexOf('You have Pro'), SRC.indexOf('platformNotice &&'))

describe('UpgradeScreen - per-feature "coming soon" notice on the buy screen', () => {
  it('computes the notice per-feature via featureSupportsPlatform + currentPlatform', () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*\bfeatureSupportsPlatform\b[^}]*\}\s*from\s*'\.\/proCatalog'/
    )
    expect(SRC).toMatch(
      /import\s*\{[^}]*\bcurrentPlatform\b[^}]*\}\s*from\s*'@renderer\/lib\/device'/
    )
    // The gate reads the feature's own support, not a blanket platform check.
    expect(SRC).toMatch(/const platformNotice =[\s\S]*featureSupportsPlatform/)
  })

  it('no longer gates the notice on a blanket !isMac()', () => {
    // The per-feature seam replaced the all-or-nothing rule; guard against a regression.
    expect(SRC).not.toMatch(/!isMac\(\)\s*&&/)
  })

  it('scoping anchors exist (guards this test against a refactor of the variants)', () => {
    expect(UPGRADE_BRANCH.length).toBeGreaterThan(0)
    expect(COMINGSOON_BRANCH.length).toBeGreaterThan(0)
  })

  it('gates the notice on the per-feature platformNotice within the upgrade branch', () => {
    expect(UPGRADE_BRANCH).toMatch(/platformNotice &&/)
  })

  it('says coming soon here, and that the licence covers the platforms (upgrade branch)', () => {
    expect(UPGRADE_BRANCH).toMatch(/Coming soon to your \{deviceNoun\(\)\}/)
    // It used to assert /macOS-tested/. That claim is gone on purpose: Windows is a live platform now, so
    // telling a Windows user Pro is "macOS-tested today" and will be enabled "once it is tested" was
    // simply untrue - and it was the first thing they read. What must remain is the honest, narrower
    // pair: this FEATURE runs on Mac today, and the licence covers the platforms.
    expect(UPGRADE_BRANCH).toMatch(/Windows is live/)
    expect(UPGRADE_BRANCH).toMatch(/license covers desktop and mobile/)
    expect(UPGRADE_BRANCH).not.toMatch(/macOS-tested/)
  })

  it('keeps the buy CTA in the upgrade branch (not replaced by the notice)', () => {
    // The purchase path must remain: the license is valid on Mac + phone today.
    expect(UPGRADE_BRANCH).toMatch(/Get Pro/)
    expect(UPGRADE_BRANCH).toMatch(/PRO_PAY_URL/)
    // ...and the buy CTA must NOT have leaked into the coming-soon branch.
    expect(COMINGSOON_BRANCH).not.toMatch(/PRO_PAY_URL/)
  })

  it('follows brand voice: uses " - " not an em dash in the notice copy', () => {
    // Em dash is unambiguous - code never uses it, so scanning the block is safe.
    const notice = UPGRADE_BRANCH.slice(0, UPGRADE_BRANCH.indexOf('Unlock Pro'))
    expect(notice).not.toMatch(/—/)
    expect(notice).toMatch(/ - /) // the brand-approved separator
  })
})
