// The core guard: see mock-guard.ts for the rule. After fixing a file, refresh the baseline:
// UPDATE_MOCK_BASELINE=1 npx vitest run --project product-integration src/main/__tests__/no-mocks-of-our-code.test.ts
import path from 'node:path'
import { expect, it } from 'vitest'
import { checkMockBaseline, isOurs, mocksOfOurs, scanMocks } from './mock-guard'

const ROOT = path.join(__dirname, '../../..')
const BASELINE = path.join(__dirname, 'mock-baseline.json')

it('names our code and leaves the device boundary alone', () => {
  for (const ours of [
    '../llm',
    '../../backend-preferences',
    '@offgrid/core/main/database',
    '@offgrid/pro',
    '@renderer/lib/api'
  ])
    expect(isOurs(ours)).toBe(true)
  for (const boundary of [
    'electron',
    'node:fs',
    'child_process',
    '@huggingface/transformers',
    'kokoro-js'
  ])
    expect(isOurs(boundary)).toBe(false)
  const sample = [
    "import { LLMService, llm } from '../llm'",
    "import os from 'node:os'",
    "vi.mock('../backend-preferences', () => ({}))",
    "vi.mock(import('../runtime-env'), async () => ({}))",
    "vi.mock('electron', () => ({}))",
    "vi.spyOn(llm, 'unload')",
    "vi.spyOn(os, 'totalmem')",
    "vi.spyOn(console, 'warn')",
    "const store = await import('../store')",
    "vi.spyOn(store, 'save')"
  ].join('\n')
  expect(mocksOfOurs(sample)).toEqual([
    'mock ../backend-preferences',
    'mock ../runtime-env',
    'spyOn llm',
    'spyOn store'
  ])
})

it('no core test mocks our code beyond the baseline, and the baseline only shrinks', () => {
  const now = scanMocks(
    ROOT,
    ['src', 'integration-tests'],
    [path.relative(ROOT, __filename), path.relative(ROOT, path.join(__dirname, 'mock-guard.ts'))]
  )
  expect(checkMockBaseline(BASELINE, now)).toEqual([])
})
