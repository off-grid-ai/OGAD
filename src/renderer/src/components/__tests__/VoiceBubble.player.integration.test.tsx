// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { VoiceBubble } from '../VoiceBubble'

/** The browser's audio output: jsdom has no media playback, so this stands in for the device. */
class AudioOutput {
  static played: AudioOutput[] = []
  paused = true
  playbackRate = 1
  currentTime = 0
  duration = 12
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly src: string) {}

  async play(): Promise<void> {
    this.paused = false
    AudioOutput.played.push(this)
  }

  pause(): void {
    this.paused = true
  }
}

const TRANSCRIPT = 'The build passed. Deploy went out at noon, and the logs look clean.'
const originalAudio = globalThis.Audio

afterEach(() => {
  cleanup()
  globalThis.Audio = originalAudio
  AudioOutput.played = []
})

function renderReply(props: Partial<React.ComponentProps<typeof VoiceBubble>> = {}): void {
  globalThis.Audio = AudioOutput as unknown as typeof Audio
  render(
    <VoiceBubble
      messageId="reply"
      transcript={TRANSCRIPT}
      durationSeconds={12}
      showTranscriptInitially
      synthesize={async () => ({ dataUrl: 'data:audio/wav;base64,AAAA' })}
      {...props}
    />
  )
}

function seekPosition(): number {
  return Number(
    screen.getByRole('slider', { name: 'Seek voice note' }).getAttribute('aria-valuenow')
  )
}

describe('<VoiceBubble/> player', () => {
  it('splits the transcript into phrases and seeks to the one that is clicked', async () => {
    const user = userEvent.setup()
    renderReply()

    expect(screen.getByText('Follow along')).toBeTruthy()
    const phrases = ['The build passed.', 'Deploy went out at noon,', 'and the logs look clean.']
    for (const phrase of phrases) expect(screen.getByRole('button', { name: phrase })).toBeTruthy()

    // "Deploy..." starts after "The build passed." - 17 of the 65 phrase characters, of 12 s.
    await user.click(screen.getByRole('button', { name: 'Deploy went out at noon,' }))
    expect(seekPosition()).toBe(Math.round((17 / 65) * 12))

    // Play starts the clip from the phrase, not from the top.
    await user.click(screen.getByRole('button', { name: 'Play voice note' }))
    await waitFor(() => expect(AudioOutput.played).toHaveLength(1))
    expect(AudioOutput.played[0]!.currentTime).toBeCloseTo((17 / 65) * 12)

    // While playing, a phrase moves the clip itself.
    await user.click(screen.getByRole('button', { name: 'and the logs look clean.' }))
    expect(AudioOutput.played[0]!.currentTime).toBeCloseTo((41 / 65) * 12)
  })

  it('gives emoji no time, because the voice does not read them aloud', async () => {
    const user = userEvent.setup()
    renderReply({
      transcript: 'The build passed 🎉🎉🎉. Deploy went out at noon, and the logs look clean. 👍'
    })

    // Timing follows the spoken words only, so the emoji do not push "Deploy..." later.
    await user.click(screen.getByRole('button', { name: 'Deploy went out at noon,' }))
    expect(seekPosition()).toBe(Math.round((17 / 65) * 12))
  })

  it('hides and shows the follow-along transcript with the captions toggle', async () => {
    const user = userEvent.setup()
    renderReply()

    expect(screen.getByRole('button', { name: 'The build passed.' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Hide transcript' }))
    await waitFor(() => expect(screen.queryByText('Follow along')).toBeNull())
    expect(screen.queryByRole('button', { name: 'The build passed.' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Show transcript' }))
    expect(await screen.findByText('Follow along')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'The build passed.' })).toBeTruthy()
  })

  it('keeps speed, copy and regenerate as labelled actions', async () => {
    const user = userEvent.setup()
    const copies: string[] = []
    let retried = 0
    renderReply({ onCopy: (text) => copies.push(text), onRetry: () => (retried += 1) })

    await user.click(screen.getByRole('button', { name: 'Playback speed 1x' }))
    expect(screen.getByRole('button', { name: 'Playback speed 1.25x' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Copy transcript' }))
    expect(copies).toEqual([TRANSCRIPT])
    await user.click(screen.getByRole('button', { name: 'Regenerate' }))
    expect(retried).toBe(1)
  })

  // jsdom has no layout, so the row is checked as the DOM the browser lays out: the play control,
  // the waveform, the time and the speed are siblings in one row, in that order.
  it('keeps play, waveform, time and speed in one row', () => {
    renderReply({ showTranscriptInitially: false })
    const play = screen.getByRole('button', { name: 'Play voice note' })
    const waveform = screen.getByRole('slider', { name: 'Seek voice note' })
    const speed = screen.getByRole('button', { name: 'Playback speed 1x' })
    const row = waveform.parentElement!
    expect(play.parentElement).toBe(row)
    expect(row.contains(speed)).toBe(true)
    const order = [play, waveform, speed].map((el) =>
      [...row.querySelectorAll('*')].indexOf(el as Element)
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})
