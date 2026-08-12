import { useCallback, useEffect, useState } from 'react'
import type { PermissionStatusContract } from '../../../shared/ipc-contracts'

export interface PermissionController {
  status: PermissionStatusContract | null
  checking: boolean
  error: string | null
  screenRecordingRestartRequired: boolean
  check: () => Promise<boolean>
  openAccessibility: () => Promise<void>
  handleScreenRecording: () => Promise<void>
  openLocalNetwork: () => Promise<void>
}

/** One renderer owner for the permission status and native recovery actions used by setup and Settings. */
export function usePermissionController(enabled: boolean = true): PermissionController {
  const [status, setStatus] = useState<PermissionStatusContract | null>(null)
  const [checking, setChecking] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const [screenRecordingRestartRequired, setScreenRecordingRestartRequired] = useState(false)

  const check = useCallback(async (): Promise<boolean> => {
    setChecking(true)
    setError(null)
    try {
      const next = await window.api.getPermissionStatus()
      setStatus(next)
      return next.allGranted
    } catch (cause) {
      console.error('[permissions] status check failed', cause)
      setError('Permission status could not be checked. Retry to read the current macOS grants.')
      return false
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void check()
  }, [check, enabled])

  useEffect(() => {
    if (!enabled || screenRecordingRestartRequired || status?.allGranted) return
    const interval = window.setInterval(() => void check(), 2000)
    return () => window.clearInterval(interval)
  }, [check, enabled, screenRecordingRestartRequired, status?.allGranted])

  const openAccessibility = useCallback(async (): Promise<void> => {
    try {
      await window.api.openAccessibilitySettings()
    } catch (cause) {
      console.error('[permissions] accessibility settings failed to open', cause)
      setError('Accessibility settings could not be opened. Open Privacy & Security manually.')
    }
  }, [])

  const handleScreenRecording = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      if (screenRecordingRestartRequired) {
        await window.api.relaunchForPermissions()
        return
      }
      const granted = await window.api.requestScreenRecordingPermission()
      if (granted) {
        setScreenRecordingRestartRequired(false)
        await check()
        return
      }
      setScreenRecordingRestartRequired(true)
      await window.api.openScreenRecordingSettings()
    } catch (cause) {
      console.error('[permissions] screen recording action failed', cause)
      setError('Screen Recording settings could not be opened. Open Privacy & Security manually.')
    }
  }, [check, screenRecordingRestartRequired])

  const openLocalNetwork = useCallback(async (): Promise<void> => {
    try {
      await window.api.openLocalNetworkSettings()
    } catch (cause) {
      console.error('[permissions] local network settings failed to open', cause)
      setError('Local Network settings could not be opened. Open Privacy & Security manually.')
    }
  }, [])

  return {
    status,
    checking,
    error,
    screenRecordingRestartRequired,
    check,
    openAccessibility,
    handleScreenRecording,
    openLocalNetwork
  }
}
