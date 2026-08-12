// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { SettingsCard, SettingsCardsGroup } from '../SettingsCard'

describe('SettingsCardsGroup — grid drills into one L2 detail', () => {
  afterEach(cleanup)

  it('opens one card as the detail and hides the others; header goes back', async () => {
    render(
      <SettingsCardsGroup>
        <SettingsCard title="Setup & health" summary="s1">
          <div>SETUP_BODY</div>
        </SettingsCard>
        <SettingsCard title="Data & privacy" summary="s2">
          <div>PRIVACY_BODY</div>
        </SettingsCard>
      </SettingsCardsGroup>
    )
    // Grid: both cards, no bodies.
    expect(screen.getByText('Setup & health')).toBeTruthy()
    expect(screen.getByText('Data & privacy')).toBeTruthy()
    expect(screen.queryByText('SETUP_BODY')).toBeNull()

    // Open one → its body shows, back affordance appears. The other card doesn't POP
    // out — it exit-animates (fade + blur, popLayout) and is removed once the exit
    // transition finishes, so drilling in feels finished rather than abrupt.
    fireEvent.click(screen.getByText('Setup & health'))
    expect(screen.getByText('SETUP_BODY')).toBeTruthy()
    expect(screen.getByText('All settings')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('Data & privacy')).toBeNull())

    // Click the open header again → back to the grid (body exit-animates out).
    fireEvent.click(screen.getByText('Setup & health'))
    expect(screen.getByText('Data & privacy')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('SETUP_BODY')).toBeNull())
  })

  it('without a group, each card keeps independent local open state', () => {
    render(
      <>
        <SettingsCard title="Alpha" summary="a">
          <div>ALPHA_BODY</div>
        </SettingsCard>
        <SettingsCard title="Beta" summary="b">
          <div>BETA_BODY</div>
        </SettingsCard>
      </>
    )
    fireEvent.click(screen.getByText('Alpha'))
    expect(screen.getByText('ALPHA_BODY')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy() // not hidden — no group
  })

  it('opens a requested detail on mount for programmatic navigation', () => {
    render(
      <SettingsCardsGroup initialOpenId="Setup & health">
        <SettingsCard title="Setup & health" summary="setup">
          <div>SYSTEM_PERMISSIONS</div>
        </SettingsCard>
        <SettingsCard title="Capture & processing" summary="capture">
          <div>CAPTURE_BODY</div>
        </SettingsCard>
      </SettingsCardsGroup>
    )

    expect(screen.getByText('SYSTEM_PERMISSIONS')).toBeTruthy()
    expect(screen.queryByText('Capture & processing')).toBeNull()
  })

  it('reports controlled detail changes to the navigation owner', async () => {
    const onOpenIdChange = vi.fn()
    render(
      <SettingsCardsGroup openId="Capture & processing" onOpenIdChange={onOpenIdChange}>
        <SettingsCard title="Capture & processing" summary="capture">
          <div>CAPTURE_BODY</div>
        </SettingsCard>
        <SettingsCard title="Data & privacy" summary="privacy">
          <div>PRIVACY_BODY</div>
        </SettingsCard>
      </SettingsCardsGroup>
    )

    await waitFor(() => expect(screen.queryByText('Data & privacy')).toBeNull())

    fireEvent.click(screen.getByText('Capture & processing'))
    expect(onOpenIdChange).toHaveBeenCalledWith(null)
  })
})
