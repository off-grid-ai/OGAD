import { describe, expect, it } from 'vitest'
import type { Outcome } from '@offgrid/application'
import { requireApplicationOutcome } from '../application-outcome'

describe('Desktop application outcome boundary', () => {
  it('returns the value from a successful Shared application outcome', () => {
    const outcome: Outcome<{ readonly documentId: number }, { readonly message: string }> = {
      ok: true,
      value: { documentId: 42 }
    }

    expect(requireApplicationOutcome(outcome)).toEqual({ documentId: 42 })
  })

  it('reports the Shared failure message at the legacy host boundary', () => {
    const outcome: Outcome<never, { readonly message: string }> = {
      ok: false,
      failure: { message: 'The document index is unavailable.' }
    }

    expect(() => requireApplicationOutcome(outcome)).toThrow('The document index is unavailable.')
  })
})
