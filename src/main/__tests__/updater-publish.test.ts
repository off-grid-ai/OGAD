/**
 * Regression guard for the auto-updater publish target. The repo was renamed from
 * `desktop` to `off-grid-ai-desktop` to `OGAD`. Old names use redirects, which
 * can stop working if one of those names is reused. Pin the real repo name.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const yml = readFileSync(new URL('../../../electron-builder.yml', import.meta.url), 'utf8')

describe('electron-builder publish target', () => {
  it('publishes to owner off-grid-ai', () => {
    expect(yml).toMatch(/owner:\s*off-grid-ai\b/)
  })

  it('uses the current repo name, not the redirect-only old name', () => {
    expect(yml).toMatch(/repo:\s*OGAD\b/)
    // The bare old name (`repo: desktop`) must not come back.
    expect(yml).not.toMatch(/^\s*repo:\s*desktop\s*$/m)
  })
})
