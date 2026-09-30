import type { Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { installMediaPermissionHandler } from '../media-permission'

vi.mock('electron', () => ({ app: { getAppPath: () => '/app' } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

type PermissionHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>

describe('renderer media permission admission', () => {
  it('registers once, admits media, and rejects unrelated renderer permissions (#15)', () => {
    let handler: PermissionHandler | null = null
    const setPermissionRequestHandler = (next: PermissionHandler | null): void => {
      handler = next
    }
    installMediaPermissionHandler({ setPermissionRequestHandler } as Pick<
      Session,
      'setPermissionRequestHandler'
    >)

    if (!handler) throw new Error('Permission handler was not registered')

    const decision = (permission: Parameters<PermissionHandler>[1]): boolean => {
      let granted = false
      handler!({} as never, permission, (value) => (granted = value), {} as never)
      return granted
    }
    expect(decision('media')).toBe(true)
    expect(decision('notifications')).toBe(false)
    expect(decision('geolocation')).toBe(false)
    expect(decision('openExternal')).toBe(false)
  })
})
