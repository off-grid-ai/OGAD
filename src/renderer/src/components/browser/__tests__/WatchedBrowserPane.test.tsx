// @vitest-environment jsdom
/**
 * The real shared task panel with only Electron/native feeds faked. Browser and
 * Computer Use runs become switchable, hideable tabs whose logs survive close.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatchedBrowserPane } from '../WatchedBrowserPane'
import { closeTaskWorkspace, openTaskSidePanel } from '@renderer/lib/task-side-panel'
import { resetTaskSessionStoreForTests } from '@renderer/lib/task-session-store'
import type { TaskGuideInput } from '../../../../../shared/task-guidance'

type Listener = (payload: unknown) => void

let emitTaskChange: Listener
let emitNavigation: Listener
let emitTakeover: Listener
let emitSessions: Listener
let emitPointer: Listener
let emitVisionState: Listener

const resolveTakeover = vi.fn(async () => true)
const browserControl = vi.fn(async () => true)
const navigate = vi.fn(async () => ({ ok: true }))
const newTab = vi.fn(async () => ({ sessionId: 'manual-1' }))
const activateSession = vi.fn(async () => true)
const closeSession = vi.fn(async () => true)
const stopBrowserTask = vi.fn(async () => true)
const listManualHistory = vi.fn(async () => [] as Record<string, unknown>[])
const reopenManual = vi.fn(async () => null as { sessionId: string } | null)
const visionControl = vi.fn(async () => true)
const setBrowserRegion = vi.fn()
const retryAvailability = vi.fn(async () => ({ available: true }))
const retryTask = vi.fn(async (taskId: string) => ({ available: true, taskId }))
const guideAvailability = vi.fn(
  async (): Promise<{ available: boolean; reason?: string }> => ({ available: false })
)
const guideTask = vi.fn(async (_taskId: string, _input: TaskGuideInput) => ({
  available: true,
  accepted: true
}))
const addRagMessage = vi.fn(async () => ({ id: 1, uuid: 'guidance-message-1' }))

beforeEach(() => {
  resolveTakeover.mockClear()
  browserControl.mockClear()
  navigate.mockClear()
  newTab.mockClear()
  activateSession.mockClear()
  closeSession.mockClear()
  stopBrowserTask.mockClear()
  listManualHistory.mockReset()
  listManualHistory.mockResolvedValue([])
  reopenManual.mockReset()
  reopenManual.mockResolvedValue(null)
  visionControl.mockClear()
  setBrowserRegion.mockClear()
  retryAvailability.mockClear()
  retryTask.mockClear()
  guideAvailability.mockReset()
  guideAvailability.mockResolvedValue({ available: false })
  guideTask.mockReset()
  guideTask.mockResolvedValue({ available: true, accepted: true })
  addRagMessage.mockClear()
  resetTaskSessionStoreForTests()
  closeTaskWorkspace()
  window.api = {
    getSettings: vi.fn(async () => ({})),
    saveSetting: vi.fn(async () => true),
    getModelCatalog: vi.fn(async () => ({ models: [] })),
    getInstalledModels: vi.fn(async () => []),
    getActiveModalities: vi.fn(async () => ({})),
    addRagMessage,
    tasks: {
      list: vi.fn(async () => []),
      retryAvailability,
      retry: retryTask,
      guideAvailability,
      guideTask,
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
      stopTask: stopBrowserTask,
      control: browserControl,
      navigate,
      reopen: vi.fn(async () => true),
      listManualHistory,
      reopenManual,
      setRegion: setBrowserRegion,
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
      onTaskState: (cb: Listener) => {
        emitVisionState = cb
        return () => {}
      },
      onStep: () => () => {}
    }
  } as never
})

function task(
  taskId: string,
  kind: 'web_use' | 'computer_use',
  title: string,
  status: 'running' | 'paused' | 'waiting' | 'reconnecting' | 'done' | 'failed' | 'stopped',
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

  it('shows browser chrome, navigation, and pinned live controls', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('web-1', 'web_use', 'check in for my flight', 'running'))
    emitSessions({ activeSessionId: 'session:web-1', sessions: [taskSession('web-1')] })
    await waitFor(() => screen.getByTestId('task-side-panel'))
    expect(await screen.findByTestId('task-details-web-1')).toBeTruthy()

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
    await waitFor(() => expect(screen.getByTestId('task-live-controls')).toBeTruthy())
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

  it('keeps the exact failure visible without a duplicate trace column', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('web-fail', 'web_use', 'gather proposal facts', 'failed', {
        summary: 'CDP Runtime.evaluate timed out after 15000ms',
        steps: ['opened https://example.com', 'clicked [2] About']
      })
    )
    await waitFor(() => screen.getByTestId('watched-failure'))
    expect(screen.getByText(/Runtime.evaluate timed out/)).toBeTruthy()
    expect(screen.queryByTestId('task-trace-pane')).toBeNull()
    expect(screen.queryByTestId('watched-web-region')).toBeNull()
    fireEvent.click(screen.getByTestId('task-tab-web-fail'))
    const retry = await screen.findByRole('button', { name: 'Retry failed step' })
    fireEvent.click(retry)
    await waitFor(() => expect(retryTask).toHaveBeenCalledWith('web-fail'))
  })

  it('selects one task record and its matching task surface together', async () => {
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
    expect(screen.getByTestId('task-live-controls').textContent).toContain('make the deck')

    fireEvent.click(screen.getByText('read a website'))
    expect(screen.getByTestId('task-details-web-2')).toBeTruthy()
    expect(screen.getByTestId('task-live-controls').textContent).toContain('read a website')
    expect(window.api.browser?.reopen).toHaveBeenCalledWith('web-2')
    expect(screen.getByLabelText('Browser address')).toBeTruthy()
  })

  it('shows the selected task saved frame instead of another browser session', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('older-task', 'web_use', 'older task', 'failed', {
        screenshotPath: '/tmp/older-task-final.png',
        lastUrl: 'https://older.example/final',
        updatedAt: 101
      })
    )
    emitTaskChange(task('newer-task', 'web_use', 'newer task', 'running', { updatedAt: 102 }))
    emitSessions({
      activeSessionId: 'session:newer-task',
      sessions: [taskSession('newer-task')]
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Back to Task History' }))
    fireEvent.click(await screen.findByTestId('task-tab-older-task'))

    const saved = await screen.findByAltText('Last browser state from this Web Use run')
    expect(saved.getAttribute('src')).toContain('older-task-final.png')
    expect(screen.queryByTestId('watched-web-region')).toBeNull()
    expect(window.api.browser?.reopen).toHaveBeenCalledWith('older-task')
  })

  it('closing the panel hides a running task without stopping it, and Chat can reopen it', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('computer-2', 'computer_use', 'prepare slides', 'running', {
        steps: ['created slide 1']
      })
    )
    await waitFor(() => expect(screen.getAllByText('prepare slides').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByLabelText('Close Tasks'))
    await waitFor(() => expect(screen.queryByTestId('task-side-panel')).toBeNull())
    expect(visionControl).not.toHaveBeenCalledWith('stop')

    openTaskSidePanel({ taskId: 'computer-2', kind: 'computer_task' })
    await waitFor(() => screen.getByTestId('task-side-panel'))
    expect(screen.getAllByText('prepare slides').length).toBeGreaterThan(0)
  })

  it('keeps completed and running tasks in the persistent history rail', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('web-old', 'web_use', 'old web run', 'done'))
    emitTaskChange(
      task('computer-new', 'computer_use', 'new computer run', 'running', { updatedAt: 102 })
    )
    await waitFor(() => screen.getByTestId('task-tab-computer-new'))

    expect(screen.getByRole('complementary', { name: 'Task history' })).toBeTruthy()
    expect(screen.getByTestId('task-tab-computer-new')).toBeTruthy()
    expect(screen.getByTestId('task-tab-web-old')).toBeTruthy()
  })

  it('keeps the durable failed status when a browser session is stale', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('web-stale-session', 'web_use', 'stale browser session', 'failed', {
        updatedAt: 200,
        summary: 'The model response did not parse.'
      })
    )
    emitSessions({
      activeSessionId: 'session:web-stale-session',
      sessions: [taskSession('web-stale-session', { status: 'running' })]
    })

    const row = await screen.findByTestId('task-tab-web-stale-session')
    expect(row.textContent).toContain('failed')
    expect(screen.getByTestId('task-live-controls').textContent).toContain('failed')
  })

  it('drills from the history list into one full detail view while Chat and Live stay available', async () => {
    const chatClick = vi.fn()
    const detailModeChange = vi.fn()
    render(
      <div>
        <button onClick={chatClick}>Send Chat message</button>
        <WatchedBrowserPane onDetailModeChange={detailModeChange} />
      </div>
    )
    const steps = Array.from({ length: 18 }, (_, index) => `recorded step ${index + 1}`)
    emitTaskChange(
      task('web-18', 'web_use', 'older run', 'done', {
        journeyId: 'shared-chat',
        steps,
        updatedAt: 101
      })
    )
    emitTaskChange(
      task('web-live', 'web_use', 'current run', 'running', {
        journeyId: 'shared-chat',
        updatedAt: 102
      })
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Back to Task History' }))
    await waitFor(() => expect(detailModeChange).toHaveBeenLastCalledWith(false))
    fireEvent.click(await screen.findByTestId('task-tab-web-18'))
    await waitFor(() => expect(detailModeChange).toHaveBeenLastCalledWith(false))
    const details = await screen.findByTestId('task-details-web-18')
    expect(details.textContent).toContain('18 steps')
    expect(within(details).getByText('recorded step 18')).toBeTruthy()
    expect(screen.queryByTestId('task-tab-web-live')).toBeNull()
    expect(screen.getByTestId('task-live-pane')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send Chat message' }))
    expect(chatClick).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Back to Task History' }))
    await waitFor(() => expect(detailModeChange).toHaveBeenLastCalledWith(false))
    expect(await screen.findByTestId('task-tab-web-live')).toBeTruthy()
  })

  it('requests the immersive layout once when a running local Web Use attempt starts', async () => {
    const detailModeChange = vi.fn()
    render(<WatchedBrowserPane onDetailModeChange={detailModeChange} />)
    emitTaskChange(task('web-immersive', 'web_use', 'running browser task', 'running'))
    emitSessions({
      activeSessionId: 'session:web-immersive',
      sessions: [taskSession('web-immersive')]
    })

    await waitFor(() => expect(detailModeChange).toHaveBeenLastCalledWith(true))
    expect(await screen.findByTestId('task-details-web-immersive')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back to Task History' }))
    await waitFor(() => expect(detailModeChange).toHaveBeenLastCalledWith(false))

    fireEvent.click(await screen.findByTestId('task-tab-web-immersive'))
    expect(await screen.findByTestId('task-details-web-immersive')).toBeTruthy()
    await waitFor(() => expect(detailModeChange).toHaveBeenLastCalledWith(false))
  })

  it('opens the exact requested run directly in detail mode from Chat', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('web-chat-link', 'web_use', 'linked Chat run', 'done', {
        steps: ['Opened the site', 'Saved the result'],
        updatedAt: 101
      })
    )
    emitTaskChange(task('web-newer', 'web_use', 'newer run', 'done', { updatedAt: 102 }))
    openTaskSidePanel()
    await waitFor(() => screen.getByTestId('task-tab-web-newer'))

    openTaskSidePanel({ taskId: 'web-chat-link', kind: 'web_use', detail: true })

    const details = await screen.findByTestId('task-details-web-chat-link')
    expect(within(details).getByText('Saved the result')).toBeTruthy()
    expect(screen.queryByTestId('task-tab-web-newer')).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to Task History' })).toBeTruthy()
  })

  it('retains a direct detail request until its task record arrives', async () => {
    render(<WatchedBrowserPane />)
    openTaskSidePanel({ taskId: 'web-late-record', kind: 'web_use', detail: true })

    emitTaskChange(
      task('web-late-record', 'web_use', 'late task record', 'done', {
        summary: 'The requested result arrived.',
        steps: ['Saved the requested result']
      })
    )

    const details = await screen.findByTestId('task-details-web-late-record')
    expect(within(details).getByText('The requested result arrived.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back to Task History' })).toBeTruthy()
  })

  it('guides a local running task from its sticky detail composer without faking a trace step', async () => {
    let resolveGuide: ((result: { available: boolean; accepted: boolean }) => void) | undefined
    guideAvailability.mockResolvedValue({ available: true })
    guideTask.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGuide = resolve
        })
    )
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('computer-guide', 'computer_use', 'Edit the deck', 'running', {
        journeyId: 'originating-chat'
      })
    )
    fireEvent.click(await screen.findByTestId('task-tab-computer-guide'))
    const composer = await screen.findByPlaceholderText('Guide this task…')
    const send = screen.getByRole('button', { name: 'Send task guidance' })
    expect((send as HTMLButtonElement).disabled).toBe(true)

    Object.defineProperty(composer, 'scrollHeight', {
      configurable: true,
      get: () => ((composer as HTMLTextAreaElement).value.includes('\n') ? 160 : 40)
    })
    fireEvent.change(composer, { target: { value: 'First line\nSecond line' } })
    expect((composer as HTMLTextAreaElement).style.height).toBe('112px')
    expect((composer as HTMLTextAreaElement).style.overflowY).toBe('auto')
    fireEvent.change(composer, { target: { value: 'Use the shorter title' } })
    expect((composer as HTMLTextAreaElement).style.height).toBe('40px')
    expect((composer as HTMLTextAreaElement).style.overflowY).toBe('hidden')

    const file = new File(['Keep the title under six words.'], 'title-notes.txt', {
      type: 'text/plain'
    })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode('Keep the title under six words.').buffer
    })
    const fileInput = document.querySelector(
      'input[type="file"][accept*=".txt"]'
    ) as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [file] } })
    expect(await screen.findByText('title-notes.txt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove title-notes.txt' }))
    expect(screen.queryByText('title-notes.txt')).toBeNull()
    const dropArea = screen.getByLabelText('Task guidance editor and file drop area')
    fireEvent.dragEnter(dropArea, {
      dataTransfer: { files: [file], dropEffect: 'none' }
    })
    expect(screen.getByText('Drop files here')).toBeTruthy()
    fireEvent.drop(dropArea, {
      dataTransfer: { files: [file], dropEffect: 'copy' }
    })
    expect(await screen.findByText('title-notes.txt')).toBeTruthy()
    expect(screen.queryByText('Drop files here')).toBeNull()
    expect(screen.getByRole('button', { name: 'Attach guidance files' }).className).toContain(
      'rounded-full'
    )
    expect(dropArea.className).toContain('rounded-xl')

    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })
    expect(guideTask).not.toHaveBeenCalled()
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(guideTask).toHaveBeenCalledWith('computer-guide', {
      text: 'Use the shorter title',
      attachments: [
        expect.objectContaining({
          name: 'title-notes.txt',
          mimeType: 'text/plain',
          bytes: expect.anything()
        })
      ]
    })
    expect(
      (guideTask.mock.calls[0]?.[1] as { attachments: Array<{ bytes: ArrayBuffer }> })
        .attachments[0]?.bytes.byteLength
    ).toBeGreaterThan(0)
    expect((await screen.findByRole('status')).textContent).toContain('Sending guidance…')
    expect(screen.queryByText('User guidance')).toBeNull()

    resolveGuide?.({ available: true, accepted: true })
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(''))
    expect(addRagMessage).toHaveBeenCalledWith(
      'originating-chat',
      'user',
      'Use the shorter title',
      {
        taskGuidance: {
          taskId: 'computer-guide',
          state: 'accepted',
          attachmentNames: ['title-notes.txt']
        }
      }
    )
    expect(screen.queryByText('title-notes.txt')).toBeNull()
    expect((await screen.findByRole('status')).textContent).toBe(
      'Guidance accepted. Applying it to the next decision.'
    )
    emitTaskChange(
      task('computer-guide', 'computer_use', 'Edit the deck', 'running', {
        steps: ['USER GUIDANCE · Use the shorter title'],
        updatedAt: 102
      })
    )
    expect(await screen.findByText('User guidance')).toBeTruthy()
    expect(screen.queryByText('Use the shorter title')).toBeNull()

    guideTask.mockRejectedValueOnce(new Error('offline'))
    fireEvent.change(composer, { target: { value: 'Keep the current layout' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Guidance could not be sent. Try again while this task is running.'
    )
    expect((composer as HTMLTextAreaElement).value).toBe('Keep the current layout')
  })

  it('keeps task guidance available while a live task waits for user input', async () => {
    guideAvailability.mockResolvedValue({ available: true })
    render(<WatchedBrowserPane />)
    emitTaskChange(task('waiting-guide', 'web_use', 'Need route details', 'waiting'))
    fireEvent.click(await screen.findByTestId('task-tab-waiting-guide'))
    expect(await screen.findByPlaceholderText('Guide this task…')).toBeTruthy()
    expect(guideAvailability).toHaveBeenCalledWith('waiting-guide')
  })

  it('shows why guidance is unavailable for a remote running task but not a terminal task', async () => {
    guideAvailability.mockResolvedValue({
      available: false,
      reason: 'Guide this task on Studio Mac.'
    })
    render(<WatchedBrowserPane />)
    emitTaskChange(task('done-guide', 'computer_use', 'Done task', 'done'))
    openTaskSidePanel()
    fireEvent.click(await screen.findByTestId('task-tab-done-guide'))
    expect(screen.queryByPlaceholderText('Guide this task…')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Back to Task History' }))
    emitTaskChange(
      task('remote-guide', 'computer_use', 'Remote task', 'running', {
        executionDeviceId: 'studio',
        executionDeviceName: 'Studio Mac',
        updatedAt: 103
      })
    )
    fireEvent.click(await screen.findByTestId('task-tab-remote-guide'))
    await waitFor(() => expect(guideAvailability).toHaveBeenCalledWith('remote-guide'))
    const disabled = screen.getByPlaceholderText('Live guidance is unavailable for this run.')
    expect((disabled as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByText('Guide this task on Studio Mac.')).toBeTruthy()
  })

  it('opens an empty task history instead of ignoring the Tasks button', async () => {
    render(<WatchedBrowserPane />)
    openTaskSidePanel()
    await waitFor(() => screen.getByTestId('task-side-panel'))
    expect(screen.getByText('No task history yet')).toBeTruthy()
  })

  it('opens Computer Use settings inside the same task side panel', async () => {
    const toggleMain = vi.fn()
    const { rerender } = render(<WatchedBrowserPane onToggleMainWorkspace={toggleMain} />)
    emitTaskChange(task('settings-task', 'computer_use', 'settings run', 'running'))
    await waitFor(() => screen.getByTestId('task-side-panel'))
    expect(screen.getByLabelText('Hide main workspace')).toBeTruthy()
    expect(screen.getByLabelText('Hide task history')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Computer Use settings'))
    expect(await screen.findByLabelText('Computer Use task context')).toBeTruthy()
    expect(screen.queryByLabelText('Hide main workspace')).toBeNull()
    expect(screen.queryByLabelText('Hide task history')).toBeNull()
    expect(screen.getByLabelText('Close Tasks')).toBeTruthy()
    expect(screen.getByTestId('task-side-panel')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Computer Use settings'))
    rerender(<WatchedBrowserPane mainWorkspaceCollapsed onToggleMainWorkspace={toggleMain} />)
    expect(screen.getByTestId('show-chat-icon')).toBeTruthy()
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
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Example' })).toBeTruthy())
    expect(screen.getByText('0 tasks')).toBeTruthy()
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
    await waitFor(() => screen.getByRole('tab', { name: 'First page' }))

    fireEvent.click(screen.getByRole('tab', { name: 'First page' }))
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
    fireEvent.click(screen.getByRole('tab', { name: 'First page' }))
    await waitFor(() => expect(activateSession).toHaveBeenCalledWith('session-1'))
    fireEvent.click(
      within(screen.getByTestId('browser-page-manual:history-1')).getByLabelText('Close First page')
    )
    expect(closeSession).toHaveBeenCalledWith('session-1')
  })

  it('lists a persisted completed task while a manual browser page is active', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('web-complete', 'web_use', 'collect launch facts', 'done', {
        summary: 'Saved the launch facts.',
        steps: ['opened the launch page', 'saved the facts'],
        executionDeviceName: 'MacBook Pro',
        updatedAt: 300
      })
    )
    emitSessions({
      activeSessionId: 'manual-live',
      sessions: [
        {
          sessionId: 'manual-live',
          historyId: 'manual-live-history',
          kind: 'manual',
          status: 'open',
          url: 'https://example.com',
          title: 'Manual page',
          canGoBack: false,
          canGoForward: false,
          isLoading: false
        }
      ]
    })
    openTaskSidePanel()

    const history = await waitFor(() => screen.getByRole('complementary', { name: 'Task history' }))
    const completed = within(history).getByTestId('task-tab-web-complete')
    expect(completed.textContent).toContain('Web Use')
    expect(completed.textContent).toContain('done')
    expect(completed.textContent).toContain('MacBook Pro')
    expect(completed.textContent).toContain('2 steps')
    expect(screen.getByRole('tab', { name: 'Manual page' })).toBeTruthy()
    expect(screen.queryByTestId('task-tab-manual:manual-live-history')).toBeNull()

    fireEvent.click(completed)
    await waitFor(() =>
      expect(screen.getAllByText('Saved the launch facts.').length).toBeGreaterThan(0)
    )
    expect(window.api.browser?.reopen).toHaveBeenCalledWith('web-complete')
    expect(screen.getByRole('tab', { name: 'Manual page' })).toBeTruthy()
  })

  it('closing the panel hides it without destroying the running task', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('web-hide', 'web_use', 'research', 'running'))
    await waitFor(() => screen.getByTestId('task-side-panel'))
    fireEvent.click(screen.getByLabelText('Close Tasks'))
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
    expect(pointer.getAttribute('style')).toContain('left: 237px')
    expect(pointer.getAttribute('style')).toContain('top: 177px')
    expect(pointer.querySelector('.animate-ping')).toBeTruthy()
    expect(pointer.querySelector('svg path')?.getAttribute('d')).toBe('M12.586 12.586 19 19')
  })

  it('keeps the last Web Use pointer visible after the task fails', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('web-pointer-failed', 'web_use', 'type and submit', 'running'))
    emitSessions({
      activeSessionId: 'session:web-pointer-failed',
      sessions: [taskSession('web-pointer-failed')]
    })
    await waitFor(() => screen.getByTestId('watched-web-region'))
    emitPointer({
      sessionId: 'session:web-pointer-failed',
      phase: 'released',
      x: 180,
      y: 96
    })
    await waitFor(() => screen.getByTestId('browser-agent-pointer'))

    emitTaskChange(task('web-pointer-failed', 'web_use', 'type and submit', 'failed'))

    const parked = await waitFor(() => screen.getByTestId('browser-agent-pointer'))
    expect(parked.getAttribute('style')).toContain('left: 177px')
    expect(parked.getAttribute('style')).toContain('top: 93px')
    expect(parked.querySelector('.animate-ping')).toBeNull()
  })

  it('keeps only history and live task panes, with resize and collapse controls', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('web-split', 'web_use', 'check the launch page', 'running', {
        journeyId: 'chat-split',
        steps: ['opened https://example.com', 'clicked Launch notes']
      })
    )
    emitSessions({
      activeSessionId: 'journey:chat-split',
      sessions: [
        taskSession('web-split', {
          sessionId: 'journey:chat-split',
          journeyId: 'chat-split',
          title: 'Launch notes'
        })
      ]
    })

    const live = await waitFor(() => screen.getByTestId('task-live-pane'))
    expect(within(live).getByTestId('watched-web-region')).toBeTruthy()
    expect(screen.queryByTestId('task-trace-pane')).toBeNull()
    const separator = screen.getByLabelText('Resize task history and live task')
    const initialSize = Number(separator.getAttribute('aria-valuenow'))
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(initialSize + 5)
    expect(separator.getAttribute('aria-valuetext')).toContain('Task history')
    fireEvent.click(screen.getByLabelText('Hide task history'))
    expect(await screen.findByLabelText('Show task history')).toBeTruthy()
    expect(screen.getByTestId('watched-web-region')).toBeTruthy()
  })

  it('offers explicit Computer Use takeover without mouse-move takeover', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('computer-takeover', 'computer_use', 'edit the deck', 'running'))
    emitVisionState({ taskId: 'computer-takeover', status: 'running' })
    const takeOver = await waitFor(() => screen.getByRole('button', { name: 'Take Over' }))
    expect(screen.queryByText(/move the mouse/i)).toBeNull()
    fireEvent.click(takeOver)
    expect(visionControl).toHaveBeenCalledWith('takeover', 'computer-takeover')
  })

  it('keeps task history and live task independently hideable', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('web-log', 'web_use', 'inspect the page', 'failed', {
        steps: ['opened https://example.com', 'page did not respond']
      })
    )
    await waitFor(() => screen.getByTestId('task-live-pane'))
    fireEvent.click(screen.getByLabelText('Hide task history'))
    await waitFor(() => expect(screen.getByLabelText('Show task history')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Show task history'))
    await waitFor(() => expect(screen.getByLabelText('Hide task history')).toBeTruthy())
  })

  it('renders the task owner status without inventing another renderer status', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('web-detached', 'web_use', 'visit the page', 'stopped'))
    const tab = await waitFor(() => screen.getByTestId('task-tab-web-detached'))
    await waitFor(() => expect(within(tab).getByText('stopped')).toBeTruthy())
    expect(screen.getByText('The browser tab closed before this task finished.')).toBeTruthy()
  })

  it('keeps managed child pages together without leaking them into another task record', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('action-one', 'web_use', 'find the report', 'done', {
        journeyId: 'chat-one',
        steps: ['found the report'],
        updatedAt: 101
      })
    )
    emitTaskChange(
      task('action-two', 'web_use', 'download it', 'running', {
        journeyId: 'chat-one',
        steps: ['opened download page'],
        updatedAt: 102
      })
    )
    emitSessions({
      activeSessionId: 'child-one',
      sessions: [
        {
          ...taskSession('action-two', {
            sessionId: 'journey:chat-one',
            journeyId: 'chat-one',
            title: 'Report'
          })
        },
        {
          ...taskSession('action-two', {
            sessionId: 'child-one',
            journeyId: 'chat-one',
            parentSessionId: 'journey:chat-one',
            title: 'Download'
          })
        }
      ]
    })

    const pages = await waitFor(() => screen.getByRole('tablist', { name: 'Web Use pages' }))
    expect(within(pages).getAllByRole('tab')).toHaveLength(2)
    fireEvent.click(await screen.findByRole('button', { name: 'Back to Task History' }))
    expect(screen.getByTestId('task-tab-action-one')).toBeTruthy()
    expect(screen.getByTestId('task-tab-action-two')).toBeTruthy()
    fireEvent.click(within(pages).getByRole('tab', { name: 'Report' }))
    expect(activateSession).toHaveBeenCalledWith('journey:chat-one')
    fireEvent.click(within(pages).getByLabelText('Close Report'))
    expect(closeSession).toHaveBeenCalledWith('journey:chat-one')
    fireEvent.click(within(pages).getByLabelText('Close Download'))
    expect(closeSession).toHaveBeenCalledWith('child-one')

    fireEvent.click(screen.getByTestId('task-tab-action-one'))
    expect(screen.getByTestId('task-details-action-one')).toBeTruthy()
    expect(screen.queryByTestId('task-tab-action-two')).toBeNull()
    const livePages = await screen.findByRole('tablist', { name: 'Web Use pages' })
    expect(within(livePages).queryByRole('tab', { name: 'Report' })).toBeNull()
    expect(within(livePages).queryByRole('tab', { name: 'Download' })).toBeNull()
  })

  it('shows durable reconnecting status and uses the browser session for local stop', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('web-reconnect', 'web_use', 'finish the form', 'running', {
        journeyId: 'chat-reconnect'
      })
    )
    emitSessions({
      activeSessionId: 'journey:chat-reconnect',
      sessions: [
        taskSession('web-reconnect', {
          sessionId: 'journey:chat-reconnect',
          journeyId: 'chat-reconnect',
          status: 'reconnecting'
        })
      ]
    })
    emitTaskChange(
      task('web-reconnect', 'web_use', 'finish the form', 'reconnecting', {
        journeyId: 'chat-reconnect',
        updatedAt: 101
      })
    )
    const tab = await waitFor(() => screen.getByTestId('task-tab-web-reconnect'))
    expect(within(tab).getByText('reconnecting')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop Web Use' }))
    expect(stopBrowserTask).toHaveBeenCalledWith('web-reconnect')
    expect(visionControl).not.toHaveBeenCalledWith('stop')
  })

  it('shows truthful remote execution status without dead local controls', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('remote-computer', 'computer_use', 'edit on studio Mac', 'running', {
        executionDeviceId: 'studio-mac',
        executionDeviceName: 'Studio Mac'
      })
    )
    await waitFor(() => expect(screen.getByText(/Running on Studio Mac/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Take Over' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.getByText(/Control it from that device/)).toBeTruthy()
  })

  it('uses evidence copy, not live-control copy, for a completed remote run', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('remote-done', 'computer_use', 'finished on QA Mac', 'done', {
        executionDeviceId: 'qa-mac',
        executionDeviceName: 'QA Mac'
      })
    )
    openTaskSidePanel()
    expect(await screen.findByText(/Evidence from QA Mac/)).toBeTruthy()
    expect(screen.getByText(/Execution evidence was recorded on QA Mac/)).toBeTruthy()
    expect(screen.queryByText(/Control it from that device/)).toBeNull()
  })

  it('uses a wider semantic task history surface that follows theme tokens', async () => {
    render(<WatchedBrowserPane />)
    emitTaskChange(task('theme-task', 'web_use', 'inspect theme', 'running'))
    const history = await screen.findByRole('complementary', { name: 'Task history' })
    expect(history.className).toContain('bg-background')
    expect(history.className).toContain('border-border')
    const panel = history.closest('[data-panel-id="task-history"]')
    expect(panel).toBeTruthy()
    expect(Number(panel?.getAttribute('data-panel-size'))).toBeGreaterThanOrEqual(30)
  })

  it('uses the runtime Esc notice and reports a failed local control', async () => {
    visionControl.mockResolvedValueOnce(false)
    render(<WatchedBrowserPane />)
    emitTaskChange(task('local-computer', 'computer_use', 'edit locally', 'running'))
    emitVisionState({
      taskId: 'local-computer',
      notice: 'Esc is unavailable. Use Stop or Take Over in the task controls.'
    })
    expect(await screen.findByText(/Esc is unavailable/)).toBeTruthy()
    expect(screen.queryByText(/Esc when you want control/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not pause this task')
  })

  it('renders structured evidence once and returns to the originating Chat', async () => {
    const navigate = vi.fn()
    window.addEventListener('og:navigate', navigate, { once: true })
    render(<WatchedBrowserPane />)
    emitTaskChange(
      task('audit-task', 'computer_use', 'audit this run', 'done', {
        journeyId: 'chat-42',
        steps: ['legacy duplicate narration'],
        stepDetails: [
          {
            stepId: 'step-1',
            at: 100,
            decisionSummary: 'Open the verified settings control',
            mappedAction: 'click(120, 80)',
            execution: { status: 'complete', result: 'Settings opened' }
          }
        ]
      })
    )
    openTaskSidePanel()
    fireEvent.click(await screen.findByTestId('task-tab-audit-task'))
    expect(screen.queryByText('legacy duplicate narration')).toBeNull()
    expect(screen.getByText(/Open the verified settings control/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Return to originating Chat' }))
    expect((navigate.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      view: 'memory-chat',
      conversationId: 'chat-42'
    })
  })

  it('shows a useful retry error when the runtime rejects the request', async () => {
    retryTask.mockRejectedValueOnce(new Error('IPC unavailable'))
    render(<WatchedBrowserPane />)
    emitTaskChange(task('retry-reject', 'computer_use', 'retry me', 'failed'))
    fireEvent.click(await screen.findByTestId('task-tab-retry-reject'))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry failed step' }))
    expect(await screen.findByText(/Retry could not start/)).toBeTruthy()
  })

  it('shows retry progress and keeps the resumed task selected', async () => {
    let finishRetry: ((result: { available: boolean; taskId: string }) => void) | undefined
    retryTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRetry = resolve
        })
    )
    render(<WatchedBrowserPane />)
    emitTaskChange(task('retry-old', 'computer_use', 'retry this run', 'failed'))
    fireEvent.click(await screen.findByTestId('task-tab-retry-old'))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry failed step' }))
    expect(await screen.findByRole('button', { name: 'Retrying…' })).toBeTruthy()

    await act(async () => finishRetry?.({ available: true, taskId: 'retry-old' }))
    emitTaskChange(
      task('retry-old', 'computer_use', 'retry this run', 'running', { updatedAt: 200 })
    )
    await waitFor(() => expect(screen.getByTestId('task-details-retry-old')).toBeTruthy())
  })
})
