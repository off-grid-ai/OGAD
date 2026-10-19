// @vitest-environment jsdom
// A project's Artifacts tab lists what its chats made, not only the saved library, and the
// project list can be narrowed by name. Main is faked at the IPC line (window.api).

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { RendererEntitlementProvider } from '../../bootstrap/RendererEntitlementProvider'
import { installAppBoundary } from '../../__tests__/harness/app-boundary'

const project = (id: string, name: string): Record<string, unknown> => ({
  id,
  name,
  description: '',
  systemPrompt: '',
  includeMemory: false,
  updatedAt: '2026-10-17T00:00:00.000Z'
})

const SAVED_PAGE = '<!doctype html><html><head><title>Saved Orb</title></head></html>'

// The screen reads window.api once, when it is first imported, so one Main serves every test.
beforeAll(() => {
  installAppBoundary({
    listProjects: async () => [project('launch', 'Launch'), project('hiring', 'Hiring plan')],
    // The saved library has one page; the chat holds that same page and a diagram never saved.
    listArtifacts: async ({ projectId }: { projectId: string }) =>
      projectId === 'launch'
        ? [{ id: 'saved-1', kind: 'html', code: SAVED_PAGE, title: 'Saved Orb', created: 1 }]
        : [],
    getRagConversations: async (projectId: string) =>
      projectId === 'launch' ? [{ id: 'chat-1' }] : [],
    getRagMessages: async () => [
      { id: 1, role: 'user', content: 'Make a page', created_at: '2026-10-17 10:00:00' },
      {
        id: 2,
        role: 'assistant',
        content: `\`\`\`html\n${SAVED_PAGE}\n\`\`\``,
        created_at: '2026-10-17 10:01:00'
      },
      {
        id: 3,
        role: 'assistant',
        content: '```mermaid\n---\ntitle: Launch flow\n---\nflowchart LR\n  A --> B\n```',
        created_at: '2026-10-17 10:02:00'
      }
    ]
  })
})

afterEach(() => cleanup())

async function renderProjects(): Promise<void> {
  const { ProjectsScreen } = await import('../ProjectsScreen')
  render(
    <RendererEntitlementProvider>
      <ProjectsScreen onOpenChat={() => undefined} />
    </RendererEntitlementProvider>
  )
}

describe('<ProjectsScreen/> artifacts', () => {
  it("lists artifacts from the project's chats beside saved ones, each once", async () => {
    const user = userEvent.setup()
    await renderProjects()

    await user.click(await screen.findByRole('button', { name: 'Launch' }))
    await user.click(await screen.findByRole('radio', { name: /artifacts/i }))
    expect(await screen.findByText('2 artifacts')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Launch flow/ })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Saved Orb/ })).toHaveLength(1)
  })

  it('finds a project by name', async () => {
    const user = userEvent.setup()
    await renderProjects()

    const finder = await screen.findByRole('textbox', { name: 'Find a project' })
    expect(await screen.findByRole('button', { name: 'Launch' })).toBeTruthy()
    await user.type(finder, 'hir')
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Launch' })).toBeNull()
      expect(screen.getAllByText('Hiring plan').length).toBeGreaterThan(0)
    })
    // Escape clears the search and the whole list is back.
    await user.keyboard('{Escape}')
    expect(await screen.findByRole('button', { name: 'Launch' })).toBeTruthy()
  })
})
