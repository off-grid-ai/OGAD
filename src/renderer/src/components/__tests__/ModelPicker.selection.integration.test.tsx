// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelPicker } from '../ModelPicker'
import { useActiveModelSummary } from '../../hooks/useActiveModelSummary'

// The Electron bridge is an external boundary. This fake stores selections through
// the same activation contract and keeps independent voice and text selections.
function bridge(failure?: string): {
  getModelCatalog(): Promise<{
    models: { id: string; name: string; kind: string; remoteServerId?: string }[]
  }>
  getInstalledModels(): Promise<string[]>
  getActiveModel(): Promise<string>
  getActiveModelIds(): Promise<string[]>
  getActiveModalities(): Promise<{ speech: string; remote_voice: boolean }>
  getLlmSettings(): Promise<{ ctxSize: number }>
  activateModel(id: string): Promise<{ success: boolean; error?: string }>
} {
  const models = [
    { id: 'old', name: 'Previous chat', kind: 'text' },
    { id: 'qwen', name: 'Qwen 3.5 9B', kind: 'text' },
    { id: 'tts', name: 'Qwen Audio TTS', kind: 'voice', remoteServerId: 'server' }
  ]
  let text = 'old'
  return {
    getModelCatalog: async () => ({ models }),
    getInstalledModels: async () => models.map((model) => model.id),
    getActiveModel: async () => text,
    getActiveModelIds: async () => [text, 'tts'],
    getActiveModalities: async () => ({ speech: 'tts', remote_voice: true }),
    getLlmSettings: async () => ({ ctxSize: 8192 }),
    activateModel: async (id: string) => {
      if (failure) return { success: false, error: failure }
      text = id
      return { success: true }
    }
  }
}

function Summary(): React.ReactElement {
  const summary = useActiveModelSummary(false)
  return <output aria-label="Current text model">{summary.name}</output>
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('model selection with remote voice active', () => {
  it('shows the local selection and updates the text summary while the picker stays open', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: bridge() })
    const user = userEvent.setup()
    render(
      <>
        <Summary />
        <ModelPicker onClose={() => {}} />
      </>
    )
    const textCard = (): HTMLElement => screen.getByLabelText('Text & Vision active model')
    await waitFor(() => expect(textCard().textContent).toContain('Previous chat'))
    await user.click(screen.getByRole('combobox', { name: 'Text & Vision model' }))
    await user.click(await screen.findByRole('option', { name: 'Qwen 3.5 9B' }))
    await waitFor(() => {
      expect(textCard().textContent).toContain('Qwen 3.5 9B')
      expect(screen.getByLabelText('Current text model').textContent).toBe('Qwen 3.5 9B')
    })
    expect(textCard().textContent).not.toContain('Previous chat')
    // The remote voice selection is untouched by the text switch.
    expect(screen.getByLabelText('Voice active model').textContent).toContain('Qwen Audio TTS')
    expect(screen.getByRole('dialog', { name: 'Active models' })).toBeTruthy()
  })

  it('shows a rejected selection and keeps the previous selection', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: bridge('Model file is not available.')
    })
    const user = userEvent.setup()
    render(<ModelPicker onClose={() => {}} />)
    await user.click(await screen.findByRole('combobox', { name: 'Text & Vision model' }))
    await user.click(await screen.findByRole('option', { name: 'Qwen 3.5 9B' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Model file is not available.')
    expect(screen.getByLabelText('Text & Vision active model').textContent).toContain(
      'Previous chat'
    )
  })
})
