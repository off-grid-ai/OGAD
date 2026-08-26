// @vitest-environment jsdom
//
// RELEASE_TEST_CHECKLIST #50 and #59 - desktop navigation and project-layout
// integration coverage.
//
// The real App shell and Projects screen are mounted. Electron, model health,
// and native event subscriptions are the only boundary fakes. Navigation is
// reached through real clicks and KeyboardEvents, and assertions stay on the
// rendered view and selected project.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHook } from '../bootstrap/hookRegistry'
import { NOTIFICATION_RESOLVE_TARGET_HOOK } from '../lib/notification-hooks'
import {
  createProNotificationTarget,
  resolveProNotificationTarget
} from '../../../../pro/shared/notification-target'
import { TooltipProvider } from '../components/ui/tooltip'
import { closeTaskWorkspace, openTaskSidePanel } from '../lib/task-side-panel'
import { resetTaskSessionStoreForTests } from '../lib/task-session-store'
import { registerSlot, SLOTS, clearRegisteredSlots } from '../bootstrap/slotRegistry'
import { WatchedBrowserPane } from '../../../../pro/renderer/components/browser/WatchedBrowserPane'
import {
  APP_PROJECTS,
  installAppBoundary,
  installAppBrowserBoundary,
  installAppStorage
} from './harness/app-boundary'

const rendererActivation = vi.hoisted(() => ({
  load: vi.fn<() => Promise<void>>()
}))

vi.mock('../bootstrap/loadProFeaturesRenderer', () => ({
  loadProFeaturesRenderer: rendererActivation.load
}))

let App: typeof import('../App').default

