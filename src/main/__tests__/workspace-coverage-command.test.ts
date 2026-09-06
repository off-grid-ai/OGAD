import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('Desktop workspace coverage command', () => {
  it('measures Desktop, Desktop Pro, and only their Shared dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }
    const command = manifest.scripts['test:coverage:workspace']

    expect(command).toContain('npm run test:coverage')
    expect(command).toContain('--consumers=desktop,desktop-pro')
    expect(command).not.toContain('--forceExit')
  })
})
