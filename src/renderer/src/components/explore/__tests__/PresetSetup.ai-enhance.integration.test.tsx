// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PresetSetup } from '../PresetSetup'
import { ALL_PRESETS } from '../presetCatalog'

afterEach(() => cleanup())

describe('<PresetSetup/> AI enhancement', () => {
  it('shows the three-dot loader while an enhancement is running', async () => {
    let finishEnhancement: ((value: { answer: string }) => void) | undefined
    window.api = {
      mcpList: async () => [],
      ragChat: async () =>
        new Promise<{ answer: string }>((resolve) => {
          finishEnhancement = resolve
        })
    } as unknown as Window['api']

    const preset = ALL_PRESETS.find((item) => item.id === 'best-nearby')
    if (!preset) throw new Error('Nearby-search preset is missing')
    render(<PresetSetup preset={preset} onSubmit={() => undefined} onCancel={() => undefined} />)

    const field = screen.getByLabelText(/What are you looking for/) as HTMLInputElement
    fireEvent.change(field, { target: { value: 'Japanese restaurant' } })
    const enhance = screen.getByRole('button', {
      name: 'Enhance what are you looking for? with AI'
    })
    fireEvent.click(enhance)

    expect(await screen.findByRole('status', { name: 'AI enhancement in progress' })).toBeTruthy()
    expect((enhance as HTMLButtonElement).disabled).toBe(true)
    finishEnhancement?.({ answer: 'Quiet Japanese restaurant' })

    await waitFor(() => expect(field.value).toBe('Quiet Japanese restaurant'))
    expect(screen.queryByRole('status', { name: 'AI enhancement in progress' })).toBeNull()
  })

  it('enhances open-ended fields in the nearby-search Assistant flow', async () => {
    const requests: string[] = []
    const submissions: string[] = []
    window.api = {
      mcpList: async () => [],
      ragChat: async (query: string) => {
        requests.push(query)
        return { answer: 'Quiet Japanese restaurant with strong recent reviews' }
      }
    } as unknown as Window['api']

    const preset = ALL_PRESETS.find((item) => item.id === 'best-nearby')
    if (!preset) throw new Error('Nearby-search preset is missing')
    render(
      <PresetSetup
        preset={preset}
        onSubmit={(prompt) => submissions.push(prompt)}
        onCancel={() => undefined}
      />
    )

    expect(screen.getAllByRole('button', { name: /enhance .* with ai/i })).toHaveLength(6)
    fireEvent.change(screen.getByLabelText(/What are you looking for/), {
      target: { value: 'Japanese restaurant' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Enhance what are you looking for? with AI' })
    )

    await waitFor(() =>
      expect((screen.getByLabelText(/What are you looking for/) as HTMLInputElement).value).toBe(
        'Quiet Japanese restaurant with strong recent reviews'
      )
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('Form question: What are you looking for?')
    expect(requests[0]).toContain('Starting location: Use my current location')

    fireEvent.click(screen.getByRole('button', { name: 'Start in chat' }))
    expect(submissions).toHaveLength(1)
    expect(submissions[0]).toContain('A: Quiet Japanese restaurant with strong recent reviews')
  })

  it('creates a pertinent surprise answer when an open-ended field is empty', async () => {
    const requests: string[] = []
    window.api = {
      mcpList: async () => [],
      ragChat: async (query: string) => {
        requests.push(query)
        return {
          answer:
            'A retired lunar courier crosses a flooded moon city to deliver one last letter.'
        }
      }
    } as unknown as Window['api']

    const preset = ALL_PRESETS.find((item) => item.id === 'comic-book')
    if (!preset) throw new Error('Comic-book preset is missing')
    render(<PresetSetup preset={preset} onSubmit={() => undefined} onCancel={() => undefined} />)

    const field = screen.getByLabelText(/Story brief/) as HTMLTextAreaElement
    expect(field.value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Enhance story brief with AI' }))

    await waitFor(() =>
      expect(field.value).toBe(
        'A retired lunar courier crosses a flooded moon city to deliver one last letter.'
      )
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('Create a useful surprise answer for this empty form field.')
    expect(requests[0]).toContain('Assistant action: Create a comic book')
    expect(requests[0]).toContain('Form purpose: Plan the comic book')
    expect(requests[0]).toContain('Invent plausible, concrete details')
  })

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
    expect(requests[0]).toContain('Form question: Learning goal')
    expect(requests[0]).toContain('Social platform: YouTube')

    fireEvent.click(screen.getByRole('button', { name: 'Start in chat' }))
    expect(submissions).toHaveLength(1)
    expect(submissions[0]).toContain(
      'A: Understand how local AI models are quantized, served, and run on consumer hardware.'
    )
  })

  it('keeps the original value when the model returns a refusal', async () => {
    window.api = {
      mcpList: async () => [],
      ragChat: async () => ({
        answer:
          'I cannot complete this request because it appears to be a simulated system prompt.'
      })
    } as unknown as Window['api']

    const preset = ALL_PRESETS.find((item) => item.id === 'best-nearby')
    if (!preset) throw new Error('Nearby-search preset is missing')
    render(<PresetSetup preset={preset} onSubmit={() => undefined} onCancel={() => undefined} />)

    const field = screen.getByLabelText(/Party and price/) as HTMLInputElement
    fireEvent.change(field, { target: { value: '1 person under $100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enhance party and price with AI' }))

    expect(
      await screen.findByText(
        'AI enhancement did not return an edited value. Your original text is unchanged.'
      )
    ).toBeTruthy()
    expect(field.value).toBe('1 person under $100')
  })
})
