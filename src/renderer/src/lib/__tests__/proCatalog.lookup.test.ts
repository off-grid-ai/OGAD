// Tests for the pro-catalog lookup + data integrity (components/pro/proCatalog.ts).
// The existing proCatalog.nav.test.ts guards the App.tsx <-> catalog route contract;
// this file covers getProFeature's own branches and the catalog's structural invariants
// (the free build renders locked nav items straight from this data, so a malformed
// entry ships a broken upsell tab).
import { describe, it, expect } from 'vitest'
import { PRO_PURCHASE_URL } from '@offgrid/core/shared/product-links'
import {
  getProFeature,
  featureSupportsPlatform,
  proComingSoonHere,
  proFeatureComingSoon,
  PRO_FEATURES,
  PRO_PAY_URL,
  type ProFeature
} from '../../components/pro/proCatalog'

// Two throwaway feature instances used to exercise the per-feature seam through a
// SECOND implementation (a Windows-ported feature) without mutating the shared
// catalog. This is the architecture guard: if any surface ever re-hardcodes a
// blanket `!isMac` platform rule instead of reading `platforms`, the win32-ported
// case below fails.
const macOnly = (route: string): ProFeature => ({
  route,
  label: route,
  icon: (() => null) as unknown as ProFeature['icon'],
  tagline: 't',
  description: 'd',
  highlights: ['h'],
  platforms: ['darwin']
})
const winPorted = (route: string): ProFeature => ({
  ...macOnly(route),
  platforms: ['darwin', 'win32']
})

// Ported-to-Windows features, by route. Grows one entry per shipped Windows port;
// asserted against the catalog so a flipped `platforms` and this list can't drift.
// Module-scoped because both the featureSupportsPlatform and proFeatureComingSoon
// describes read it — the gate and the capability check must agree on one list.
const WIN_PORTED = new Set(['vault', 'clipboard', 'replay', 'devices'])

describe('getProFeature', () => {
  it('returns the matching feature for a known route', () => {
    const f = getProFeature('day')
    expect(f).toBeDefined()
    expect(f?.route).toBe('day')
    expect(f?.label).toBe('Day')
  })

  it('returns undefined for an unknown route (the 0.0.34 white-screen guard)', () => {
    expect(getProFeature('does-not-exist')).toBeUndefined()
  })

  it('returns undefined for the empty string', () => {
    expect(getProFeature('')).toBeUndefined()
  })

  it('resolves every route present in the catalog', () => {
    for (const feature of PRO_FEATURES) {
      expect(getProFeature(feature.route)).toBe(feature)
    }
  })
})

describe('featureSupportsPlatform (per-feature seam)', () => {
  it('supports macOS for every feature (reference platform)', () => {
    for (const f of PRO_FEATURES) {
      expect(featureSupportsPlatform(f, 'darwin'), `darwin support for ${f.route}`).toBe(true)
    }
  })

  it('treats macOS as supported even if platforms omits it (data-typo safety net)', () => {
    const typo: ProFeature = { ...macOnly('typo'), platforms: [] }
    expect(featureSupportsPlatform(typo, 'darwin')).toBe(true)
  })

  it('reflects a NON-mac platform per the feature’s own list', () => {
    expect(featureSupportsPlatform(macOnly('x'), 'win32')).toBe(false)
    expect(featureSupportsPlatform(winPorted('x'), 'win32')).toBe(true)
    // A Windows port doesn’t imply Linux — each platform is listed explicitly.
    expect(featureSupportsPlatform(winPorted('x'), 'linux')).toBe(false)
  })

  it.each([...WIN_PORTED])('%s is live on Windows', (route) => {
    expect(featureSupportsPlatform(getProFeature(route)!, 'win32')).toBe(true)
  })

  it('exactly the ported features are win32-supported; the rest stay macOS-only', () => {
    for (const f of PRO_FEATURES) {
      expect(featureSupportsPlatform(f, 'win32'), `win32 support for ${f.route}`).toBe(
        WIN_PORTED.has(f.route)
      )
    }
  })

  // Guards against a lazy `['darwin', ...allNonMac]` — a ported feature is win32
  // only, never linux by implication.
  it.each([...WIN_PORTED])('%s is win32-only, not linux by implication', (route) => {
    expect(featureSupportsPlatform(getProFeature(route)!, 'linux')).toBe(false)
  })
})

