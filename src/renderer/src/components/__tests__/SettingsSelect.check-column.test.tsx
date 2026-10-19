// @vitest-environment jsdom
// A searchable picker keeps room for the selected item's check mark, and drops that room only in a
// list that can never show one (a model slot offers only the other models).

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsSelect } from '../SettingsSelect'

afterEach(cleanup)

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' }
]
const COLLAPSED = '!grid-cols-[0px_minmax(0,1fr)]'

async function openWith(value: string): Promise<HTMLElement[]> {
  render(
    <SettingsSelect
      id="pick"
      label="Pick"
      value={value}
      searchable
      options={OPTIONS}
      onValueChange={() => {}}
    />
  )
  await userEvent.setup().click(screen.getByRole('button', { name: 'Show pick options' }))
  return screen.findAllByRole('option')
}

describe('<SettingsSelect searchable/> check column', () => {
  it('keeps the check column when the list shows a selection', async () => {
    const options = await openWith('a')
    for (const option of options) expect(option.className).not.toContain(COLLAPSED)
  })

  it('collapses it when nothing in the list can be selected, so labels sit under the input', async () => {
    const options = await openWith('')
    for (const option of options) expect(option.className).toContain(COLLAPSED)
  })
})
