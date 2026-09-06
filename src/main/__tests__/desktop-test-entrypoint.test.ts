import { describe, expect, it } from 'vitest'
import { createProductTestFiles } from './vitest-projects'

describe('Desktop product-test entry point', () => {
  it('includes Desktop Pro tests exactly once when Pro is checked out', () => {
    const files = createProductTestFiles(true)

    expect(files).toEqual([
      'integration-tests/*.test.ts',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'pro/**/*.test.ts',
      'pro/**/*.test.tsx'
    ])
    expect(new Set(files).size).toBe(files.length)
  })

  it('keeps a core-only checkout runnable without Pro', () => {
    expect(createProductTestFiles(false)).toEqual([
      'integration-tests/*.test.ts',
      'src/**/*.test.ts',
      'src/**/*.test.tsx'
    ])
  })
})
