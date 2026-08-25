// @vitest-environment jsdom
/**
 * The real shared task panel with only Electron/native feeds faked. Browser and
 * Computer Use runs become switchable, hideable tabs whose logs survive close.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatchedBrowserPane } from '../WatchedBrowserPane'
import { openTaskSidePanel } from '@renderer/lib/task-side-panel'
import { resetTaskSessionStoreForTests } from '@renderer/lib/task-session-store'

type Listener = (payload: unknown) => void

let emitTaskChange: Listener
let emitNavigation: Listener
let emitTakeover: Listener

const resolveTakeover = vi.fn(async () => true)
const browserControl = vi.fn(async () => true)
const navigate = vi.fn(async () => ({ ok: true }))
const visionControl = vi.fn(async () => true)

beforeEach(() => {
  resolveTakeover.mockClear()
  browserControl.mockClear()
  navigate.mockClear()
  visionControl.mockClear()
  resetTaskSessionStoreForTests()
  window.api = {
    tasks: {
      list: vi.fn(async () => []),
      onChanged: (cb: Listener) => {
        emitTaskChange = cb
        return () => {}
      }
    },
    browser: {
      resolveTakeover,
      control: browserControl,
      navigate,
      reopen: vi.fn(async () => true),
      setRegion: vi.fn(),
      onTaskState: () => () => {},
      onStep: () => () => {},
      onNavigationState: (cb: Listener) => {
        emitNavigation = cb
        return () => {}
      },
      onTakeover: (cb: Listener) => {
        emitTakeover = cb
        return () => {}
      }
    },
    vision: {
      control: visionControl,
      getCurrent: vi.fn(async () => null),
      onTaskState: () => () => {},
      onStep: () => () => {}
    }
  } as never
})

function task(
  taskId: string,
  kind: 'web_use' | 'computer_use',
  title: string,
  status: 'running' | 'paused' | 'done' | 'failed' | 'stopped',
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    taskId,
    kind,
    title,
    status,
    steps: [],
    startedAt: 100,
    updatedAt: 100,
    ...extra
  }
}

afterEach(cleanup)

describe('<WatchedBrowserPane/> shared task panel', () => {
  it('renders nothing until a task starts', () => {
    const { container } = render(<WatchedBrowserPane />)
    expect(container.firstChild).toBeNull()
  })

  it('shows browser chrome, navigation, and the live Web Use log', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('web-1', 'web_use', 'check in for my flight', 'running'))
    await waitFor(() => screen.getByTestId('task-side-panel'))
    expect(screen.getByTestId('task-tab-web-1').textContent).toContain('Web Use')

    emitNavigation({
      url: 'https://air.test/check-in',
      title: 'Check in',
      canGoBack: true,
      canGoForward: false,
      isLoading: false
    })
    emitTaskChange(
      task('web-1', 'web_use', 'check in for my flight', 'running', {
        steps: ['opened https://air.test/check-in'],
        updatedAt: 101
      })
    )
    await waitFor(() => expect(screen.getByText(/opened https:\/\/air.test/)).toBeTruthy())
    expect((screen.getByLabelText('Browser address') as HTMLInputElement).value).toBe(
      'https://air.test/check-in'
    )
    fireEvent.click(screen.getByLabelText('Go back'))
    expect(browserControl).toHaveBeenCalledWith('back')
  })

  it('opens a website or search from the address field', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('web-nav', 'web_use', 'research', 'running'))
    const input = await waitFor(() => screen.getByLabelText('Browser address'))
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('example.com'))
  })

  it('keeps the exact failure and prior steps visible', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('web-fail', 'web_use', 'gather proposal facts', 'failed', {
        summary: 'CDP Runtime.evaluate timed out after 15000ms',
        steps: ['opened https://example.com', 'clicked [2] About']
      })
    )
    await waitFor(() => screen.getByTestId('watched-failure'))
    expect(screen.getAllByText(/Runtime.evaluate timed out/)).toHaveLength(2)
    expect(screen.getByText('clicked [2] About')).toBeTruthy()
    expect(screen.queryByTestId('watched-web-region')).toBeNull()
  })

  it('puts Web Use and Computer Use in one switchable tab strip', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('web-2', 'web_use', 'read a website', 'done', { steps: ['done'] }))
    emitTaskChange(
      task('computer-1', 'computer_use', 'make the deck', 'running', {
        steps: ['opened Keynote'],
        updatedAt: 102
      })
    )
    await waitFor(() => screen.getByTestId('task-tab-computer-1'))
    expect(screen.getByTestId('task-tab-web-2').textContent).toContain('Web Use')
    expect(screen.getByTestId('task-tab-computer-1').textContent).toContain('Computer Use')
    expect(screen.getByText('opened Keynote')).toBeTruthy()

    fireEvent.click(screen.getByText('read a website'))
    await waitFor(() => expect(screen.getByLabelText('Browser address')).toBeTruthy())
  })

  it('closing hides a running tab without stopping it, and Chat can reopen it with its log', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('computer-2', 'computer_use', 'prepare slides', 'running', {
        steps: ['created slide 1']
      })
    )
    await waitFor(() => screen.getByText('created slide 1'))
    fireEvent.click(screen.getByLabelText('Close Computer Use tab'))
    await waitFor(() => expect(screen.queryByTestId('task-side-panel')).toBeNull())
    expect(visionControl).not.toHaveBeenCalledWith('stop')

    openTaskSidePanel({ taskId: 'computer-2', kind: 'computer_task' })
    await waitFor(() => screen.getByTestId('task-side-panel'))
    expect(screen.getByText('created slide 1')).toBeTruthy()
  })

  it('restores every hidden history tab from the permanent Tasks button', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('web-old', 'web_use', 'old web run', 'done'))
    emitTaskChange(
      task('computer-new', 'computer_use', 'new computer run', 'running', { updatedAt: 102 })
    )
    await waitFor(() => screen.getByTestId('task-tab-computer-new'))

    fireEvent.click(screen.getByLabelText('Close Computer Use tab'))
    fireEvent.click(screen.getByLabelText('Close Web Use tab'))
    await waitFor(() => expect(screen.queryByTestId('task-side-panel')).toBeNull())

    openTaskSidePanel()
    await waitFor(() => screen.getByTestId('task-side-panel'))
    expect(screen.getByTestId('task-tab-computer-new')).toBeTruthy()
    expect(screen.getByTestId('task-tab-web-old')).toBeTruthy()
  })

  it('closing the panel hides it without destroying the running task', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('web-hide', 'web_use', 'research', 'running'))
    await waitFor(() => screen.getByTestId('task-side-panel'))
    fireEvent.click(screen.getByLabelText('Close task panel'))
    await waitFor(() => expect(screen.queryByTestId('task-side-panel')).toBeNull())
    expect(visionControl).not.toHaveBeenCalledWith('stop')

    openTaskSidePanel({ taskId: 'web-hide', kind: 'web_task' })
    await waitFor(() => screen.getByTestId('task-side-panel'))
  })

  it('keeps the page visible while the user completes a takeover', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('web-login', 'web_use', 'open my account', 'running'))
    await waitFor(() => screen.getByTestId('watched-web-region'))
    emitTakeover({ taskId: 'web-login', why: 'sign in to continue' })
    await waitFor(() => screen.getByText('sign in to continue'))
    expect(screen.getByText(/does not read your password/)).toBeTruthy()
    expect(screen.getByTestId('watched-web-region')).toBeTruthy()
    fireEvent.click(screen.getByText('Resume'))
    expect(resolveTakeover).toHaveBeenCalledWith('web-login', 'resumed')
  })
})
