// @vitest-environment jsdom
//
// RELEASE_TEST_CHECKLIST #50 and #59 - desktop navigation and project-layout
// integration coverage.
//
// The real App shell and Projects screen are mounted. Electron, model health,
// and native event subscriptions are the only boundary fakes. Navigation is
// reached through real clicks and KeyboardEvents, and assertions stay on the
// rendered view and selected project.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
    rendererActivation.load.mockResolvedValue(undefined)
    installAppStorage().setItem('onboarding_completed', 'true')
    window.history.replaceState(null, '', '/projects')
    installAppBoundary()
    installAppBrowserBoundary()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
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
      // By role and name, not by title: the sidebar starts expanded, and the title attribute is the
      // COLLAPSED-rail affordance only (App.tsx sets title={!sidebarOpen ? item.label : undefined}), so
      // the expanded nav carries its label as visible text instead.
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
})
