// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ExploreSection } from '../ExploreSection'
import { ALL_PRESETS, PRESET_SECTIONS } from '../presetCatalog'

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

  it('hands every clicked preset to the host so Chat can open its intake form', () => {
    const onRun = vi.fn()
    render(<ExploreSection onRun={onRun} />)

    for (const preset of ALL_PRESETS) {
      fireEvent.click(screen.getByTestId(`explore-preset-${preset.id}`))
    }

    expect(onRun.mock.calls.map(([preset]) => preset.id)).toEqual(
      ALL_PRESETS.map((preset) => preset.id)
    )
  })

  it('annotates a gated preset so it never dead-ends silently', () => {
    render(<ExploreSection onRun={() => {}} />)
    const gated = screen.getByTestId('explore-preset-phone-summarize')
    expect(gated.textContent).toMatch(/paired phone/i)
  })

  it('renders each card with its own icon plus the run arrow', () => {
    render(<ExploreSection onRun={() => {}} />)
    for (const preset of ALL_PRESETS) {
      const card = screen.getByTestId(`explore-preset-${preset.id}`)
      // The preset icon and the hover arrow - a card without both lost its visual lead.
      expect(card.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
    }
  })

  it('shows a runs count on every capability panel', () => {
    render(<ExploreSection onRun={() => {}} />)
    expect(screen.getAllByText(/^\d+ runs?$/)).toHaveLength(PRESET_SECTIONS.length)
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
