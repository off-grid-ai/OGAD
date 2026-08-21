// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExploreSection } from '../ExploreSection'
import { ALL_PRESETS } from '../presetCatalog'

afterEach(() => cleanup())

describe('<ExploreSection/>', () => {
  it('renders a card for every preset in the catalog', () => {
    render(<ExploreSection onRun={() => {}} />)
    for (const preset of ALL_PRESETS) {
      expect(screen.getByTestId(`explore-preset-${preset.id}`)).toBeTruthy()
    }
  })

  it('runs the preset that was clicked, with the full preset', async () => {
    const onRun = vi.fn()
    const user = userEvent.setup()
    render(<ExploreSection onRun={onRun} />)

    await user.click(screen.getByTestId('explore-preset-find-flight'))

    expect(onRun).toHaveBeenCalledTimes(1)
    expect(onRun.mock.calls[0]?.[0]).toMatchObject({ id: 'find-flight' })
  })

  it('annotates a gated preset so it never dead-ends silently', () => {
    render(<ExploreSection onRun={() => {}} />)
    const gated = screen.getByTestId('explore-preset-phone-summarize')
    expect(gated.textContent).toMatch(/paired phone/i)
  })

  it('shows the request link only when a url is given, pointing where told', () => {
    const { rerender } = render(<ExploreSection onRun={() => {}} />)
    expect(screen.queryByText(/request a capability/i)).toBeNull()

    rerender(<ExploreSection onRun={() => {}} requestUrl="https://forms.example/demo" />)
    const link = screen.getByText(/request a capability/i).closest('a')
    expect(link?.getAttribute('href')).toBe('https://forms.example/demo')
  })
})
