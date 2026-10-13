// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePermissionController } from '../use-permission-controller'

function PermissionStatusProbe(): React.ReactElement {
  const permissions = usePermissionController(false)
  return (
    <div>
      <button type="button" onClick={() => void permissions.check()}>
        Check access
      </button>
      {permissions.error && <p role="alert">{permissions.error}</p>}
      <span>{permissions.status?.allGranted ? 'Access ready' : 'Access unavailable'}</span>
    </div>
  )
}

describe('permission status recovery', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows a platform-neutral error and clears it after access status recovers', async () => {
    let unavailable = true
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getPermissionStatus: async () => {
          if (unavailable) throw new Error('status service unavailable')
          return { allGranted: true }
        }
      }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<PermissionStatusProbe />)

    await user.click(screen.getByRole('button', { name: 'Check access' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Permission status could not be checked. Retry to read the current access status.'
    )

    unavailable = false
    await user.click(screen.getByRole('button', { name: 'Check access' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText('Access ready')).toBeTruthy()
  })
})
