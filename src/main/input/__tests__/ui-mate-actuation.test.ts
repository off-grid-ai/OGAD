import { describe, expect, it } from 'vitest'
import { adaptNutActuation, type NutApi } from '../actuation'

class FakePoint {
  constructor(
    readonly x: number,
    readonly y: number
  ) {}
}

function fakeNut(): { nut: NutApi; calls: string[] } {
  const calls: string[] = []
  const record =
    (name: string): ((...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]) => {
      calls.push(`${name}:${JSON.stringify(args)}`)
    }
  return {
    calls,
    nut: {
      mouse: {
        setPosition: record('move'),
        leftClick: record('leftClick'),
        rightClick: record('rightClick'),
        click: record('click'),
        doubleClick: record('doubleClick'),
        drag: record('drag'),
        scrollUp: record('scrollUp'),
        scrollDown: record('scrollDown'),
        scrollLeft: record('scrollLeft'),
        scrollRight: record('scrollRight')
      },
      keyboard: {
        type: record('type'),
        pressKey: record('pressKey'),
        releaseKey: record('releaseKey')
      },
      Point: FakePoint,
      Button: { LEFT: 1, RIGHT: 2, MIDDLE: 3 },
      Key: { A: 10, B: 11, F12: 12, LeftShift: 13 }
    }
  }
}

describe('UI-Mate nut.js actuation contract', () => {
  it('uses native middle, triple, current-cursor drag, key, and signed scroll primitives', async () => {
    const { nut, calls } = fakeNut()
    const port = adaptNutActuation(nut)

    await port.click('middle', 1)
    await port.click('left', 3)
    await port.dragTo(50, 70)
    await port.pressKeys(['a', 'f12'])
    await port.keyDown(['shift', 'b'])
    await port.keyUp(['shift', 'b'])
    await port.scrollBy('vertical', -240)
    await port.scrollBy('horizontal', 120)

    expect(calls).toEqual([
      'click:[3]',
      'click:[1]',
      'click:[1]',
      'click:[1]',
      'drag:[[{' + '"x":50,"y":70' + '}]]',
      'pressKey:[10]',
      'releaseKey:[10]',
      'pressKey:[12]',
      'releaseKey:[12]',
      'pressKey:[13,11]',
      'releaseKey:[11,13]',
      'scrollDown:[2]',
      'scrollRight:[1]'
    ])
  })

  it('maps the complete pointer, text, hotkey, and directional scroll journey', async () => {
    const { nut, calls } = fakeNut()
    const port = adaptNutActuation(nut)

    await port.moveMouse(320, 180)
    await port.click('left', 1)
    await port.click('right', 2)
    await port.typeText('Release 107 is ready')
    await port.tapKeys('shift+b')
    await port.scroll('up')
    await port.scroll('down')
    await port.scroll('left')
    await port.scroll('right')
    await port.scrollBy('vertical', 121)
    await port.scrollBy('horizontal', -121)
    await port.scrollBy('vertical', 0)

    expect(calls).toEqual([
      'move:[{"x":320,"y":180}]',
      'click:[1]',
      'doubleClick:[2]',
      'type:["Release 107 is ready"]',
      'pressKey:[13,11]',
      'releaseKey:[13,11]',
      'scrollUp:[3]',
      'scrollDown:[3]',
      'scrollLeft:[3]',
      'scrollRight:[3]',
      'scrollUp:[2]',
      'scrollLeft:[2]'
    ])
  })

  it('refuses unknown or partially mapped keys before native input', async () => {
    const { nut, calls } = fakeNut()
    const port = adaptNutActuation(nut)

    await port.tapKeys('shift+unknown')
    await port.tapKeys('not a hotkey')
    await expect(port.pressKeys(['unknown'])).rejects.toThrow('Unsupported key: unknown')
    await expect(port.keyDown(['shift', 'unknown'])).rejects.toThrow('Unsupported key: unknown')
    await expect(port.keyUp(['unknown'])).rejects.toThrow('Unsupported key: unknown')

    expect(calls).toEqual([])
  })
})
