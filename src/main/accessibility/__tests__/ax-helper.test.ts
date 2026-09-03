import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const roots = vi.hoisted(() => ({ list: [] as string[] }))
vi.mock('../../runtime-env', () => ({
  binRoots: () => roots.list,
  exe: (name: string) => (process.platform === 'win32' ? `${name}.exe` : name)
}))

import { accessibilityHelperPath } from '../ax-helper'

describe('accessibility helper path', () => {
  it('returns the first runtime root that ships the helper, or null when none does', () => {
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-none-'))
    const present = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-here-'))
    const helper = path.join(present, process.platform === 'win32' ? 'text-extractor.exe' : 'text-extractor')
    fs.writeFileSync(helper, '')
    roots.list = [missing, present]
    expect(accessibilityHelperPath()).toBe(helper)
    roots.list = [missing, '/definitely/not/a/dir\0bad']
    expect(accessibilityHelperPath()).toBeNull()
  })
})
