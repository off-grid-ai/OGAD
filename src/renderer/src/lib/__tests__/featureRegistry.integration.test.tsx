// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { useState, type ComponentType } from 'react'

import { registerFeature, useCoreFeatures } from '../../bootstrap/featureRegistry'

const Icon = (() => null) as ComponentType<{ className?: string }>

function FeatureShell(): React.ReactElement {
  const features = useCoreFeatures()
  const [route, setRoute] = useState<string | null>(null)
  const Screen = features.find((feature) => feature.route === route)?.component
  return (
    <div>
      <nav>
        {features.map((feature) => (
          <button key={feature.route} onClick={() => setRoute(feature.route)}>
            {feature.label}
          </button>
        ))}
      </nav>
      {Screen ? <Screen /> : null}
    </div>
  )
}

afterEach(() => cleanup())

describe('package feature composition', () => {
  it('reactively adds navigation and reaches the registered production screen', async () => {
    const user = userEvent.setup()
    render(<FeatureShell />)
    expect(screen.queryByRole('button', { name: 'Sync' })).toBeNull()

    let unregister = (): void => {}
    act(() => {
      unregister = registerFeature({
        route: 'sync-integration',
        label: 'Sync',
        icon: Icon,
        component: () => <main>Connected devices</main>
      })
    })

    await user.click(screen.getByRole('button', { name: 'Sync' }))
    expect(screen.getByRole('main').textContent).toBe('Connected devices')

    act(() => unregister())
    expect(screen.queryByRole('button', { name: 'Sync' })).toBeNull()
    expect(screen.queryByRole('main')).toBeNull()
  })
})
