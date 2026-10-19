// @vitest-environment jsdom

// Choosing an option in a settings dropdown must not move the panel it sits in. A modal select
// locked page scroll while open (overflow hidden on the document, a resized body), which reflowed
// the window under the Settings side panel and made the whole panel shift (reported 2026-10-17 on
// the Tasks tab). Real SettingsSelect and its real Base UI select; nothing faked.
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { SettingsSelect } from '../SettingsSelect'

afterEach(cleanup)

function Picker(): React.JSX.Element {
  const [value, setValue] = useState('ui-mate')
  return (
    <SettingsSelect
      id="grounding"
      label="Grounding specialist"
      value={value}
      options={[
        { value: 'ui-mate', label: 'UI-Mate-9B' },
        { value: 'ui-tars', label: 'UI-TARS-1.5-7B' }
      ]}
      onValueChange={setValue}
    />
  )
}

const pageStyle = (): string =>
  `${document.documentElement.getAttribute('style') ?? ''}|${document.body.getAttribute('style') ?? ''}`

describe('<SettingsSelect/>', () => {
  it('opens and picks an option without locking or resizing the page under it', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    const before = pageStyle()
    const trigger = screen.getByRole('combobox', { name: 'Grounding specialist' })

    await user.click(trigger)
    await screen.findByRole('option', { name: 'UI-TARS-1.5-7B' })
    expect(pageStyle()).toBe(before)

    await user.click(screen.getByRole('option', { name: 'UI-TARS-1.5-7B' }))
    await waitFor(() => expect(trigger.textContent).toContain('UI-TARS-1.5-7B'))
    expect(screen.queryByRole('option', { name: 'UI-Mate-9B' })).toBeNull()
    expect(pageStyle()).toBe(before)
  })
})
