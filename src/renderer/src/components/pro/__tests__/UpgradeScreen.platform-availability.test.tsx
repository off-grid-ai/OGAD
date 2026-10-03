// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpgradeScreen } from '../UpgradeScreen'
import { getProFeature, PRO_FEATURES } from '../proCatalog'

const day = getProFeature('day')!

function renderOn(
  platform: string,
  variant: 'upgrade' | 'coming-soon' = 'upgrade',
  feature = day,
  proBuild = false
): void {
  vi.stubGlobal('__OFFGRID_PRO__', proBuild)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { platform, openExternal: vi.fn() }
  })
  render(<UpgradeScreen feature={feature} variant={variant} />)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Pro platform availability', () => {
  it.each(['darwin', 'win32', 'linux'])('shows Pro as live on %s', (platform) => {
    renderOn(platform)
    expect(screen.getByText(/Off Grid AI Pro · Available now/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Get Pro/ })).toBeTruthy()
    expect(screen.queryByText(/coming soon to Linux/i)).toBeNull()
  })

  it.each(PRO_FEATURES.map((feature) => [feature.route, feature] as const))(
    'offers %s on Linux',
    (_route, feature) => {
      renderOn('linux', 'upgrade', feature)
      expect(screen.getByText(/Off Grid AI Pro · Available now/)).toBeTruthy()
      expect(screen.getByRole('button', { name: /Get Pro/ })).toBeTruthy()
      expect(screen.queryByText(/coming soon to Linux/i)).toBeNull()
    }
  )

  it('offers Vault and license activation on Linux', () => {
    renderOn('linux', 'upgrade', getProFeature('vault')!, true)
    expect(screen.getByText(/Off Grid AI Pro · Available now/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Get Pro/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Activate/ })).toBeTruthy()
    expect(screen.queryByText(/coming soon to Linux/i)).toBeNull()
  })

  it('offers purchase and license activation on the general Linux upgrade screen', () => {
    vi.stubGlobal('__OFFGRID_PRO__', true)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { platform: 'linux', openExternal: vi.fn() }
    })
    render(<UpgradeScreen />)

    expect(screen.queryByText(/Some Pro features are coming soon to Linux/)).toBeNull()
    expect(screen.getByText(/Off Grid AI Pro · Available now/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Get Pro/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Activate/ })).toBeTruthy()
  })
})
