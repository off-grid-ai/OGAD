// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { SidebarNavigationMenu } from '../SidebarNavigationMenu'

const groups = [
  {
    label: 'Discover',
    items: [
      { label: 'Explore', view: 'explore' },
      { label: 'Search', view: 'search' }
    ]
  },
  {
    label: 'Work',
    items: [
      { label: 'Chat', view: 'chat' },
      { label: 'Tasks', view: 'tasks' }
    ]
  }
] as const

const renderItem = (item: { label: string; view: string }): React.ReactElement => (
  <button key={item.view}>{item.label}</button>
)

afterEach(cleanup)

describe('SidebarNavigationMenu', () => {
  // Every section starts open so the expanded sidebar shows exactly what the collapsed rail shows.
  // The rail has no section headers and therefore always renders every item, so seeding only the
  // active section made an icon you could hover in the rail vanish when the sidebar expanded.
  it('opens every section by default so the rail and the expanded sidebar agree', () => {
    render(
      <SidebarNavigationMenu activeView="chat" expanded groups={groups} renderItem={renderItem} />
    )

    expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Discover' }).getAttribute('aria-expanded')).toBe(
      'true'
    )
    // An item from EACH section is reachable, which is the property that was broken.
    expect(screen.getByRole('button', { name: 'Chat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Explore' })).toBeTruthy()
  })

  it('keeps other sections open and lets each section close independently', async () => {
    const user = userEvent.setup()
    render(
      <SidebarNavigationMenu activeView="chat" expanded groups={groups} renderItem={renderItem} />
    )

    // Starts open now, so the first click CLOSES it - and must not disturb its neighbour.
    await user.click(screen.getByRole('button', { name: 'Discover' }))
    expect(screen.getByRole('button', { name: 'Discover' }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-expanded')).toBe('true')

    await user.click(screen.getByRole('button', { name: 'Discover' }))
    expect(screen.getByRole('button', { name: 'Discover' }).getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('opens the new section when navigation changes', () => {
    const view = render(
      <SidebarNavigationMenu activeView="chat" expanded groups={groups} renderItem={renderItem} />
    )

    view.rerender(
      <SidebarNavigationMenu
        activeView="explore"
        expanded
        groups={groups}
        renderItem={renderItem}
      />
    )

    expect(screen.getByRole('button', { name: 'Discover' }).getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('shows the current screen in a closed section header', async () => {
    const user = userEvent.setup()
    render(
      <SidebarNavigationMenu activeView="chat" expanded groups={groups} renderItem={renderItem} />
    )

    await user.click(screen.getByRole('button', { name: 'Work' }))

    const closedWork = screen.getByRole('button', { name: 'Work, current: Chat' })
    expect(closedWork.getAttribute('aria-expanded')).toBe('false')
    expect(closedWork.textContent).toContain('Chat')
  })

  it('preserves the named groups in the compact icon rail', () => {
    render(
      <SidebarNavigationMenu
        activeView="chat"
        expanded={false}
        groups={groups}
        renderItem={renderItem}
      />
    )

    expect(
      within(screen.getByRole('group', { name: 'Discover' })).getAllByRole('button')
    ).toHaveLength(2)
    expect(within(screen.getByRole('group', { name: 'Work' })).getAllByRole('button')).toHaveLength(
      2
    )
  })
})