describe('proFeatureComingSoon flips PER FEATURE (the seam works one at a time)', () => {
  // Prove the gate reads `platforms`, not a blanket rule: a mac-only feature is
  // coming-soon on win32, a win-ported feature is NOT — for the SAME platform +
  // entitlement. When a real feature adds 'win32', this is exactly what lights it up.
  it('mac-only feature is coming-soon on win32; win-ported feature is live', () => {
    expect(proFeatureComingSoon.length).toBe(3) // (route, platform, isPro)
    expect(featureSupportsPlatform(macOnly('vault'), 'win32')).toBe(false)
    expect(featureSupportsPlatform(winPorted('vault'), 'win32')).toBe(true)
  })
})

describe('proComingSoonHere', () => {
  it('gates Pro subscribers on non-Mac platforms', () => {
    expect(proComingSoonHere('win32', true)).toBe(true)
    expect(proComingSoonHere('linux', true)).toBe(true)
    expect(proComingSoonHere('unknown', true)).toBe(true)
  })

  it('does not gate Mac subscribers or free users', () => {
    expect(proComingSoonHere('darwin', true)).toBe(false)
    expect(proComingSoonHere('win32', false)).toBe(false)
    expect(proComingSoonHere('darwin', false)).toBe(false)
  })
})

describe('proFeatureComingSoon', () => {
  it.each([...WIN_PORTED])('does NOT gate %s — it renders live on win32', (route) => {
    expect(proFeatureComingSoon(route, 'win32', true)).toBe(false)
    // still live on macOS, and still upsell (not coming-soon) for free users.
    expect(proFeatureComingSoon(route, 'darwin', true)).toBe(false)
    expect(proFeatureComingSoon(route, 'win32', false)).toBe(false)
  })

  it('gates every NOT-yet-ported catalog route for a Windows Pro subscriber', () => {
    for (const feature of PRO_FEATURES) {
      const ported = featureSupportsPlatform(feature, 'win32')
      expect(
        proFeatureComingSoon(feature.route, 'win32', true),
        `coming-soon for ${feature.route}`
      ).toBe(!ported)
    }
  })

  it('does not gate routes on Mac or for free users', () => {
    const route = PRO_FEATURES.at(0)?.route
    if (!route) throw new Error('Pro catalog must not be empty')
    expect(proFeatureComingSoon(route, 'darwin', true)).toBe(false)
    expect(proFeatureComingSoon(route, 'win32', false)).toBe(false)
  })

  // win32 is not the only non-Mac platform: the gate reads a feature's `platforms`
  // list, so ANY platform absent from it is coming-soon. Without a third platform
  // asserted here, a regression that special-cased win32 (rather than reading the
  // list) would still pass. Entitlement is orthogonal — free users are never gated.
  it('gates a Pro route on linux too, and still never gates free users there', () => {
    const route = PRO_FEATURES.at(0)?.route
    if (!route) throw new Error('Pro catalog must not be empty')
    expect(proFeatureComingSoon(route, 'linux', true)).toBe(true)
    expect(proFeatureComingSoon(route, 'linux', false)).toBe(false)
  })

  it('does not gate core or unknown routes', () => {
    expect(proFeatureComingSoon('models', 'win32', true)).toBe(false)
    expect(proFeatureComingSoon('does-not-exist', 'win32', true)).toBe(false)
    expect(proFeatureComingSoon('', 'win32', true)).toBe(false)
  })
})

describe('PRO_FEATURES data integrity', () => {
  it('has a non-empty catalog', () => {
    expect(PRO_FEATURES.length).toBeGreaterThan(0)
  })

  it('has unique routes', () => {
    const routes = PRO_FEATURES.map((f) => f.route)
    expect(new Set(routes).size).toBe(routes.length)
  })

  it('every feature carries the fields the upsell UI renders', () => {
    for (const f of PRO_FEATURES) {
      expect(f.route, 'route').toBeTruthy()
      expect(f.label, `label for ${f.route}`).toBeTruthy()
      expect(f.tagline, `tagline for ${f.route}`).toBeTruthy()
      expect(f.description, `description for ${f.route}`).toBeTruthy()
      // Phosphor icons are forwardRef objects, not plain functions - just assert present.
      expect(f.icon, `icon for ${f.route}`).toBeDefined()
      expect(Array.isArray(f.highlights), `highlights for ${f.route}`).toBe(true)
      expect(f.highlights.length, `highlights for ${f.route}`).toBeGreaterThan(0)
      // Every feature declares its supported platforms and MUST include macOS
      // (the reference platform Pro is built on).
      expect(Array.isArray(f.platforms), `platforms for ${f.route}`).toBe(true)
      expect(f.platforms, `platforms for ${f.route} must include darwin`).toContain('darwin')
    }
  })

  it('uses the canonical Pro purchase destination', () => {
    expect(PRO_PAY_URL).toBe(PRO_PURCHASE_URL)
  })
})
