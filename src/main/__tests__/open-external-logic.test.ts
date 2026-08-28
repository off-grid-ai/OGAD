import { describe, expect, it } from 'vitest'
import { isAllowedExternalUrl } from '../open-external-logic'

describe('isAllowedExternalUrl', () => {
  it('allows https web links', () => {
    expect(isAllowedExternalUrl('https://getoffgridai.co')).toBe(true)
  })

  it('allows mailto (the workflow-request CTA) - the regression this fixes', () => {
    expect(isAllowedExternalUrl('mailto:support@offgridmobileai.co?subject=x&body=y')).toBe(true)
    expect(isAllowedExternalUrl('MAILTO:support@offgridmobileai.co')).toBe(true)
  })

  it('refuses everything else - no file:, no raw shell targets, no http', () => {
    for (const bad of [
      'http://insecure.test',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'x-apple.systempreferences:foo',
      '/Applications/Calculator.app',
      ''
    ]) {
      expect(isAllowedExternalUrl(bad), bad).toBe(false)
    }
  })
})
