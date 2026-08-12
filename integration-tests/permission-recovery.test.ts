// @vitest-environment jsdom

/**
 * RELEASE_TEST_CHECKLIST #16 - denied capture permissions recover through the real
 * permission owner and rendered setup surface. Only macOS TCC, Electron transport,
 * and opening System Settings are controlled boundaries.
 */
import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  accessibility: false,
  screenRecording: 'denied' as 'denied' | 'granted',
  accessibilityChecks: [] as boolean[],
  screenRequests: 0,
  openedSettings: [] as string[]
}))

vi.mock('electron', () => ({
  systemPreferences: {
    isTrustedAccessibilityClient: (prompt: boolean) => {
      boundary.accessibilityChecks.push(prompt)
      return boundary.accessibility
    },
    getMediaAccessStatus: () => boundary.screenRecording
  },
  shell: {
    openExternal: (url: string) => {
      boundary.openedSettings.push(url)
      return Promise.resolve()
    }
  },
  desktopCapturer: {
    getSources: async () => {
      boundary.screenRequests++
      return []
    }
  }
}))

vi.mock('node:dgram', () => ({
  default: {
    createSocket: () => ({
      once: () => undefined,
      send: (
        _message: Buffer,
        _port: number,
        _host: string,
        callback: (error: Error | null) => void
      ) => callback(null),
      close: () => undefined
    })
  }
}))

const realPlatform = process.platform
Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })

const permissions = await import('@offgrid/core/main/permissions')

function installApi(): void {
  const values: Record<string, unknown> = {
    isPro: true,
    platform: 'darwin',
    getPermissionStatus: async () => permissions.getPermissionStatus(),
    openAccessibilitySettings: async () => {
      permissions.openAccessibilitySettings()
      return true
    },
    openScreenRecordingSettings: async () => {
      permissions.openScreenRecordingSettings()
      return true
    },
    openMicrophoneSettings: async () => {
      permissions.openMicrophoneSettings()
      return true
    },
    checkModelStatus: async () => ({ downloaded: true, modelsDir: '/synthetic/models' }),
    getLlmSettings: async () => ({ performanceMode: 'balanced' }),
    setupPlan: async () => ({
      mode: 'balanced',
      ramGb: 16,
      items: [],
      totalDownloadGb: 0
    }),
    onSetupProgress: () => () => undefined,
    getActiveModel: async () => 'synthetic/vision-model',
    getModelVisionStatus: async () => ({
      'synthetic/vision-model': { supportsVision: true, projectorInstalled: true }
    }),
    proInvoke: async (channel: string) => {
      if (channel === 'capture:status') {
        return { running: true, paused: false, visionReady: true }
      }
      return undefined
    },
    onModelProgress: () => () => undefined
  }
  const api = new Proxy(values, {
    get(target, property: string) {
      if (property in target) return target[property]
      return async () => undefined
    }
  })
  Object.assign(window, { api })
}

installApi()
const { PermissionGate } = await import('@renderer/components/PermissionGate')

function permissionCard(title: string): HTMLElement {
  return screen.getByRole('status', { name: `${title} permission` })
}

beforeEach(() => {
  boundary.accessibility = false
  boundary.screenRecording = 'denied'
  boundary.accessibilityChecks.length = 0
  boundary.screenRequests = 0
  boundary.openedSettings.length = 0
  installApi()
})

afterEach(() => cleanup())

afterAll(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: realPlatform })
})

describe('capture permission recovery', () => {
  it('routes a denied microphone feature to the exact macOS Settings pane (#16)', async () => {
    await window.api.openMicrophoneSettings()

    expect(boundary.openedSettings).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    ])
  })

  it('requests TCC explicitly once while repeated health checks stay non-prompting (#15)', async () => {
    expect(permissions.requestAccessibilityPermission()).toBe(false)
    await expect(permissions.requestScreenRecordingPermission()).resolves.toBe(false)
    expect(boundary.accessibilityChecks).toEqual([true])
    expect(boundary.screenRequests).toBe(1)

    expect((await permissions.getPermissionStatus()).allGranted).toBe(false)
    expect((await permissions.getPermissionStatus()).allGranted).toBe(false)
    expect(boundary.accessibilityChecks).toEqual([true, false, false])

    boundary.accessibility = true
    boundary.screenRecording = 'granted'
    await expect(permissions.getPermissionStatus()).resolves.toEqual({
      accessibility: true,
      screenRecording: true,
      localNetwork: true,
      allGranted: true
    })
    expect(boundary.accessibilityChecks.at(-1)).toBe(false)
    expect(boundary.screenRequests).toBe(1)
  })

  it('stays honest after a partial grant and becomes ready after rechecking both permissions (#16)', async () => {
    const user = userEvent.setup()
    render(
      React.createElement(
        PermissionGate,
        null,
        React.createElement('main', null, 'Application workspace')
      )
    )

    expect(await screen.findByText('Application workspace')).not.toBeNull()
    expect(await screen.findByText('Finish setting up capture')).not.toBeNull()

    await user.click(screen.getByRole('button', { name: 'Set up' }))
    const accessibilityCard = permissionCard('Accessibility')
    const screenRecordingCard = permissionCard('Screen Recording')
    expect(
      within(accessibilityCard).getByRole('button', { name: 'Open Accessibility settings' })
    ).not.toBeNull()
    // 'Enable Screen Recording', not 'Open ... settings': this card overrides the generic label because
    // its action is not always the same action. Once macOS reports the toggle changed, the very same
    // button becomes 'Relaunch Off Grid AI Desktop' - screen recording access only takes effect on a
    // fresh launch. Accessibility keeps the generic label because opening settings is all it ever does.
    expect(
      within(screenRecordingCard).getByRole('button', { name: 'Enable Screen Recording' })
    ).not.toBeNull()

    await user.click(
      within(screenRecordingCard).getByRole('button', { name: 'Enable Screen Recording' })
    )
    expect(boundary.openedSettings).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    ])

    boundary.screenRecording = 'granted'
    await user.click(screen.getByRole('button', { name: 'Check permissions again' }))
    await waitFor(() =>
      expect(within(permissionCard('Screen Recording')).getByText('Granted')).not.toBeNull()
    )
    expect(
      within(permissionCard('Accessibility')).getByRole('button', {
        name: 'Open Accessibility settings'
      })
    ).not.toBeNull()
    await expect(permissions.getPermissionStatus()).resolves.toEqual({
      accessibility: false,
      screenRecording: true,
      localNetwork: true,
      allGranted: false
    })

    await user.click(
      within(permissionCard('Accessibility')).getByRole('button', {
        name: 'Open Accessibility settings'
      })
    )
    expect(boundary.openedSettings.at(-1)).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    )

    boundary.accessibility = true
    await user.click(screen.getByRole('button', { name: 'Check permissions again' }))

    await waitFor(() => expect(screen.queryByText('Capture permissions')).toBeNull())
    expect(screen.getByText('Application workspace')).not.toBeNull()
    expect(screen.queryByText('Finish setting up capture')).toBeNull()
    await expect(permissions.getPermissionStatus()).resolves.toEqual({
      accessibility: true,
      screenRecording: true,
      localNetwork: true,
      allGranted: true
    })
  })
})
