// @vitest-environment jsdom

/**
 * Local Network recovery through the rendered Pro setup journey. macOS owns the permission and
 * System Settings; the Electron preload is the only controlled boundary.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PermissionGate } from '../PermissionGate'
import { closeTaskWorkspace, openTaskSidePanel } from '../../lib/task-side-panel'

let openLocalNetworkSettings: ReturnType<typeof vi.fn>
let requestScreenRecordingPermission: ReturnType<typeof vi.fn>
let openScreenRecordingSettings: ReturnType<typeof vi.fn>
let relaunchForPermissions: ReturnType<typeof vi.fn>
let permissionStatus: {
  accessibility: boolean
  screenRecording: boolean
  localNetwork: boolean
  allGranted: boolean
}

beforeEach(() => {
  openLocalNetworkSettings = vi.fn(async () => true)
  requestScreenRecordingPermission = vi.fn(async () => false)
  openScreenRecordingSettings = vi.fn(async () => true)
  relaunchForPermissions = vi.fn(async () => true)
  permissionStatus = {
    accessibility: true,
    screenRecording: true,
    localNetwork: false,
    allGranted: false
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      isPro: true,
      getPermissionStatus: async () => permissionStatus,
      checkModelStatus: async () => ({ downloaded: true, modelsDir: '/tmp/models' }),
      getActiveModel: async () => null,
      getModelVisionStatus: async () => ({}),
      proInvoke: async (channel: string) =>
        channel === 'capture:status' ? { running: false, paused: false, visionReady: true } : null,
      proOn: () => () => {},
      onModelProgress: () => () => {},
      openLocalNetworkSettings,
      requestScreenRecordingPermission,
      openScreenRecordingSettings,
      relaunchForPermissions,
      setupPlan: async () => null,
      getLlmSettings: async () => ({ performanceMode: 'balanced' })
    }
  })
})

afterEach(() => {
  closeTaskWorkspace()
  cleanup()
})

describe('<PermissionGate/> Local Network recovery', () => {
  it('keeps the setup nudge inside Chat when the Task workspace is open', async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
      if (this.getAttribute('data-testid') === 'task-side-panel') {
        return { left: 900, right: 1200, top: 0, bottom: 800, width: 300, height: 800 } as DOMRect
      }
      return originalRect.call(this)
    }
    openTaskSidePanel()
    try {
      render(
        <PermissionGate>
          <div data-testid="task-side-panel">Task workspace</div>
        </PermissionGate>
      )
      const title = await screen.findByText('Allow Local Network access')
      const nudge = title.closest('.fixed') as HTMLElement
      await waitFor(() => expect(nudge.style.right).toBe(`${window.innerWidth - 900 + 16}px`))
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })

  it('keeps the app usable and routes the setup action to macOS Local Network settings', async () => {
    const user = userEvent.setup()
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    expect(await screen.findByText('App shell')).toBeTruthy()
    expect(await screen.findByText('Allow Local Network access')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Set up' }))

    expect(await screen.findByRole('heading', { name: 'Local Network' })).toBeTruthy()
    expect(
      screen.getByText('Find and sync directly with your devices on this network.')
    ).toBeTruthy()
    expect(
      screen.getByText(
        'Enable Off Grid AI Desktop. Development builds appear as Electron. If it is already on but still reads denied, toggle it off and on once.'
      )
    ).toBeTruthy()

    await user.click(
      screen.getByRole('button', { name: 'Open Privacy & Security for Local Network access' })
    )
    expect(openLocalNetworkSettings).toHaveBeenCalledOnce()
  })

  it('requests Screen Recording only after the setup action and offers one relaunch after grant', async () => {
    permissionStatus = {
      accessibility: true,
      screenRecording: false,
      localNetwork: true,
      allGranted: false
    }
    const user = userEvent.setup()
    render(
      <PermissionGate>
        <div>App shell</div>
      </PermissionGate>
    )

    expect(await screen.findByText('App shell')).toBeTruthy()
    expect(requestScreenRecordingPermission).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Set up' }))
    expect(await screen.findByRole('heading', { name: 'Screen Recording' })).toBeTruthy()
    expect(requestScreenRecordingPermission).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Enable Screen Recording' }))
    expect(requestScreenRecordingPermission).toHaveBeenCalledOnce()
    expect(openScreenRecordingSettings).toHaveBeenCalledOnce()
    expect(await screen.findByText('Restart required')).toBeTruthy()
    expect(
      screen.getByText('Relaunch once to apply the access selected in System Settings.')
    ).toBeTruthy()

    await user.click(
      screen.getByRole('button', {
        name: 'Relaunch Off Grid AI Desktop for Screen Recording'
      })
    )
    expect(relaunchForPermissions).toHaveBeenCalledOnce()
  })
})
