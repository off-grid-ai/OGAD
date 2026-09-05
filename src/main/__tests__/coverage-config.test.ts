import { describe, expect, it } from 'vitest'
import config from '../../../vitest.config'

describe('workspace coverage configuration', () => {
  it('instruments core and Pro rendered production code under the same 80 percent gate', () => {
    const coverage = config.test?.coverage
    expect(coverage?.include).toEqual([
      'src/**/*.ts',
      'src/**/*.tsx',
      'pro/**/*.ts',
      'pro/**/*.tsx'
    ])
    expect(coverage?.exclude).not.toContain('src/renderer/src/**/*.tsx')
    expect(coverage?.exclude).not.toContain('pro/renderer/**/*.tsx')
    expect(coverage?.thresholds).toMatchObject({
      statements: 80,
      branches: 80,
      functions: 80,
      lines: 80
    })
    expect(coverage?.thresholds).not.toHaveProperty('pro/**')
  })
})
