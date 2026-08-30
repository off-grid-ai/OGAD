// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { SidebarNavigationMenu } from '../SidebarNavigationMenu'

const groups = [
  {
    label: 'Discover',
    icon: <span data-testid="discover-icon" />,
    items: [
      { label: 'Explore', view: 'explore' },
      { label: 'Search', view: 'search' }
    ]
  },
  {
    label: 'Work',
    icon: <span data-testid="work-icon" />,
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
  // Every section starts open so both widths expose the same destinations before the user changes
  // a section. Compact section headers keep that same state available without visible labels.
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

  it('keeps one section-open state when the sidebar width changes', async () => {
    const user = userEvent.setup()
    const view = render(
      <SidebarNavigationMenu activeView="chat" expanded groups={groups} renderItem={renderItem} />
    )

    // Starts open now, so the first click CLOSES it - and must not disturb its neighbour.
    await user.click(screen.getByRole('button', { name: 'Discover' }))
    expect(screen.getByRole('button', { name: 'Discover' }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Explore' })).toBeNull()
    const expandedMenu = screen.getByLabelText('Menu sections')
    const expandedWorkGroup = screen.getByRole('group', { name: 'Work' })
    const menuSpacingClass = expandedMenu.className
    const groupSpacingClass = expandedWorkGroup.className

    view.rerender(
      <SidebarNavigationMenu
        activeView="chat"
        expanded={false}
        groups={groups}
        renderItem={renderItem}
      />
    )
    expect(screen.getByRole('button', { name: 'Discover' }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(screen.queryByRole('button', { name: 'Explore' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Chat' })).toBeTruthy()
    expect(screen.getByLabelText('Menu sections').className).toBe(menuSpacingClass)
    expect(screen.getByRole('group', { name: 'Work' }).className).toBe(groupSpacingClass)

    view.rerender(
      <SidebarNavigationMenu activeView="chat" expanded groups={groups} renderItem={renderItem} />
    )
    expect(screen.getByRole('button', { name: 'Discover' }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(screen.queryByRole('button', { name: 'Explore' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Discover' }))
    expect(screen.getByRole('button', { name: 'Discover' }).getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps a user-closed section closed when its route becomes active at both widths', async () => {
    const user = userEvent.setup()
    const view = render(
      <SidebarNavigationMenu activeView="chat" expanded groups={groups} renderItem={renderItem} />
    )

    await user.click(screen.getByRole('button', { name: 'Discover' }))
    expect(screen.queryByRole('button', { name: 'Explore' })).toBeNull()

    view.rerender(
      <SidebarNavigationMenu
        activeView="explore"
        expanded
        groups={groups}
        renderItem={renderItem}
      />
    )

    const expandedHeader = screen.getByRole('button', { name: 'Discover, current: Explore' })
    expect(expandedHeader.getAttribute('aria-expanded')).toBe('false')
    expect(expandedHeader.textContent).toContain('Explore')
    expect(screen.queryByRole('button', { name: 'Explore' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-expanded')).toBe('true')

    view.rerender(
      <SidebarNavigationMenu
        activeView="explore"
        expanded={false}
        groups={groups}
        renderItem={renderItem}
      />
    )
    const collapsedHeader = screen.getByRole('button', { name: 'Discover, current: Explore' })
    expect(collapsedHeader.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Explore' })).toBeNull()
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

  it('renders labelled icon buttons for every section in the compact rail', () => {
    render(
      <SidebarNavigationMenu
        activeView="chat"
        expanded={false}
        groups={groups}
        renderItem={renderItem}
      />
    )

    const discover = screen.getByRole('button', { name: 'Discover' })
    const work = screen.getByRole('button', { name: 'Work' })
    expect(discover.title).toBe('Discover')
    expect(work.title).toBe('Work')
    expect(screen.getByTestId('discover-icon')).toBeTruthy()
    expect(screen.getByTestId('work-icon')).toBeTruthy()
    expect(
      within(screen.getByRole('group', { name: 'Discover' })).getAllByRole('button')
    ).toHaveLength(3)
    expect(within(screen.getByRole('group', { name: 'Work' })).getAllByRole('button')).toHaveLength(
      3
    )
  })

  it('toggles a compact section by keyboard and keeps focus on its header', async () => {
    const user = userEvent.setup()
    render(
      <SidebarNavigationMenu
        activeView="chat"
        expanded={false}
        groups={groups}
        renderItem={renderItem}
      />
    )

    const discover = screen.getByRole('button', { name: 'Discover' })
    discover.focus()
    await user.keyboard('{Enter}')
    expect(discover.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(discover)
    expect(screen.queryByRole('button', { name: 'Explore' })).toBeNull()
  })
})
