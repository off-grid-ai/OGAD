/**
 * The UI-TARS action parser: every shipped verb, the coordinate spellings the
 * model uses, denormalization from 0-1000 to real pixels, and fail-closed on
 * anything unrecognised or missing its point.
 */
import { describe, expect, it } from 'vitest'
import { parseVisionAction, type VisionAction } from '../vision-action'

const bounds = { width: 1000, height: 1000 } // 1:1 so normalized == pixels

describe('parseVisionAction - the shipped verbs', () => {
  const cases: Array<[string, VisionAction]> = [
    ["click(point='<point>500 400</point>')", { type: 'click', point: { x: 500, y: 400 } }],
    [
      "left_double(point='<point>100 100</point>')",
      { type: 'double_click', point: { x: 100, y: 100 } }
    ],
    [
      "right_single(point='<point>10 20</point>')",
      { type: 'right_click', point: { x: 10, y: 20 } }
    ],
    ["type(content='hello world')", { type: 'type', content: 'hello world' }],
    ["hotkey(key='ctrl c')", { type: 'hotkey', keys: 'ctrl c' }],
    ['wait()', { type: 'wait' }],
    ["finished(content='sent the file')", { type: 'finished', content: 'sent the file' }],
    [
      "call_user(content='need your password')",
      { type: 'call_user', content: 'need your password' }
    ]
  ]
  it.each(cases)('parses %s', (raw, expected) => {
    expect(parseVisionAction(raw, bounds)).toEqual(expected)
  })

  it('parses a drag with start and end boxes', () => {
    expect(parseVisionAction("drag(start_box='(100,100)', end_box='(800,800)')", bounds)).toEqual({
      type: 'drag',
      from: { x: 100, y: 100 },
      to: { x: 800, y: 800 }
    })
  })

  it('parses a scroll with a direction', () => {
    expect(
      parseVisionAction("scroll(point='<point>500 500</point>', direction='down')", bounds)
    ).toEqual({
      type: 'scroll',
      point: { x: 500, y: 500 },
      direction: 'down'
    })
  })
})

describe('coordinate handling', () => {
  it('denormalizes 0-1000 coordinates to the target pixel bounds', () => {
    const action = parseVisionAction("click(point='<point>500 250</point>')", {
      width: 1920,
      height: 1080
    })
    expect(action).toEqual({ type: 'click', point: { x: 960, y: 270 } })
  })

  it('clamps an out-of-range prediction onto the screen rather than off it', () => {
    const action = parseVisionAction("click(point='<point>1200 -50</point>')", {
      width: 800,
      height: 600
    })
    // 1200/1000*800 = 960 -> clamped to 799; -50 -> clamped to 0.
    expect(action).toEqual({ type: 'click', point: { x: 799, y: 0 } })
  })

  it('accepts the bare (x,y) spelling too', () => {
    expect(parseVisionAction("click(start_box='(300,700)')", bounds)).toEqual({
      type: 'click',
      point: { x: 300, y: 700 }
    })
  })
})

describe('a Thought prefix', () => {
  it('parses the Action: line after a chain of thought', () => {
    const raw =
      "Thought: I should click the Send button now.\nAction: click(point='<point>640 900</point>')"
    expect(parseVisionAction(raw, bounds)).toEqual({ type: 'click', point: { x: 640, y: 900 } })
  })
})

describe('content escaping', () => {
  it('unescapes newlines and quotes inside typed content', () => {
    expect(parseVisionAction("type(content='line one\\nline \\'two\\'')", bounds)).toEqual({
      type: 'type',
      content: "line one\nline 'two'"
    })
  })

  it('accepts empty typed content', () => {
    expect(parseVisionAction("type(content='')", bounds)).toEqual({ type: 'type', content: '' })
  })
})

describe('fail-closed', () => {
  it('returns null for unknown verbs, missing points, and junk', () => {
    for (const raw of [
      'detonate()',
      'click()', // no point
      "scroll(point='<point>1 1</point>', direction='sideways')", // bad direction
      "drag(start_box='(1,1)')", // missing end
      'hotkey()', // no key
      '',
      'Thought: just thinking, no action'
    ]) {
      expect(parseVisionAction(raw, bounds)).toBeNull()
    }
  })
})
