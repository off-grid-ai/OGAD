import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('database integration runner', () => {
  it("runs native database journeys serially under Electron's Node ABI", () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'scripts/test-db.sh'), 'utf8')

    expect(script).toContain('--no-file-parallelism')
    expect(script).toMatch(/--maxWorkers=1/)
    expect(script).toContain('scripts/vitest-electron-node.mjs')
    expect(script).not.toMatch(/npm (?:rebuild|explore)/)
    expect(script).not.toMatch(/electron-rebuild/)
  })
})
