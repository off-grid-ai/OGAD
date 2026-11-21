// @vitest-environment jsdom
//
// The renderer's JSX runs through @offgrid/i18n's runtime (electron.vite.config.ts, vitest.config.ts).
// In English it changes nothing; with a catalog set, a real screen's text, labels and placeholders show in
// that language, and what a person wrote stays as written.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { setCatalog } from '@offgrid/i18n'
import { SettingsRow } from '../components/SettingsRow'

function Row({ count }: { count: number }): React.JSX.Element {
  return (
    <SettingsRow label="Theme" hint="How the app looks" controlId="theme">
      <input id="theme" placeholder="Search models" aria-label="Theme" />
      <p>{count} models</p>
      <p translate="no">Theme</p>
    </SettingsRow>
  )
}

afterEach(() => {
  cleanup()
  setCatalog('en', null)
})

describe('the i18n JSX runtime in the renderer', () => {
  it('leaves English exactly as written', () => {
    render(<Row count={3} />)
    expect(screen.getByText('How the app looks')).toBeTruthy()
    expect(screen.getByPlaceholderText('Search models')).toBeTruthy()
    expect(screen.getByText('3 models')).toBeTruthy()
  })

  it('shows a real component in German, numbers kept, and keeps translate="no" text', () => {
    setCatalog('de', {
      Theme: 'Design',
      'How the app looks': 'So sieht die App aus',
      'Search models': 'Modelle suchen',
      '{0} models': '{0} Modelle'
    })
    render(<Row count={3} />)
    expect(screen.getByText('So sieht die App aus')).toBeTruthy()
    expect(screen.getByPlaceholderText('Modelle suchen')).toBeTruthy()
    expect(screen.getByLabelText('Design', { selector: 'input' })).toBeTruthy()
    expect(screen.getByText('3 Modelle')).toBeTruthy()
    expect(screen.getAllByText('Design')).toHaveLength(1)
    expect(screen.getByText('Theme')).toBeTruthy()
  })
})
