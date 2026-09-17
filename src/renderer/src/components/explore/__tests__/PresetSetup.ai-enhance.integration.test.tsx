// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PresetSetup } from '../PresetSetup'
import { ALL_PRESETS } from '../presetCatalog'

afterEach(() => cleanup())

describe('<PresetSetup/> AI enhancement', () => {
  it('enhances a Train My Feed field and submits the improved value', async () => {
    const requests: string[] = []
    const submissions: string[] = []
    window.api = {
      mcpList: async () => [],
      ragChat: async (query: string) => {
        requests.push(query)
        return {
          answer:
            'Understand how local AI models are quantized, served, and run on consumer hardware.'
        }
      }
    } as unknown as Window['api']

    const preset = ALL_PRESETS.find((item) => item.id === 'train-my-feed')
    if (!preset) throw new Error('Train My Feed preset is missing')
    render(
      <PresetSetup
        preset={preset}
        onSubmit={(prompt) => submissions.push(prompt)}
        onCancel={() => undefined}
      />
    )

    expect(screen.getAllByRole('button', { name: /enhance .* with ai/i })).toHaveLength(3)
    fireEvent.change(screen.getByLabelText(/Social platform/), {
      target: { value: 'YouTube' }
    })
    fireEvent.change(screen.getByLabelText(/Learning goal/), {
      target: { value: 'Local AI models' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enhance learning goal with AI' }))

    await waitFor(() =>
      expect((screen.getByLabelText(/Learning goal/) as HTMLTextAreaElement).value).toBe(
        'Understand how local AI models are quantized, served, and run on consumer hardware.'
      )
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('Field: Learning goal')
    expect(requests[0]).toContain('Social platform: YouTube')

    fireEvent.click(screen.getByRole('button', { name: 'Start in chat' }))
    expect(submissions).toHaveLength(1)
    expect(submissions[0]).toContain(
      'A: Understand how local AI models are quantized, served, and run on consumer hardware.'
    )
  })
})
