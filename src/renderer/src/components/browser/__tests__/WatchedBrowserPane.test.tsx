// @vitest-environment jsdom
/**
 * The real shared task panel with only Electron/native feeds faked. Browser and
 * Computer Use runs become switchable, hideable tabs whose logs survive close.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatchedBrowserPane } from '../WatchedBrowserPane'
import { openTaskSidePanel } from '@renderer/lib/task-side-panel'
import { resetTaskSessionStoreForTests } from '@renderer/lib/task-session-store'

type Listener = (payload: unknown) => void

let emitTaskChange: Listener
let emitNavigation: Listener
let emitTakeover: Listener
let emitSessions: Listener
let emitPointer: Listener

const resolveTakeover = vi.fn(async () => true)
const browserControl = vi.fn(async () => true)
const navigate = vi.fn(async () => ({ ok: true }))
const newTab = vi.fn(async () => ({ sessionId: 'manual-1' }))
const activateSession = vi.fn(async () => true)
const closeSession = vi.fn(async () => true)
const listManualHistory = vi.fn(async () => [] as Record<string, unknown>[])
const reopenManual = vi.fn(async () => null as { sessionId: string } | null)
const visionControl = vi.fn(async () => true)

beforeEach(() => {
  resolveTakeover.mockClear()
  browserControl.mockClear()
  navigate.mockClear()
  newTab.mockClear()
  activateSession.mockClear()
  closeSession.mockClear()
  listManualHistory.mockReset()
  listManualHistory.mockResolvedValue([])
  reopenManual.mockReset()
  reopenManual.mockResolvedValue(null)
  visionControl.mockClear()
  resetTaskSessionStoreForTests()
  window.api = {
    getSettings: vi.fn(async () => ({})),
    saveSetting: vi.fn(async () => true),
    tasks: {
      list: vi.fn(async () => []),
      onChanged: (cb: Listener) => {
        emitTaskChange = cb
        return () => {}
      }
    },
    browser: {
      resolveTakeover,
      newTab,
      getSessions: vi.fn(async () => ({ activeSessionId: null, sessions: [] })),
      activateSession,
      closeSession,
      control: browserControl,
      navigate,
      reopen: vi.fn(async () => true),
      listManualHistory,
      reopenManual,
      setRegion: vi.fn(),
      onSessionsState: (cb: Listener) => {
        emitSessions = cb
        return () => {}
      },
      onTaskState: () => () => {},
      onStep: () => () => {},
      onNavigationState: (cb: Listener) => {
        emitNavigation = cb
        return () => {}
      },
      onPointer: (cb: Listener) => {
        emitPointer = cb
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

function taskSession(taskId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: `session:${taskId}`,
    kind: 'task',
    taskId,
    status: 'running',
    url: '',
    title: 'New tab',
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
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
    emitSessions({ activeSessionId: 'session:web-1', sessions: [taskSession('web-1')] })
    await waitFor(() => screen.getByTestId('task-side-panel'))
    expect(screen.getByTestId('task-tab-web-1').textContent).toContain('Web Use')

    emitNavigation({
      sessionId: 'session:web-1',
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
    expect(browserControl).toHaveBeenCalledWith('back', 'session:web-1')
  })

  it('opens a website or search from the address field', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('web-nav', 'web_use', 'research', 'running'))
    emitSessions({ activeSessionId: 'session:web-nav', sessions: [taskSession('web-nav')] })
    const input = await waitFor(() => screen.getByLabelText('Browser address'))
    fireEvent.change(input, { target: { value: 'example.com' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('example.com', 'session:web-nav'))
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

  it('opens an empty task history instead of ignoring the Tasks button', async () => {
    render(<WatchedBrowserPane />)
    openTaskSidePanel()
    await waitFor(() => screen.getByTestId('task-side-panel'))
    expect(screen.getByText('No task history yet')).toBeTruthy()
  })

  it('opens Computer Use settings inside the same task side panel', async () => {
    render(<WatchedBrowserPane />)
    openTaskSidePanel()
    await waitFor(() => screen.getByTestId('task-side-panel'))
    fireEvent.click(screen.getByLabelText('Computer Use settings'))
    expect(await screen.findByLabelText('Computer Use task context')).toBeTruthy()
    expect(screen.getByTestId('task-side-panel')).toBeTruthy()
  })

  it('creates a real manual browser tab from the empty state', async () => {
    render(<WatchedBrowserPane />)
    openTaskSidePanel()
    await waitFor(() => screen.getByRole('button', { name: 'New browser tab' }))
    fireEvent.click(screen.getByRole('button', { name: 'New browser tab' }))
    await waitFor(() => expect(newTab).toHaveBeenCalledTimes(1))
    emitSessions({
      activeSessionId: 'manual-1',
      sessions: [
        {
          sessionId: 'manual-1',
          historyId: 'history-1',
          kind: 'manual',
          status: 'open',
          url: 'https://example.com',
          title: 'Example',
          canGoBack: false,
          canGoForward: false,
          isLoading: false
        }
      ]
    })
    await waitFor(() => expect(screen.getByText('Browser')).toBeTruthy())
    expect(screen.queryByText('Web Use')).toBeNull()
    expect(screen.getByTestId('watched-web-region')).toBeTruthy()
  })

  it('switches, closes, and reopens manual browser tabs by durable history identity', async () => {
    listManualHistory.mockResolvedValue([
      {
        historyId: 'history-1',
        kind: 'manual',
        status: 'closed',
        title: 'First page',
        url: 'https://first.test',
        updatedAt: 100
      },
      {
        historyId: 'history-2',
        kind: 'manual',
        status: 'closed',
        title: 'Second page',
        url: 'https://second.test',
        updatedAt: 200
      }
    ])
    render(<WatchedBrowserPane />)
    openTaskSidePanel()
    await waitFor(() => screen.getByText('First page'))

    fireEvent.click(screen.getByText('First page'))
    await waitFor(() => expect(reopenManual).toHaveBeenCalledWith('history-1'))

    emitSessions({
      activeSessionId: 'session-2',
      sessions: [
        {
          sessionId: 'session-1',
          historyId: 'history-1',
          kind: 'manual',
          status: 'open',
          url: 'https://first.test',
          title: 'First page',
          canGoBack: false,
          canGoForward: false,
          isLoading: false
        },
        {
          sessionId: 'session-2',
          historyId: 'history-2',
          kind: 'manual',
          status: 'open',
          url: 'https://second.test',
          title: 'Second page',
          canGoBack: false,
          canGoForward: false,
          isLoading: false
        }
      ]
    })
    await waitFor(() => screen.getByTestId('watched-web-region'))
    fireEvent.click(screen.getByText('First page'))
    await waitFor(() => expect(activateSession).toHaveBeenCalledWith('session-1'))
    fireEvent.click(
      within(screen.getByTestId('task-tab-manual:history-1')).getByLabelText('Close Browser tab')
    )
    expect(closeSession).toHaveBeenCalledWith('session-1')
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
    emitSessions({ activeSessionId: 'session:web-login', sessions: [taskSession('web-login')] })
    await waitFor(() => screen.getByTestId('watched-web-region'))
    emitTakeover({ taskId: 'web-login', why: 'sign in to continue' })
    await waitFor(() => screen.getByText('sign in to continue'))
    expect(screen.getByText(/does not read your password/)).toBeTruthy()
    expect(screen.getByTestId('watched-web-region')).toBeTruthy()
    fireEvent.click(screen.getByText('Resume'))
    expect(resolveTakeover).toHaveBeenCalledWith('web-login', 'resumed')
  })

  it('shows the real agent pointer coordinates and click phase for the active tab', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('web-pointer', 'web_use', 'click continue', 'running'))
    emitSessions({
      activeSessionId: 'session:web-pointer',
      sessions: [taskSession('web-pointer')]
    })
    await waitFor(() => screen.getByTestId('watched-web-region'))
    emitPointer({
      sessionId: 'session:web-pointer',
      phase: 'pressed',
      x: 240,
      y: 180
    })
    const pointer = await waitFor(() => screen.getByTestId('browser-agent-pointer'))
    expect(pointer.getAttribute('style')).toContain('left: 240px')
    expect(pointer.getAttribute('style')).toContain('top: 180px')
    expect(pointer.querySelector('.animate-ping')).toBeTruthy()
  })
})
