import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import config, { WORKSPACE_COVERAGE_GATE, resolveCoverageThresholds } from '../../../vitest.config'

const repoRoot = resolve(__dirname, '../../..')

describe('workspace coverage configuration', () => {
  it('instruments core and Pro rendered production code in one report', () => {
    const coverage = config.test?.coverage
    expect(coverage?.include).toEqual([
      'src/**/*.ts',
      'src/**/*.tsx',
      'pro/**/*.ts',
      'pro/**/*.tsx'
    ])
    expect(coverage?.exclude).not.toContain('src/renderer/src/**/*.tsx')
    expect(coverage?.exclude).not.toContain('pro/renderer/**/*.tsx')
  })

  it('runs product and database journeys through one Desktop coverage invocation', () => {
    const projects = (config.test?.projects ?? []) as Array<{
      test?: { name?: string; fileParallelism?: boolean; maxWorkers?: number }
    }>
    const product = projects.find((project) => project.test?.name === 'product-integration')
    const database = projects.find((project) => project.test?.name === 'database-integration')
    const exclusive = projects.find(
      (project) => project.test?.name === 'database-exclusive-integration'
    )

    expect(product).toBeDefined()
    expect(database?.test?.fileParallelism).toBe(true)
    expect(database?.test?.maxWorkers).toBeGreaterThanOrEqual(1)
    expect(database?.test?.maxWorkers).toBeLessThanOrEqual(4)
    expect(exclusive?.test).toMatchObject({ fileParallelism: false, maxWorkers: 1 })
  })

  it('holds core and Pro to a single 65 percent gate', () => {
    expect(WORKSPACE_COVERAGE_GATE).toEqual({
      statements: 65,
      branches: 65,
      functions: 65,
      lines: 65
    })
    // One gate for the workspace: no softer per-package group can be smuggled in beside it.
    expect(WORKSPACE_COVERAGE_GATE).not.toHaveProperty('pro/**')
  })

  it('enforces that gate on a single-suite run and defers it to the merged report', () => {
    // A run that measures the whole tree by itself is gated by vitest, right here.
    expect(resolveCoverageThresholds(false)).toEqual(WORKSPACE_COVERAGE_GATE)
    // Under the aggregate run this suite is one input of several, so the identical gate is
    // applied downstream to the merged new-code report instead of to this partial one.
    expect(resolveCoverageThresholds(true)).toBeUndefined()
  })

  it('is the same floor vitest and the aggregate new-code run read', () => {
    // One machine-readable owner: vitest.config.ts parses this file for `thresholds`, and
    // scripts/coverage-all.sh derives its `--min-*` flags from it. Neither holds a copy, so a
    // change to the floor cannot land in one runner and miss the other.
    const declaredGate = JSON.parse(
      readFileSync(resolve(repoRoot, 'coverage-gate.json'), 'utf-8')
    ) as Record<string, number>
    expect(WORKSPACE_COVERAGE_GATE).toEqual(declaredGate)

    // The aggregate script's OWN derivation, run for real - not a re-implementation of it here.
    const aggregateFlags = execFileSync('bash', ['scripts/coverage-all.sh', '--print-gate'], {
      cwd: repoRoot,
      encoding: 'utf-8'
    }).trim()
    expect(aggregateFlags).toBe(
      Object.entries(WORKSPACE_COVERAGE_GATE)
        .map(([metric, min]) => `--min-${metric}=${min}`)
        .join(' ')
    )
  })
})
