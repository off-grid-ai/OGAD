// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceBubble } from '../VoiceBubble'

afterEach(cleanup)

beforeEach(() => {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    speechCommands: { onEvent: vi.fn(() => () => undefined) }
  }
})

const synthesize = vi.fn(async () => ({ dataUrl: 'data:audio/wav;base64,AAAA' }))

describe('VoiceBubble while the reply streams', () => {
  it('holds a still placeholder instead of a second animated loader', () => {
    const { container } = render(
      <VoiceBubble messageId="a1" transcript="" isLoading synthesize={synthesize} />
    )
    expect(screen.getByTestId('voice-waveform-pending')).toBeTruthy()
    expect(container.querySelectorAll('.animate-bounce').length).toBe(0)
  })

  it('shows the waveform once the reply is complete', () => {
    render(<VoiceBubble messageId="a1" transcript="Hello there" synthesize={synthesize} />)
    expect(screen.queryByTestId('voice-waveform-pending')).toBeNull()
    expect(screen.getByRole('button', { name: /play/i })).toBeTruthy()
  })
})
