// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { EmbeddingRebuildNotice } from '../EmbeddingRebuildNotice'
import type { EmbeddingRebuildStatus } from '../../../../shared/embedding-rebuild-contract'

afterEach(cleanup)
it('shows recovery without raw diagnostics, distinguishes failed restoration and permits dismissal', async () => {
  let publish!: (status: EmbeddingRebuildStatus) => void
  const status: EmbeddingRebuildStatus = {
    phase: 'error',
    model: 'Xenova/bge-small',
    done: 1,
    total: 2,
    error: 'SQLITE_CONSTRAINT: /private/profile/memories.db'
  }
  Object.assign(window, {
    api: {
      onEmbeddingRebuildStatusChanged: (listener: typeof publish) => {
        publish = listener
        return () => {}
      },
      getEmbeddingRebuildStatus: async () => status
    }
  })
  render(<EmbeddingRebuildNotice />)
  expect((await screen.findByRole('status')).textContent).toContain(
    'Previous model and index restored'
  )
  expect(screen.queryByText(/SQLITE_CONSTRAINT/)).toBeNull()
  await act(async () => {
    publish({ ...status, error: 'Could not restore the previous index: private database failure' })
  })
  expect(screen.getByRole('status').textContent).toContain('Restart the app to retry recovery')
  expect(screen.getByRole('status').textContent).not.toContain('Previous model and index restored')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByRole('status')).toBeNull()
})
