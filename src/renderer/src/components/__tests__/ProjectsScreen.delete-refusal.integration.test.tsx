// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RendererEntitlementProvider } from '../../bootstrap/RendererEntitlementProvider'
import { installAppBoundary } from '../../__tests__/harness/app-boundary'

const project = {
  id: 'protected-project',
  name: 'Protected project',
  description: '',
  systemPrompt: '',
  includeMemory: false,
  updatedAt: '2026-09-11T00:00:00.000Z'
}

describe('<ProjectsScreen/> delete refusal', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps the selected project and shows the cleanup reason', async () => {
    installAppBoundary({
      listProjects: async () => [project],
      deleteProject: async () => ({
        ok: false,
        reason: 'Knowledge cleanup did not finish.'
      })
    })
    const user = userEvent.setup()
    const { ProjectsScreen } = await import('../ProjectsScreen')

    render(
      <RendererEntitlementProvider>
        <ProjectsScreen onOpenChat={() => undefined} />
      </RendererEntitlementProvider>
    )

    expect((await screen.findAllByText(project.name)).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: /knowledge & settings/i }))
    await user.click(screen.getByTitle('Delete project'))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Knowledge cleanup did not finish.'
    )
    await waitFor(() => expect(screen.getAllByText(project.name).length).toBeGreaterThan(0))
  })
})
