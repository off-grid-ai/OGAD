/**
 * Unit tests for the prompt template engine + registry contract.
 *
 * fillTemplate does {{VAR}} substitution and — per its implementation — LEAVES an
 * unknown/absent placeholder untouched (returns the literal match). Default resolution
 * throws on an unknown key. The CONTRACT GUARD (mirrors extract-prompt.test.ts) asserts
 * every variable a PromptDef declares actually appears as {{NAME}} in its template, so a
 * declared var can never silently go unused — the registry is the single source of truth.
 *
 * The template engine and registry are exercised without replacing any Off Grid AI module.
 * Persistence behavior runs against real SQLite in settings-consumers.dbtest.ts.
 */
import { describe, it, expect } from 'vitest'

import {
  fillTemplate,
  getDefaultPromptTemplate,
  PROMPT_REGISTRY,
  getAllPromptDefs
} from '../prompts'

describe('fillTemplate', () => {
  it('substitutes a single variable', () => {
    expect(fillTemplate('Hello {{NAME}}', { NAME: 'World' })).toBe('Hello World')
  })

  it('substitutes multiple distinct variables', () => {
    expect(fillTemplate('{{A}}-{{B}}', { A: 'x', B: 'y' })).toBe('x-y')
  })

  it('replaces EVERY occurrence of a repeated variable (global regex)', () => {
    expect(fillTemplate('{{X}} and {{X}} again', { X: 'q' })).toBe('q and q again')
  })

  it('leaves an unknown/absent placeholder untouched (returns the literal match)', () => {
    expect(fillTemplate('keep {{MISSING}} here', {})).toBe('keep {{MISSING}} here')
  })

  it('substitutes empty string when the value is an empty string (not undefined)', () => {
    // '' is defined, so it is substituted; only `undefined` falls back to the match.
    expect(fillTemplate('[{{V}}]', { V: '' })).toBe('[]')
  })

  it('returns a no-variable template unchanged', () => {
    expect(fillTemplate('no placeholders at all', { UNUSED: 'z' })).toBe('no placeholders at all')
  })

  it('ignores malformed single-brace tokens', () => {
    expect(fillTemplate('{NAME} stays', { NAME: 'x' })).toBe('{NAME} stays')
  })
})

describe('getDefaultPromptTemplate', () => {
  it('throws on an unknown key', () => {
    expect(() => getDefaultPromptTemplate('nope.not-a-key')).toThrow(/Unknown prompt key/)
  })

  it.each(PROMPT_REGISTRY.map((prompt) => prompt.key))(
    'resolves the registered default for "%s"',
    (key) => {
      expect(getDefaultPromptTemplate(key)).toBe(
        PROMPT_REGISTRY.find((prompt) => prompt.key === key)?.defaultTemplate
      )
    }
  )
})

describe('PROMPT_REGISTRY contract', () => {
  it('has unique keys', () => {
    const keys = PROMPT_REGISTRY.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('getAllPromptDefs returns the registry', () => {
    expect(getAllPromptDefs()).toBe(PROMPT_REGISTRY)
  })

  // CONTRACT GUARD: every declared variable must appear as {{NAME}} in the template,
  // so registry metadata and the templates consumed by production cannot drift.
  it.each(PROMPT_REGISTRY.map((d) => [d.key, d] as const))(
    'every declared variable of "%s" appears as {{NAME}} in its template',
    (_key, def) => {
      for (const v of def.variables) {
        expect(def.defaultTemplate).toContain(`{{${v.name}}}`)
      }
    }
  )
})
