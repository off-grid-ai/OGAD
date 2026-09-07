/**
 * Packaging contract for computer use's semantic action rail. Each TCC usage
 * string must survive in electron-builder.yml and the apple-events entitlement in
 * the plist: a hardened-runtime build is refused the capability BEFORE any prompt
 * when its Info.plist key is missing, so a dropped key is a silent, ship-breaking
 * regression (the exact "half-built in the safe direction" failure the computer-use
 * plan warns about). Guarded by reading the source, per CLAUDE.md contract guards.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../../..')
const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
const entitlements = fs.readFileSync(path.join(root, 'build/entitlements.mac.plist'), 'utf8')

// The usage-description keys the semantic rail needs. Calendars and Reminders
// carry BOTH the macOS 14+ FullAccess key and the pre-14 legacy key, because the
// build advertises minimumSystemVersion 13.0.
const REQUIRED_USAGE_KEYS = [
  'NSAppleEventsUsageDescription',
  'NSCalendarsFullAccessUsageDescription',
  'NSCalendarsUsageDescription',
  'NSRemindersFullAccessUsageDescription',
  'NSContactsUsageDescription',
  'NSPhotoLibraryUsageDescription'
]

describe('computer-use packaging entitlements', () => {
  it('declares the apple-events entitlement AppleScript needs under hardened runtime', () => {
    expect(entitlements).toContain('com.apple.security.automation.apple-events')
  })

  it.each(REQUIRED_USAGE_KEYS)('carries a non-empty %s usage string', (key) => {
    const match = builder.match(new RegExp(`${key}:\\s*(\\S.*)$`, 'm'))
    expect(match, `${key} missing from electron-builder.yml extendInfo`).not.toBeNull()
    expect(match?.[1]?.trim().length ?? 0).toBeGreaterThan(0)
  })

  it('keeps the computer-use usage strings free of em dashes (brand rule)', () => {
    for (const key of REQUIRED_USAGE_KEYS) {
      const line = builder.match(new RegExp(`${key}:.*$`, 'm'))?.[0] ?? ''
      expect(line, `${key} uses an em dash; the brand voice bans it (use " - ")`).not.toContain('—')
    }
  })
})
