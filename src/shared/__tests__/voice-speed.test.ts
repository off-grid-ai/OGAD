import { expect, it } from 'vitest'
import { playbackSpeed } from '../voice-speed'

it('keeps a playback speed inside the Voice tab range, else uses normal speed', () => {
  expect(playbackSpeed(1.5)).toBe(1.5)
  expect(playbackSpeed(0.5)).toBe(0.5)
  expect(playbackSpeed(7)).toBe(1)
  expect(playbackSpeed('fast')).toBe(1)
})
