// The input device boundary: nut.js, the native library that moves the real mouse and presses real
// keys. The app loads it with `require`, which vitest does not intercept, so a test that runs real
// actuation code would drive THIS Mac. Installing this fake puts a stand-in into Node's module
// cache under the exact path the app requires, then proves the app now gets the stand-in before any
// test acts; if it does not, it throws, and nothing touches the real input devices.
import { createRequire } from 'node:module'
import path from 'node:path'

export interface InputEvent {
  kind: 'move' | 'click' | 'doubleClick' | 'drag' | 'type' | 'press' | 'release' | 'scroll'
  detail: unknown
}

export interface FakeInputDevice {
  /** Everything "done" to the mouse and keyboard, oldest first. */
  events: InputEvent[]
}

const ACTUATION = path.join(__dirname, '..', '..', 'input', 'actuation.ts')

/** `onEvent` lets the test's desktop react to input, as a real one does (typing fills a field). */
export async function installFakeInputDevice(
  onEvent: (event: InputEvent) => void = () => {}
): Promise<FakeInputDevice> {
  const events: InputEvent[] = []
  let probing = true
  const push = (event: InputEvent): void => {
    events.push(event)
    if (!probing) onEvent(event)
  }
  const record =
    (kind: InputEvent['kind']) =>
    async (...detail: unknown[]): Promise<void> => {
      push({ kind, detail: detail.length === 1 ? detail[0] : detail })
    }
  const keyNames = new Map<string, number>()
  const nut = {
    mouse: {
      setPosition: record('move'),
      leftClick: record('click'),
      rightClick: record('click'),
      click: record('click'),
      doubleClick: record('doubleClick'),
      drag: record('drag'),
      scrollUp: async (n: number) => void push({ kind: 'scroll', detail: ['up', n] }),
      scrollDown: async (n: number) => void push({ kind: 'scroll', detail: ['down', n] }),
      scrollLeft: async (n: number) => void push({ kind: 'scroll', detail: ['left', n] }),
      scrollRight: async (n: number) => void push({ kind: 'scroll', detail: ['right', n] })
    },
    keyboard: { type: record('type'), pressKey: record('press'), releaseKey: record('release') },
    Point: class {
      constructor(
        readonly x: number,
        readonly y: number
      ) {}
    },
    Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
    // Every key name has a code, as nut.js's Key enum does.
    Key: new Proxy({} as Record<string, number>, {
      get: (_target, name) => {
        if (typeof name !== 'string') return undefined
        if (!keyNames.has(name)) keyNames.set(name, keyNames.size + 1)
        return keyNames.get(name)
      }
    })
  }
  const appRequire = createRequire(ACTUATION)
  const id = appRequire.resolve('@nut-tree-fork/nut-js')
  appRequire.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports: nut
  } as unknown as NodeJS.Module
  // Prove the app gets the stand-in before anything acts: first by identity (no input event can
  // happen), then through the app's own loader.
  if (appRequire('@nut-tree-fork/nut-js') !== nut) {
    throw new Error('The fake input device is not in place; refusing to run real actuation.')
  }
  const { loadActuation } = await import('../../input/actuation')
  const actuation = loadActuation()
  await actuation?.moveMouse(-1, -1)
  const probe = events.pop()
  probing = false
  if (!actuation || probe?.kind !== 'move') {
    throw new Error('The fake input device is not in place; refusing to run real actuation.')
  }
  return { events }
}
