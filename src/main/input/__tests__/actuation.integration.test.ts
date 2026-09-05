/**
 * Real Desktop actuation adapter over a controlled nut.js native boundary. Key parsing, refusal,
 * mouse-button routing, wheel conversion, and key release order all stay in production code.
 */
import { describe, expect, it } from 'vitest'
import { adaptNutActuation, type NutApi } from '../actuation'

describe('Desktop native actuation adapter', () => {
  it('translates the complete pointer, keyboard, and wheel contract without partial input', async () => {
    const operations: Array<{ name: string; values: unknown[] }> = []
    const record =
      (name: string) =>
      async (...values: unknown[]) => {
        operations.push({ name, values })
      }
    class Point {
      constructor(
        readonly x: number,
        readonly y: number
      ) {}
    }
    const nut: NutApi = {
      mouse: {
        setPosition: record('setPosition'),
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
      Point,
      Button: { LEFT: 1, RIGHT: 2, MIDDLE: 3 },
      Key: { LeftControl: 10, LeftShift: 11, C: 12, Enter: 13 }
    }
    const actuation = adaptNutActuation(nut)

    await actuation.moveMouse(120, 340)
    await actuation.click('left', 1)
    await actuation.click('right', 2)
    await actuation.click('middle', 3)
    await actuation.dragTo(400, 500)
    await actuation.typeText('private text')
    await actuation.tapKeys('ctrl c')
    const countBeforeRefusal = operations.length
    await actuation.tapKeys('ctrl unknown')
    expect(operations).toHaveLength(countBeforeRefusal)
    await actuation.pressKeys(['enter'])
    await actuation.keyDown(['ctrl', 'shift'])
    await actuation.keyUp(['ctrl', 'shift'])
    await actuation.scroll('up')
    await actuation.scroll('down')
    await actuation.scroll('left')
    await actuation.scroll('right')
    await actuation.scrollBy('horizontal', 241)
    await actuation.scrollBy('horizontal', -120)
    await actuation.scrollBy('vertical', 121)
    await actuation.scrollBy('vertical', -1)
    const countBeforeZero = operations.length
    await actuation.scrollBy('vertical', 0)
    expect(operations).toHaveLength(countBeforeZero)

    expect(operations).toEqual([
      { name: 'setPosition', values: [new Point(120, 340)] },
      { name: 'click', values: [1] },
      { name: 'doubleClick', values: [2] },
      { name: 'click', values: [3] },
      { name: 'click', values: [3] },
      { name: 'click', values: [3] },
      { name: 'drag', values: [[new Point(400, 500)]] },
      { name: 'type', values: ['private text'] },
      { name: 'pressKey', values: [10, 12] },
      { name: 'releaseKey', values: [10, 12] },
      { name: 'pressKey', values: [13] },
      { name: 'releaseKey', values: [13] },
      { name: 'pressKey', values: [10, 11] },
      { name: 'releaseKey', values: [11, 10] },
      { name: 'scrollUp', values: [3] },
      { name: 'scrollDown', values: [3] },
      { name: 'scrollLeft', values: [3] },
      { name: 'scrollRight', values: [3] },
      { name: 'scrollRight', values: [3] },
      { name: 'scrollLeft', values: [1] },
      { name: 'scrollUp', values: [2] },
      { name: 'scrollDown', values: [1] }
    ])
  })

  it('rejects unsupported single-key operations before native input is emitted', async () => {
    const unused = async (): Promise<void> => undefined
    const nut = {
      mouse: {
        setPosition: unused,
        leftClick: unused,
        rightClick: unused,
        click: unused,
        doubleClick: unused,
        drag: unused,
        scrollUp: unused,
        scrollDown: unused,
        scrollLeft: unused,
        scrollRight: unused
      },
      keyboard: { type: unused, pressKey: unused, releaseKey: unused },
      Point: class {},
      Button: { LEFT: 1, RIGHT: 2, MIDDLE: 3 },
      Key: {}
    } as unknown as NutApi
    const actuation = adaptNutActuation(nut)

    await expect(actuation.pressKeys(['unknown'])).rejects.toThrow('Unsupported key: unknown')
    await expect(actuation.keyDown(['enter'])).rejects.toThrow('Unsupported key: enter')
  })
})
