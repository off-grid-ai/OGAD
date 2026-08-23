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

  it('never renders the raw prompt on a card - the prompt stays behind the tap', () => {
    render(<ExploreSection onRun={() => {}} />)
    for (const preset of ALL_PRESETS) {
      const card = screen.getByTestId(`explore-preset-${preset.id}`)
      expect(card.textContent).not.toContain(preset.prompt)
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

  it('marks robust ungated presets as ready, and only those', () => {
    render(<ExploreSection onRun={() => {}} />)
    // Robust + ungated -> the ready marker.
    expect(screen.getByTestId('explore-preset-best-nearby').textContent).toMatch(/ready to run/i)
    // Gated -> the requirement, never a ready claim.
    expect(screen.getByTestId('explore-preset-work-today').textContent).not.toMatch(/ready to run/i)
    // Needs-setup without a gate -> no marker either way.
    expect(screen.getByTestId('explore-preset-find-flight').textContent).not.toMatch(
      /ready to run/i
    )
  })

  it('shows its compact intro by default and hides it for hosts with their own header', () => {
    const { rerender } = render(<ExploreSection onRun={() => {}} />)
    expect(screen.getByText(/explore what off grid ai can do/i)).toBeTruthy()

    rerender(<ExploreSection onRun={() => {}} showIntro={false} />)
    expect(screen.queryByText(/explore what off grid ai can do/i)).toBeNull()
  })

  it('shows the request link only when a url is given, pointing where told', () => {
    const { rerender } = render(<ExploreSection onRun={() => {}} />)
    expect(screen.queryByText(/request a capability/i)).toBeNull()

    rerender(<ExploreSection onRun={() => {}} requestUrl="https://forms.example/demo" />)
    const link = screen.getByText(/request a capability/i).closest('a')
    expect(link?.getAttribute('href')).toBe('https://forms.example/demo')
  })
})