describe('<App/> desktop navigation integration', () => {
  beforeAll(async () => {
    // App's renderer graph includes modules that capture the preload bridge at
    // module initialization. Install that real boundary once, then keep module
    // loading outside the interaction assertion's timeout budget.
    installAppBoundary()
    installAppBrowserBoundary()
    ;({ default: App } = await import('../App'))
  }, 30_000)

  beforeEach(() => {
    vi.clearAllMocks()
    Element.prototype.scrollIntoView = (): void => {}
    rendererActivation.load.mockResolvedValue(undefined)
    installAppStorage().setItem('onboarding_completed', 'true')
    window.history.replaceState(null, '', '/projects')
    installAppBoundary()
    installAppBrowserBoundary()
    closeTaskWorkspace()
    resetTaskSessionStoreForTests()
    registerSlot(SLOTS.taskWorkspace, WatchedBrowserPane)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    clearRegisteredSlots()
  })

  it('keeps a dense project master-detail state through Cmd+[ and Cmd+] (#50, #59)', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Projects' }, { timeout: 5_000 })
    ).not.toBeNull()
    await Promise.all(
      APP_PROJECTS.map((project) => screen.findByRole('button', { name: project.name }))
    )
    await user.click(await screen.findByRole('button', { name: 'Project Beta' }))
    expect(screen.getAllByText('Project Beta')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Chats' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Artifacts' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Knowledge & settings' })).not.toBeNull()

    let shortcutDispatched = false
    const observer = new MutationObserver(() => {
      if (shortcutDispatched || !screen.queryByRole('heading', { name: 'Integrations' })) return
      shortcutDispatched = true
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true, bubbles: true }))
    })
    observer.observe(document.body, { childList: true, subtree: true })
    try {
      // By role and name: the collapsed rail still exposes every destination to
      // assistive technology even when its visible text is hidden.
      await user.click(screen.getByRole('button', { name: 'Integrations' }))
      await waitFor(() => expect(shortcutDispatched).toBe(true))
    } finally {
      observer.disconnect()
    }

    await waitFor(() => expect(screen.getAllByText('Project Beta')).toHaveLength(2))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', metaKey: true, bubbles: true }))
    })
    expect(
      await screen.findByRole('heading', { name: 'Integrations' }, { timeout: 5_000 })
    ).not.toBeNull()
  })

  it.each([
    ['ready', /Model server: model running/i],
    ['down', /Model server stopped/i]
  ] as const)('opens Setup & health from the %s model status row', async (status, label) => {
    const user = userEvent.setup()
    installAppBoundary({
      systemHealth: async () => ({ ramGb: 16, components: [{ id: 'chat', status }] })
    })
    render(<App />)

    const modelStatus = await screen.findByRole('button', { name: label })
    await user.click(modelStatus)

    await waitFor(() => expect(window.location.pathname).toBe('/settings/setup'))
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByText('Setup & health')).toBeTruthy()
    expect(screen.getByText('Configure it for me')).toBeTruthy()
  })

  it('starts collapsed and stays expanded only while hovered', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('heading', { name: 'Projects' })
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
    expect(navigation.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Menu')).toBeNull()

    await user.hover(navigation)
    expect(await screen.findByText('Menu')).toBeTruthy()
    expect(navigation.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Integrations' }))
    await waitFor(() => expect(window.location.pathname).toBe('/connectors'))
    expect(navigation.getAttribute('aria-expanded')).toBe('true')

    await user.unhover(navigation)
    await waitFor(() => expect(navigation.getAttribute('aria-expanded')).toBe('false'))
    expect(screen.queryByText('Menu')).toBeNull()
  })

  it('expands for keyboard focus and collapses when focus leaves the navigation', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('heading', { name: 'Projects' })
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
    expect(navigation.getAttribute('aria-expanded')).toBe('false')

    await user.tab()
    await waitFor(() => expect(navigation.getAttribute('aria-expanded')).toBe('true'))

    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    await waitFor(() => expect(navigation.getAttribute('aria-expanded')).toBe('false'))
    outside.remove()
  })

  it('collapses the sidebar after Command-K navigation to a screen', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('heading', { name: 'Projects' }, { timeout: 5_000 })
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
    expect(navigation.getAttribute('aria-expanded')).toBe('false')

    await user.keyboard('{Meta>}k{/Meta}')
    const input = await screen.findByPlaceholderText(/jump to a screen/i)
    await user.type(input, 'settings')
    await user.click(await screen.findByTestId('palette-screen-settings-root'))

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy()
    expect(navigation.getAttribute('aria-expanded')).toBe('false')
  })

  it('subscribes to notification routes only after Pro target hooks finish activating (#114)', async () => {
    let finishActivation: (() => void) | undefined
    rendererActivation.load.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishActivation = resolve
        })
    )
    const onNewApproval = vi.fn(() => () => {})
    const onNewAction = vi.fn(() => () => {})
    const proOn = vi.fn(() => () => {})
    installAppBoundary({ isPro: true, onNewApproval, onNewAction, proOn })

    render(<App />)
    await waitFor(() => expect(rendererActivation.load).toHaveBeenCalledTimes(1))
    expect(onNewApproval).not.toHaveBeenCalled()
    expect(onNewAction).not.toHaveBeenCalled()
    expect(proOn).toHaveBeenCalledWith('capture:changed', expect.any(Function))
    expect(proOn).not.toHaveBeenCalledWith('notification:open-target', expect.any(Function))

    act(() => finishActivation?.())

    await waitFor(() => expect(onNewApproval).toHaveBeenCalledTimes(1))
    // Approvals reach the bell; action candidates deliberately do NOT. 57a3e7d removed this
    // subscription and excluded type 'todo' from notification state in the same change, so the unread
    // count means "something is waiting on your decision" rather than counting suggestions the app
    // made for itself. A to-do already has a home - DayView lists it, and opening one routes to
    // { view: 'actions', mode: 'todo' } - so mirroring it into the bell would say the same thing twice.
    //
    // Asserted as an absence, because that is the behaviour worth protecting: re-adding the
    // subscription would quietly restore the double-notification that commit set out to remove.
    expect(onNewAction).not.toHaveBeenCalled()
    expect(proOn).toHaveBeenCalledWith('notification:open-target', expect.any(Function))
  })

  it('opens the exact Action execution chat from its notification', async () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    const executionChat = vi.fn(async (approvalId: number) => {
      expect(approvalId).toBe(17)
      return 'execution-chat-17'
    })
    installAppBoundary({
      isPro: true,
      approvalsExecutionChat: executionChat,
      actions: { onGatePending: () => () => {}, onOutcome: () => () => {} },
      vision: { onTaskState: () => () => {}, onStep: () => () => {} },
      proOn: (channel: string, listener: (payload: unknown) => void) => {
        listeners.set(channel, listener)
        return () => listeners.delete(channel)
      }
    })
    registerHook(NOTIFICATION_RESOLVE_TARGET_HOOK, resolveProNotificationTarget)
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>
    )
    await waitFor(() => expect(listeners.has('notification:open-target')).toBe(true))

    act(() => {
      listeners.get('notification:open-target')?.(createProNotificationTarget('approval', 17))
    })

    await waitFor(() => expect(executionChat).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(window.location.pathname).toBe('/chat'))
  })

  it('opens active-model settings over the originating screen and closes it with Cmd+[', async () => {
    window.history.replaceState(null, '', '/models')
    let llmSettings = {
      ctxSize: 65536,
      effectiveCtxSize: 32768,
      modelMaxCtx: 262144
    }
    const setLlmSettings = vi.fn(async (patch: Partial<typeof llmSettings>) => {
      llmSettings = { ...llmSettings, ...patch, effectiveCtxSize: patch.ctxSize ?? 32768 }
    })
    installAppBoundary({
      getModelCatalog: async () => ({
        kinds: ['vision'],
        models: [
          {
            id: 'local/qwen',
            name: 'Qwen 3.5 2B',
            kind: 'vision',
            files: [{ name: 'qwen.gguf', url: 'https://example.test/qwen.gguf', sizeBytes: 2e9 }]
          }
        ]
      }),
      getInstalledModels: async () => ['local/qwen'],
      getActiveModelIds: async () => ['local/qwen'],
      getActiveModel: async () => 'local/qwen',
      getLlmSettings: async () => llmSettings,
      setLlmSettings
    })
    render(<App />)
    await waitFor(() => expect(window.location.pathname).toBe('/models'))
    act(() => {
      window.dispatchEvent(new CustomEvent('og:open-model-settings-panel'))
    })

    expect(await screen.findByRole('dialog', { name: 'Model settings' })).toBeTruthy()
    expect(window.location.pathname).toBe('/models')
    expect(await screen.findByText('Qwen 3.5 2B')).toBeTruthy()
    expect(screen.getByText('64K')).toBeTruthy()
    expect(screen.getByText('32K')).toBeTruthy()
    expect(screen.getByText('16K')).toBeTruthy()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true, bubbles: true }))
    })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Model settings' })).toBeNull())
    expect(window.location.pathname).toBe('/models')
  })

  it('keeps a Devices subroute only while Devices remains the active screen', async () => {
    const user = userEvent.setup()
    installAppBoundary({ universalSearch: async () => [] })
    render(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Projects' }, { timeout: 5_000 })
    ).toBeTruthy()

    await user.keyboard('{Meta>}k{/Meta}')
    const search = await screen.findByPlaceholderText(/jump to a screen/i)
    await user.type(search, 'Activity')
    await user.click(await screen.findByTestId('palette-screen-devices-activity'))
    await waitFor(() => expect(window.location.pathname).toBe('/devices/activity'))

    await user.keyboard('{Meta>}k{/Meta}')
    const nextSearch = await screen.findByPlaceholderText(/jump to a screen/i)
    await user.type(nextSearch, 'Models')
    await user.click(await screen.findByTestId('palette-screen-models-root'))
    await waitFor(() => expect(window.location.pathname).toBe('/models'))

    await user.keyboard('{Meta>}k{/Meta}')
    const finalSearch = await screen.findByPlaceholderText(/jump to a screen/i)
    await user.type(finalSearch, 'Devices')
    await user.click(await screen.findByTestId('palette-screen-devices-root'))
    await waitFor(() => expect(window.location.pathname).toBe('/devices'))
  })

  it('opens an initial Devices Activity deep link', async () => {
    const { registerProView } = await import('../bootstrap/proView')
    registerProView((view, context) =>
      view === 'devices' ? <div>Devices view: {context.navigationSubroute}</div> : null
    )
    installAppBoundary({ isPro: true })
    window.history.replaceState(null, '', '/devices/activity')

    render(<App />)

    expect(await screen.findByText('Devices view: activity')).toBeTruthy()
    expect(window.location.pathname).toBe('/devices/activity')
  })

  it('falls back to the Devices root for a malformed encoded subroute', async () => {
    const { registerProView } = await import('../bootstrap/proView')
    registerProView((view, context) =>
      view === 'devices' ? <div>Devices root: {context.navigationSubroute ?? 'none'}</div> : null
    )
    installAppBoundary({ isPro: true })
    window.history.replaceState(null, '', '/devices/%E0%A4%A')

    render(<App />)

    expect(await screen.findByText('Devices root: none')).toBeTruthy()
    await waitFor(() => expect(window.location.pathname).toBe('/devices'))
  })

  it('falls back to the Settings root for a malformed encoded section', async () => {
    window.history.replaceState(null, '', '/settings/%E0%A4%A')

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy()
    await waitFor(() => expect(window.location.pathname).toBe('/settings'))
  })

  it('routes permission recovery into the existing Setup & health detail', async () => {
    const user = userEvent.setup()
    installAppBoundary({
      isPro: true,
      getPermissionStatus: async () => ({
        accessibility: true,
        screenRecording: false,
        localNetwork: true,
        allGranted: false
      })
    })
    render(<App />)
    expect(
      await screen.findByRole('heading', { name: 'Projects' }, { timeout: 5_000 })
    ).toBeTruthy()

    act(() => {
      window.dispatchEvent(
        new CustomEvent('og:navigate', {
          detail: { view: 'settings', section: 'permissions' }
        })
      )
    })

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy()
    expect(window.location.pathname).toBe('/settings/permissions')
    expect(await screen.findByText('System permissions')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Screen Recording' })).toBeTruthy()
    expect(screen.getByText('Permission needed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Permissions' })).toBeNull()

    await user.click(screen.getByText('Setup & health'))
    await waitFor(() => expect(screen.queryByText('System permissions')).toBeNull())
    expect(window.location.pathname).toBe('/settings')

    act(() => {
      window.dispatchEvent(
        new CustomEvent('og:navigate', {
          detail: { view: 'settings', section: 'permissions' }
        })
      )
    })
    expect(await screen.findByText('System permissions')).toBeTruthy()
  })

  it('shows Tasks only on Chat routes and restores it after route navigation', async () => {
    const setRegion = vi.fn()
    window.history.replaceState(null, '', '/chat')
    installAppBoundary({
      isPro: true,
      tasks: { list: async () => [], onChanged: () => () => {} },
      browser: { setRegion },
      actions: { onGatePending: () => () => {}, onOutcome: () => () => {} }
    })
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>
    )

    act(() => openTaskSidePanel())
    const taskPanel = await screen.findByTestId('task-side-panel')
    const chatTaskWorkspace = taskPanel.closest('[data-testid="main-task-workspace"]')
    const chatHeader = screen.getByRole('heading', { name: 'Off Grid AI' }).closest('header')
    expect(chatTaskWorkspace).toBeTruthy()
    expect(chatHeader?.nextElementSibling).toBe(chatTaskWorkspace)
    expect(chatHeader?.parentElement).toBe(chatTaskWorkspace?.parentElement)
    setRegion.mockClear()

    act(() => {
      window.dispatchEvent(new CustomEvent('og:navigate', { detail: { view: 'search' } }))
    })
    await waitFor(() => expect(screen.queryByTestId('task-side-panel')).toBeNull())
    expect(setRegion).toHaveBeenCalledWith(null)

    act(() => {
      window.dispatchEvent(new CustomEvent('og:navigate', { detail: { view: 'memory-chat' } }))
    })
    expect(await screen.findByTestId('task-side-panel')).toBeTruthy()
    const separator = screen.getByRole('separator', { name: 'Resize Chat and task' })
    const initialSize = Number(separator.getAttribute('aria-valuenow'))
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(initialSize + 5)
    expect(separator.getAttribute('aria-valuetext')).toContain('Task workspace')
  })

  it('gives each local Web Use attempt one collapsible detail reveal', async () => {
    let emitTaskChange: ((task: unknown) => void) | undefined
    let emitSessions: ((snapshot: unknown) => void) | undefined
    window.history.replaceState(null, '', '/chat')
    installAppBoundary({
      isPro: true,
      getRagConversations: async () => [
        { id: 'chat-web-start', title: 'Web start', updated_at: '2026-08-25T00:00:00.000Z' }
      ],
      getRagMessages: async () => [],
      getActiveRagStreams: async () => [],
      imageGenJobStatus: async () => ({}),
      tasks: {
        list: async () => [],
        onChanged: (listener: (task: unknown) => void) => {
          emitTaskChange = listener
          return () => {}
        }
      },
      browser: {
        getSessions: async () => ({ activeSessionId: null, sessions: [] }),
        listManualHistory: async () => [],
        setRegion: vi.fn(),
        onSessionsState: (listener: (snapshot: unknown) => void) => {
          emitSessions = listener
          return () => {}
        }
      },
      actions: { onGatePending: () => () => {}, onOutcome: () => () => {} }
    })
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>
    )

    expect((await screen.findAllByText('Web start')).length).toBeGreaterThan(0)
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
    expect(navigation.getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => {
      expect(emitTaskChange).toBeTypeOf('function')
      expect(emitSessions).toBeTypeOf('function')
    })

    const task = {
      taskId: 'web-start-task',
      journeyId: 'chat-web-start',
      kind: 'web_use',
      title: 'Open the launch page',
      status: 'running',
      steps: [],
      startedAt: 1,
      updatedAt: 1
    }
    act(() => {
      emitTaskChange?.(task)
      emitSessions?.({
        activeSessionId: 'session:web-start-task',
        sessions: [
          {
            sessionId: 'session:web-start-task',
            kind: 'task',
            taskId: 'web-start-task',
            status: 'running',
            url: 'https://example.com/launch',
            title: 'Launch',
            canGoBack: false,
            canGoForward: false,
            isLoading: false
          }
        ]
      })
    })

    expect(await screen.findByTestId('task-details-web-start-task')).toBeTruthy()
    await waitFor(() => {
      expect(navigation.getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('heading', { name: 'Off Grid AI' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Expand Chat' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Show conversations' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Show conversations' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Collapse conversation list' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Collapse Chat' })).toBeTruthy()
      expect(screen.getByTestId('task-side-panel')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Chat' }))
    await waitFor(() => {
      expect(screen.getByTestId('task-side-panel')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Hide task pane' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Expand Chat' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Expand Chat' }))
    await waitFor(() => {
      expect(screen.getByTestId('task-side-panel')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Hide task pane' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Collapse Chat' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Collapse conversation list' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Show conversations' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Show conversations' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Collapse conversation list' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Chat' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Expand Chat' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Show conversations' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Expand Chat' }))
    await waitFor(() => {
      expect(screen.getByTestId('task-side-panel')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Hide task pane' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Collapse Chat' })).toBeTruthy()
    })

    act(() =>
      emitTaskChange?.({
        ...task,
        status: 'done',
        summary: 'The launch page opened.',
        finishedAt: 2,
        updatedAt: 2
      })
    )
    await waitFor(() => {
      expect(navigation.getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('button', { name: 'Collapse Chat' })).toBeTruthy()
    })

    act(() => emitTaskChange?.({ ...task, updatedAt: 3 }))
    expect(await screen.findByTestId('task-details-web-start-task')).toBeTruthy()
    await waitFor(() => {
      expect(navigation.getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('heading', { name: 'Off Grid AI' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Expand Chat' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Back to Task History' }))
    await waitFor(() => {
      expect(screen.queryByTestId('task-details-web-start-task')).toBeNull()
      expect(navigation.getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('button', { name: 'Collapse Chat' })).toBeTruthy()
    })

    act(() => emitTaskChange?.({ ...task, steps: ['Opened the page'], updatedAt: 4 }))
    await waitFor(() => {
      expect(screen.queryByTestId('task-details-web-start-task')).toBeNull()
      expect(navigation.getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('button', { name: 'Collapse Chat' })).toBeTruthy()
    })
  })

  it('keeps the user in Chat until they confirm sidebar or internal navigation', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/chat')
    installAppBoundary({
      getRagConversations: async () => [
        { id: 'chat-guard', title: 'Guard test', updated_at: '2026-08-25T00:00:00.000Z' }
      ],
      tasks: {
        list: async () => [
          {
            taskId: 'running-web-task',
            journeyId: 'chat-guard',
            kind: 'web_use',
            title: 'Research',
            status: 'running',
            steps: [],
            startedAt: 1,
            updatedAt: 2
          }
        ],
        onChanged: () => () => {}
      },
      actions: { onGatePending: () => () => {}, onOutcome: () => () => {} }
    })
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>
    )

    expect((await screen.findAllByText('Guard test')).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Projects' }))
    expect(
      await screen.findByRole('dialog', { name: 'Leave this chat while the task is running?' })
    ).toBeTruthy()
    expect(window.location.pathname).toBe('/chat')

    await user.click(screen.getByRole('button', { name: 'Stay in chat' }))
    expect(
      screen.queryByRole('dialog', { name: 'Leave this chat while the task is running?' })
    ).toBeNull()
    expect(window.location.pathname).toBe('/chat')

    act(() => {
      window.dispatchEvent(new CustomEvent('og:navigate', { detail: { view: 'settings' } }))
    })
    expect(
      await screen.findByRole('dialog', { name: 'Leave this chat while the task is running?' })
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Leave chat' }))
    await waitFor(() => expect(window.location.pathname).toBe('/settings'))
  })

  it('defers Back history changes until the user confirms leaving Chat', async () => {
    const user = userEvent.setup()
    installAppBoundary({
      getRagConversations: async () => [
        { id: 'chat-guard', title: 'Guard test', updated_at: '2026-08-25T00:00:00.000Z' }
      ],
      tasks: {
        list: async () => [
          {
            taskId: 'running-computer-task',
            journeyId: 'chat-guard',
            kind: 'computer_use',
            title: 'Organize files',
            status: 'running',
            steps: [],
            startedAt: 1,
            updatedAt: 2
          }
        ],
        onChanged: () => () => {}
      },
      actions: { onGatePending: () => () => {}, onOutcome: () => () => {} }
    })
    render(
      <TooltipProvider>
        <App />
      </TooltipProvider>
    )
    await screen.findByRole('heading', { name: 'Projects' })
    await user.click(screen.getByRole('button', { name: 'Chat' }))
    expect((await screen.findAllByText('Guard test')).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(
      await screen.findByRole('dialog', { name: 'Leave this chat while the task is running?' })
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Stay in chat' }))
    expect(window.location.pathname).toBe('/chat')

    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Leave chat' }))
    await waitFor(() => expect(window.location.pathname).toBe('/projects'))
  })
})
