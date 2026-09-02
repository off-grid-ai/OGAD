// @vitest-environment jsdom
//
// RELEASE_TEST_CHECKLIST #50 and #59 - desktop navigation and project-layout
// integration coverage.
//
// The real App shell and Projects screen are mounted. Electron, model health,
// and native event subscriptions are the only boundary fakes. Navigation is
// reached through real clicks and KeyboardEvents, and assertions stay on the
// rendered view and selected project.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { NOTIFICATION_STORAGE_KEY } from '../hooks/notification-state'
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

const MODEL_KINDS = ['text', 'image', 'computer_use', 'voice', 'transcription']

function modelControlSnapshot(
  overrides: {
    kinds?: string[]
    models?: unknown[]
    installed?: string[]
    activeIds?: string[]
    active?: Partial<{
      text: string | null
      image: string | null
      speech: string | null
      transcription: string | null
      computer_use: string | null
    }>
  } = {}
): Record<string, unknown> {
  return {
    kinds: overrides.kinds ?? MODEL_KINDS,
    models: overrides.models ?? [],
    installed: overrides.installed ?? [],
    activeIds: overrides.activeIds ?? [],
    active: {
      text: null,
      image: null,
      speech: null,
      transcription: null,
      computer_use: null,
      ...overrides.active
    },
    computerUse: null
  }
}

function routedTabButton(label: string): HTMLButtonElement {
  const button = screen
    .getAllByRole('button', { name: new RegExp(`^${label}`) })
    .find((candidate) => !candidate.className.includes('group/nav'))
  if (!(button instanceof HTMLButtonElement)) throw new Error(`No routed tab button for ${label}`)
  return button
}

