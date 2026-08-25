/**
 * The vision rail's action parser (R2-D): UI-TARS-1.5 emits each step as text
 * in its own action space - `click(point='<point>x y</point>')`, `type(...)`,
 * `hotkey(...)`, `drag(...)`, `scroll(...)`, `wait()`, `finished(...)`,
 * `call_user()`. This turns that text into a structured VisionAction with
 * coordinates denormalized from the model's 0-1000 space to real pixels.
 *
 * Pure and injected everywhere: the parser takes the raw string and the target
 * bounds, so it is unit-tested exhaustively without a screen. Fail-closed - an
 * action it does not recognise, or one missing a required point, is null; the
 * loop notes the waste and re-observes rather than clicking a guessed spot.
 *
 * Ported from @ui-tars/sdk's action parser (Apache-2.0), reduced to the verbs
 * the supervised tier ships and retyped closed.
 */

export interface Point {
  x: number
  y: number
}

export type VisionAction =
  | { type: 'click'; point: Point }
  | { type: 'double_click'; point: Point }
  | { type: 'right_click'; point: Point }
  | { type: 'middle_click'; point: Point }
  | { type: 'triple_click'; point: Point }
  | { type: 'drag'; from: Point; to: Point }
  | { type: 'drag_to'; to: Point }
  | { type: 'mouse_move'; point: Point }
  | { type: 'type'; content: string }
  | { type: 'hotkey'; keys: string }
  | { type: 'press'; keys: readonly string[] }
  | { type: 'key_down'; keys: readonly string[] }
  | { type: 'key_up'; keys: readonly string[] }
  | { type: 'scroll'; point: Point; direction: 'up' | 'down' | 'left' | 'right' }
  | { type: 'scroll_by'; axis: 'vertical' | 'horizontal'; amount: number }
  | { type: 'wait'; durationMs?: number }
  | { type: 'finished'; content: string }
  | { type: 'call_user'; content: string }

export interface Bounds {
  width: number
  height: number
}

/** UI-TARS normalizes coordinates to 0-1000 over the input image. Denormalize
 *  to real pixels within the target bounds; clamp so a slightly out-of-range
 *  prediction still lands on-screen rather than off it. */
function denormalize(nx: number, ny: number, bounds: Bounds): Point {
  const clamp = (v: number, max: number): number => Math.min(Math.max(Math.round(v), 0), max)
  return {
    x: clamp((nx / 1000) * bounds.width, bounds.width - 1),
    y: clamp((ny / 1000) * bounds.height, bounds.height - 1)
  }
}

/** Pull a point out of any of the coordinate spellings UI-TARS uses:
 *  `<point>x y</point>`, `(x,y)`, `x,y`, or `start_box='(x,y)'`. */
function extractPoint(raw: string, bounds: Bounds): Point | null {
  const pointTag = raw.match(/<point>\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*<\/point>/i)
  const paren = raw.match(/\(?\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*\)?/)
  const match = pointTag ?? paren
  if (!match) {
    return null
  }
  return denormalize(Number(match[1]), Number(match[2]), bounds)
}

/** The single-quoted or double-quoted argument value for `name=`, honoring
 *  backslash-escaped quotes inside (UI-TARS writes `\'` for a literal quote). */
function argOf(raw: string, name: string): string | undefined {
  const match = raw.match(new RegExp(`${name}\\s*=\\s*(['"])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1`))
  return match?.[2]
}

const DIRECTIONS = new Set(['up', 'down', 'left', 'right'])

/* eslint-disable complexity -- one dispatch over the fixed UI-TARS verb set;
   splitting each verb into a helper would scatter the grammar this pins. */
export function parseVisionAction(raw: string, bounds: Bounds): VisionAction | null {
  // The model may prefix a Thought:; the action is the last `Action:` line, or
  // the whole string if it is bare.
  const actionText = raw.includes('Action:') ? raw.slice(raw.lastIndexOf('Action:') + 7) : raw
  const verb = actionText
    .trim()
    .match(/^([a-z_]+)/i)?.[1]
    ?.toLowerCase()
  if (!verb) {
    return null
  }
  switch (verb) {
    case 'click':
    case 'left_single': {
      const point = extractPoint(actionText, bounds)
      return point ? { type: 'click', point } : null
    }
    case 'left_double':
    case 'double_click': {
      const point = extractPoint(actionText, bounds)
      return point ? { type: 'double_click', point } : null
    }
    case 'right_single':
    case 'right_click': {
      const point = extractPoint(actionText, bounds)
      return point ? { type: 'right_click', point } : null
    }
    case 'drag': {
      const start = argOf(actionText, 'start_box') ?? argOf(actionText, 'start_point')
      const end = argOf(actionText, 'end_box') ?? argOf(actionText, 'end_point')
      if (!start || !end) {
        return null
      }
      const from = extractPoint(start, bounds)
      const to = extractPoint(end, bounds)
      return from && to ? { type: 'drag', from, to } : null
    }
    case 'type': {
      const content = argOf(actionText, 'content')
      return content === undefined ? null : { type: 'type', content: unescapeContent(content) }
    }
    case 'hotkey': {
      const keys = argOf(actionText, 'key') ?? argOf(actionText, 'keys')
      return keys ? { type: 'hotkey', keys: keys.trim() } : null
    }
    case 'scroll': {
      const point = extractPoint(actionText, bounds)
      const direction = (argOf(actionText, 'direction') ?? '').toLowerCase()
      return point && DIRECTIONS.has(direction)
        ? { type: 'scroll', point, direction: direction as 'up' | 'down' | 'left' | 'right' }
        : null
    }
    case 'wait':
      return { type: 'wait' }
    case 'finished':
      return { type: 'finished', content: unescapeContent(argOf(actionText, 'content') ?? '') }
    case 'call_user':
      return { type: 'call_user', content: unescapeContent(argOf(actionText, 'content') ?? '') }
    default:
      return null
  }
}
/* eslint-enable complexity */

/** UI-TARS escapes newlines/quotes inside content strings. */
function unescapeContent(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'")
}
