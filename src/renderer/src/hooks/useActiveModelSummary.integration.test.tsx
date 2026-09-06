// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { modelControlSnapshot } from '../components/__tests__/harness/model-control-snapshot'
import { useActiveModelSummary } from './useActiveModelSummary'

function SummaryProbe({ revision }: { revision: number }): React.JSX.Element {
  const summary = useActiveModelSummary(revision)
  return (
    <div>
      <output aria-label="status">{summary.status}</output>
      <output aria-label="name">{summary.name ?? ''}</output>
      <output aria-label="thinking">{summary.thinking === true ? 'supported' : ''}</output>
      <output aria-label="failure">{summary.failure?.code ?? ''}</output>
    </div>
  )
}

describe('useActiveModelSummary', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('clears the current projection and exposes a typed failure when refresh fails', async () => {
    const getModelControlProjection = vi.fn(async () =>
      modelControlSnapshot({
        kinds: ['text'],
        models: [
          {
            id: 'remote:openrouter:qwen',
            name: 'Qwen Remote',
            kind: 'text',
            remoteServerId: 'openrouter',
            files: [],
            capabilities: { thinking: true }
          }
        ],
        activeIds: ['remote:openrouter:qwen'],
        active: { text: 'remote:openrouter:qwen' }
      })
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getModelControlProjection,
        getLlmSettings: vi.fn(async () => ({}))
      }
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const view = render(<SummaryProbe revision={0} />)
    await waitFor(() => expect(screen.getByLabelText('status').textContent).toBe('ready'))
    expect(screen.getByLabelText('name').textContent).toBe('Qwen Remote')
    expect(screen.getByLabelText('thinking').textContent).toBe('supported')

    getModelControlProjection.mockRejectedValueOnce(new Error('snapshot unavailable'))
    view.rerender(<SummaryProbe revision={1} />)

    await waitFor(() => expect(screen.getByLabelText('status').textContent).toBe('failed'))
    expect(screen.getByLabelText('name').textContent).toBe('')
    expect(screen.getByLabelText('thinking').textContent).toBe('')
    expect(screen.getByLabelText('failure').textContent).toBe('model_control_projection_failed')
    expect(console.error).toHaveBeenCalledWith(
      '[ModelControl] Active model summary projection failed.',
      expect.any(Error)
    )
  })
})