describe('<App/> desktop navigation integration', () => {
  beforeAll(async () => {
    // App's renderer graph includes modules that capture the preload bridge at
    // module initialization. Install that real boundary once, then keep module
    // loading outside the interaction assertion's timeout budget.
    installAppBoundary({
      getModelControlSnapshot: async () => modelControlSnapshot()
    })
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
      chatHealth: async () => ({ id: 'chat', label: 'Chat model', status })
    })
    render(<App />)

    const modelStatus = await screen.findByRole('button', { name: label })
    await user.click(modelStatus)

    await waitFor(() => expect(window.location.pathname).toBe('/settings/setup'))
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByText('Setup & health')).toBeTruthy()
    expect(screen.getByText('Configure it for me')).toBeTruthy()
  })

  it('uses lifecycle updates and only checks idle chat health once per visible minute', async () => {
    vi.useFakeTimers()
    let publishHealth: ((health: { status: string }) => void) | undefined
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const chatHealth = vi.fn().mockResolvedValue({
      id: 'chat',
      label: 'Chat model',
      status: 'starting'
    })
    const systemHealth = vi.fn(async () => ({ ramGb: 16, components: [] }))
    installAppBoundary({
      chatHealth,
      systemHealth,
      onChatHealthChanged: (callback: (health: { status: string }) => void) => {
        publishHealth = callback
        return vi.fn()
      }
    })

    render(<App />)

    await act(async () => Promise.resolve())
    expect(screen.getByRole('button', { name: /Model server: model starting/i })).toBeTruthy()
    act(() => publishHealth?.({ status: 'ready' }))
    expect(screen.getByRole('button', { name: /Model server: model running/i })).toBeTruthy()
    const initialReads = chatHealth.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(59_999))
    expect(chatHealth).toHaveBeenCalledTimes(initialReads)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(chatHealth).toHaveBeenCalledTimes(initialReads + 1)

    visibility = 'hidden'
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(chatHealth).toHaveBeenCalledTimes(initialReads + 1)

    visibility = 'visible'
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(chatHealth).toHaveBeenCalledTimes(initialReads + 2)
    expect(systemHealth).not.toHaveBeenCalled()
  })

  it('starts collapsed and stays expanded only while hovered', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('heading', { name: 'Projects' })
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
    expect(navigation.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Menu')).toBeNull()
    const menu = navigation.querySelector<HTMLElement>('[aria-label="Menu sections"]')!
    const buttonNames = (): string[] =>
      within(menu)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '')
    const collapsedDestinations = buttonNames()
    expect(collapsedDestinations).toEqual(
      expect.arrayContaining(['Discover', 'Work', 'Private Data', 'System', 'Projects'])
    )
    expect(new Set(collapsedDestinations).size).toBe(collapsedDestinations.length)
    const sectionIndexes = ['Discover', 'Work', 'Private Data', 'System'].map((label) =>
      collapsedDestinations.indexOf(label)
    )
    expect(sectionIndexes).toEqual([...sectionIndexes].sort((a, b) => a - b))
    expect(screen.getByRole('button', { name: /Model server:/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Theme: System' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mobile app' })).toBeTruthy()

    await user.hover(navigation)
    expect(screen.queryByText('Menu')).toBeNull()
    expect(navigation.getAttribute('aria-expanded')).toBe('true')
    expect(buttonNames()).toEqual(collapsedDestinations)

    fireEvent.click(screen.getByRole('button', { name: 'Integrations' }))
    await waitFor(() => expect(window.location.pathname).toBe('/connectors'))
    expect(navigation.getAttribute('aria-expanded')).toBe('true')

    await user.unhover(navigation)
    await waitFor(() => expect(navigation.getAttribute('aria-expanded')).toBe('false'))
    expect(screen.queryByText('Menu')).toBeNull()
  })

  it('keeps a section toggle and destination order through hover collapse and expansion', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('heading', { name: 'Projects' })
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
    await user.hover(navigation)
    const discover = screen.getByRole('button', { name: 'Discover' })
    await user.click(discover)
    expect(discover.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Explore' })).toBeNull()

    await user.unhover(navigation)
    await waitFor(() => expect(navigation.getAttribute('aria-expanded')).toBe('false'))
    expect(screen.getByRole('button', { name: 'Discover' }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(screen.queryByRole('button', { name: 'Explore' })).toBeNull()

    await user.hover(navigation)
    expect(screen.getByRole('button', { name: 'Discover' }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(screen.queryByRole('button', { name: 'Explore' })).toBeNull()
  })

  it('keeps the notification badge and active route visible at both sidebar widths', async () => {
    const storage = installAppStorage()
    storage.setItem('onboarding_completed', 'true')
    storage.setItem(
      NOTIFICATION_STORAGE_KEY,
      JSON.stringify(
        Array.from({ length: 10 }, (_, index) => ({
          id: `notice-${index}`,
          type: 'info',
          title: `Notice ${index}`,
          message: 'Stored on this device.',
          timestamp: new Date(1_700_000_000_000 + index).toISOString(),
          read: false
        }))
      )
    )
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('heading', { name: 'Projects' })
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
    const projects = screen.getByRole('button', { name: 'Projects' })
    expect(projects.className).toContain('text-emerald-400')
    expect(screen.getByLabelText('10 unread notifications').textContent).toBe('9+')

    await user.hover(navigation)
    expect(screen.getByRole('button', { name: 'Projects' }).className).toContain('text-emerald-400')
    expect(screen.getByLabelText('10 unread notifications').textContent).toBe('9+')
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

  it('activates Pro notification routes without subscribing to action events', async () => {
    let finishActivation: (() => void) | undefined
    rendererActivation.load.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishActivation = resolve
        })
    )
    const onNewAction = vi.fn(() => () => {})
    const proOn = vi.fn(() => () => {})
    installAppBoundary({ isPro: true, onNewAction, proOn })

    render(<App />)
    await waitFor(() => expect(rendererActivation.load).toHaveBeenCalledTimes(1))
    expect(onNewAction).not.toHaveBeenCalled()
    expect(proOn).toHaveBeenCalledWith('capture:changed', expect.any(Function))
    expect(proOn).not.toHaveBeenCalledWith('notification:open-target', expect.any(Function))

    act(() => finishActivation?.())

    await waitFor(() =>
      expect(proOn).toHaveBeenCalledWith('notification:open-target', expect.any(Function))
    )
    expect(onNewAction).not.toHaveBeenCalled()
  })

  it('opens an existing execution Chat notification without an approval target', async () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    installAppBoundary({
      isPro: true,
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
      listeners.get('notification:open-target')?.(
        createProNotificationTarget('execution-chat', 'execution-chat-17')
      )
    })

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
      getModelControlSnapshot: async () =>
        modelControlSnapshot({
          kinds: ['vision'],
          models: [
            {
              id: 'local/qwen',
              name: 'Qwen 3.5 2B',
              kind: 'vision',
              files: [{ name: 'qwen.gguf', url: 'https://example.test/qwen.gguf', sizeBytes: 2e9 }]
            }
          ],
          installed: ['local/qwen'],
          activeIds: ['local/qwen'],
          active: { text: 'local/qwen' }
        }),
      getActiveModel: async () => 'local/qwen',
      getLlmSettings: async () => llmSettings,
      setLlmSettings
    })
    render(<App />)
    await waitFor(() => expect(window.location.pathname).toBe('/models'))
    act(() => {
      window.dispatchEvent(new CustomEvent('og:open-model-settings-panel'))
    })

    const modelSettings = await screen.findByRole('dialog', { name: 'Model settings' })
    expect(modelSettings).toBeTruthy()
    expect(window.location.pathname).toBe('/models')
    expect(await within(modelSettings).findByText('Qwen 3.5 2B')).toBeTruthy()
    expect(within(modelSettings).getByText('64K')).toBeTruthy()
    expect(within(modelSettings).getByText('32K')).toBeTruthy()
    expect(within(modelSettings).getByText('16K')).toBeTruthy()

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

  it.each([
    {
      name: 'Sync',
      startPath: '/devices/sharing',
      startTab: 'Sync sharing',
      routes: [
        ['Devices', '/devices'],
        ['Activity', '/devices/activity'],
        ['Files', '/devices/files']
      ] as const
    },
    {
      name: 'Entities',
      startPath: '/entities/people',
      startTab: 'People',
      routes: [
        ['All', '/entities'],
        ['Projects', '/entities/projects'],
        ['Companies', '/entities/companies'],
        ['Topics', '/entities/topics'],
        ['Places', '/entities/places'],
        ['Objects', '/entities/objects']
      ] as const
    },
    {
      name: 'Models',
      startPath: '/models/storage',
      startTab: 'Storage',
      routes: [
        ['Text', '/models'],
        ['Image', '/models/image'],
        ['Computer Use', '/models/computer-use'],
        ['Voice', '/models/voice'],
        ['Transcription', '/models/transcription']
      ] as const
    },
    {
      name: 'Notifications',
      startPath: '/notifications/sharing',
      startTab: 'Sharing',
      routes: [['All', '/notifications']] as const
    }
  ])(
    'keeps every $name tab in direct URLs, refresh, and app Back history',
    async ({ startPath, startTab, routes }) => {
      const routeEntries = routes
      const { registerProView } = await import('../bootstrap/proView')
      const { proView } = await import('../../../../pro/renderer/proView')
      registerProView(proView)
      installAppBoundary({
        isPro: true,
        getModelControlSnapshot: async () => modelControlSnapshot(),
        crmListEntities: async () => [],
        proInvoke: async (channel: string) => {
          if (channel === 'pro:sync:status') return undefined
          if (channel === 'pro:sync:prefs') return { prefs: null, categories: [] }
          if (channel === 'pro:sync:model-transfer-jobs') return []
          return undefined
        }
      })
      window.history.replaceState(null, '', startPath)
      const user = userEvent.setup()

      const mounted = render(<App />)

      await screen.findAllByRole('button', { name: new RegExp(`^${startTab}`) })
      const initial = routedTabButton(startTab)
      expect(initial.getAttribute('aria-current')).toBe('page')
      expect(window.location.pathname).toBe(startPath)

      for (const [label, path] of routeEntries) {
        await screen.findAllByRole('button', { name: new RegExp(`^${label}`) }, { timeout: 10_000 })
        await user.click(routedTabButton(label))
        await waitFor(() => expect(window.location.pathname).toBe(path))
        await waitFor(() =>
          expect(routedTabButton(label).getAttribute('aria-current')).toBe('page')
        )
      }

      const [previousTab, previousPath] = routeEntries.at(-2) ?? [startTab, startPath]

      await user.click(screen.getByRole('button', { name: 'Back' }))
      await waitFor(() => expect(window.location.pathname).toBe(previousPath))
      await waitFor(() =>
        expect(routedTabButton(previousTab).getAttribute('aria-current')).toBe('page')
      )

      mounted.unmount()
      render(<App />)
      await screen.findAllByRole('button', { name: new RegExp(`^${previousTab}`) })
      expect(routedTabButton(previousTab).getAttribute('aria-current')).toBe('page')
      expect(window.location.pathname).toBe(previousPath)
    }
  )

  it.each([
    ['Sync', '/devices/not-a-tab', 'Devices', '/devices'],
    ['Entities', '/entities/not-a-tab', 'All', '/entities'],
    ['Models', '/models/image/extra', 'Text', '/models'],
    ['Notifications', '/notifications/approvals', 'All', '/notifications']
  ])(
    'recovers the invalid %s route to its default tab',
    async (_name, invalidPath, defaultTab, canonicalPath) => {
      const { registerProView } = await import('../bootstrap/proView')
      const { proView } = await import('../../../../pro/renderer/proView')
      registerProView(proView)
      installAppBoundary({
        isPro: true,
        getModelControlSnapshot: async () => modelControlSnapshot(),
        crmListEntities: async () => [],
        proInvoke: async (channel: string) => {
          if (channel === 'pro:sync:status') return undefined
          if (channel === 'pro:sync:prefs') return { prefs: null, categories: [] }
          if (channel === 'pro:sync:model-transfer-jobs') return []
          return undefined
        }
      })
      window.history.replaceState(null, '', invalidPath)

      render(<App />)

      await screen.findAllByRole('button', { name: new RegExp(`^${defaultTab}`) })
      expect(routedTabButton(defaultTab).getAttribute('aria-current')).toBe('page')
      await waitFor(() => expect(window.location.pathname).toBe(canonicalPath))
    }
  )

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
    // No region assertion here. Releasing is owned by the surface that PAINTS, and this test has no
    // live browser session, so nothing ever claimed the region - there is nothing to give up. The
    // release-on-unmount contract is covered in WatchedBrowserPane's tests, which do have a session.

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
    let markConversationsLoaded: () => void = () => {}
    const conversationsLoaded = new Promise<void>((resolve) => {
      markConversationsLoaded = resolve
    })
    window.history.replaceState(null, '', '/chat')
    installAppBoundary({
      isPro: true,
      getRagConversations: async () => {
        markConversationsLoaded()
        return [
          { id: 'chat-web-start', title: 'Web start', updated_at: '2026-08-25T00:00:00.000Z' }
        ]
      },
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

    await conversationsLoaded
    await act(async () => Promise.resolve())
    expect(screen.getAllByText('Web start').length).toBeGreaterThan(0)
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

  it('pinned keeps the sidebar open after the pointer leaves; unpinning returns it to hover', async () => {
    localStorage.removeItem('sidebar_pinned')
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Projects' })
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
    await user.hover(navigation)
    expect(navigation.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Pin sidebar' }))
    await user.unhover(navigation)
    expect(navigation.getAttribute('aria-expanded')).toBe('true')
    expect(localStorage.getItem('sidebar_pinned')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Unpin sidebar' }))
    await user.unhover(navigation)
    await waitFor(() => expect(navigation.getAttribute('aria-expanded')).toBe('false'))
    expect(localStorage.getItem('sidebar_pinned')).toBe('false')
  })
})
