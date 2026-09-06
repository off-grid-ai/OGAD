import { describe, expect, it } from 'vitest'
import { nextZoomLevel, zoomIntentForInput } from '../window-zoom'

const key = (
  key: string,
  extra: Partial<Parameters<typeof zoomIntentForInput>[0]> = {}
): Parameters<typeof zoomIntentForInput>[0] => ({
  type: 'keyDown' as const,
  key,
  meta: true,
  control: false,
  alt: false,
  ...extra
})

describe('window zoom shortcuts', () => {
  it('maps Cmd/Ctrl with = + - _ 0 to zoom intents and ignores everything else', () => {
    expect(zoomIntentForInput(key('='))).toBe('in')
    expect(zoomIntentForInput(key('+'))).toBe('in')
    expect(zoomIntentForInput(key('-'))).toBe('out')
    expect(zoomIntentForInput(key('_', { meta: false, control: true }))).toBe('out')
    expect(zoomIntentForInput(key('0'))).toBe('reset')
    expect(zoomIntentForInput(key('=', { meta: false }))).toBeNull()
    expect(zoomIntentForInput(key('=', { alt: true }))).toBeNull()
    expect(zoomIntentForInput(key('=', { type: 'keyUp' as never }))).toBeNull()
    expect(zoomIntentForInput(key('a'))).toBeNull()
    // The physical key wins when the layout reports another character for it.
    expect(zoomIntentForInput(key('−', { code: 'Minus' } as never))).toBe('out')
    expect(zoomIntentForInput(key('*', { code: 'NumpadAdd' } as never))).toBe('in')
  })

  it('steps by half a level within bounds and resets to zero', () => {
    expect(nextZoomLevel(0, 'in')).toBe(0.5)
    expect(nextZoomLevel(0.5, 'out')).toBe(0)
    expect(nextZoomLevel(5, 'in')).toBe(5)
    expect(nextZoomLevel(-3, 'out')).toBe(-3)
    expect(nextZoomLevel(2.5, 'reset')).toBe(0)
  })
})
