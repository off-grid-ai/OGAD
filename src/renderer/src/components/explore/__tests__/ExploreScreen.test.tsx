// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExploreScreen } from '../ExploreScreen'
import { ALL_PRESETS } from '../presetCatalog'

afterEach(() => cleanup())

describe('<ExploreScreen/>', () => {
  it('renders the full catalog as its own landing surface', () => {
    render(<ExploreScreen onRunPreset={() => {}} />)
    for (const preset of ALL_PRESETS) {
      expect(screen.getByTestId(`explore-preset-${preset.id}`)).toBeTruthy()
    }
  })

  it('hands the tapped preset back to the host to seed a chat', async () => {
    const onRunPreset = vi.fn()
    const user = userEvent.setup()
    render(<ExploreScreen onRunPreset={onRunPreset} />)

    await user.click(screen.getByTestId('explore-preset-find-flight'))

    expect(onRunPreset).toHaveBeenCalledTimes(1)
    expect(onRunPreset.mock.calls[0]?.[0]).toMatchObject({
      id: 'find-flight',
      prompt: expect.stringContaining('flight')
    })
  })
})
