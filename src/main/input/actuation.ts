/**
 * Synthetic input, shared by the rails that drive the live desktop (the vision
 * grounder and the accessibility driving rail). Backed by the OPTIONAL native
 * addon (@nut-tree-fork/nut-js); absent/unbuilt -> null, so a rail gates itself
 * off cleanly instead of crashing.
 *
 * Extracted from the vision host so the accessibility rail reuses the exact same
 * actuation (one adapter, one place the addon is required) rather than forking a
 * second synthetic-input surface.
 */
import { hotkeyToKeyNames } from '../vision/vision-keys'

export interface ActuationPort {
  moveMouse(x: number, y: number): Promise<void>
  click(button: 'left' | 'right' | 'middle', count: 1 | 2 | 3): Promise<void>
  dragTo(x: number, y: number): Promise<void>
  typeText(text: string): Promise<void>
  tapKeys(keys: string): Promise<void>
  pressKeys(keys: readonly string[]): Promise<void>
  keyDown(keys: readonly string[]): Promise<void>
  keyUp(keys: readonly string[]): Promise<void>
  scroll(direction: 'up' | 'down' | 'left' | 'right'): Promise<void>
  scrollBy(axis: 'vertical' | 'horizontal', amount: number): Promise<void>
}

/** The slice of the nut.js API the adapter uses. */
export interface NutApi {
  mouse: {
    setPosition(p: unknown): Promise<unknown>
    leftClick(): Promise<unknown>
    rightClick(): Promise<unknown>
    click(btn: number): Promise<unknown>
    doubleClick(btn: number): Promise<unknown>
    drag(path: unknown[]): Promise<unknown>
    scrollUp(n: number): Promise<unknown>
    scrollDown(n: number): Promise<unknown>
    scrollLeft(n: number): Promise<unknown>
    scrollRight(n: number): Promise<unknown>
  }
  keyboard: {
    type(...input: unknown[]): Promise<unknown>
    pressKey(...keys: number[]): Promise<unknown>
    releaseKey(...keys: number[]): Promise<unknown>
  }
  Point: new (x: number, y: number) => unknown
  Button: { LEFT: number; RIGHT: number; MIDDLE: number }
  Key: Record<string, number>
}

/**
 * Load the OPTIONAL native input addon and adapt it to ActuationPort. The
 * require is by a VARIABLE name so the bundler/typechecker never hard-binds the
 * optional module (main is CJS - `require` is available at runtime); a missing
 * or unbuilt addon is caught and returns null.
 */
export function loadActuation(): ActuationPort | null {
  let nut: NutApi
  try {
    const load = (m: string): NutApi => (require as NodeRequire)(m) as NutApi
    nut = load('@nut-tree-fork/nut-js')
  } catch {
    return null
  }
  return adaptNutActuation(nut)
}

/** Adapt the real nut.js primitives behind a stable, testable input contract. */
export function adaptNutActuation(nut: NutApi): ActuationPort {
  const { mouse, keyboard, Point, Button, Key } = nut
  return {
    async moveMouse(x, y) {
      await mouse.setPosition(new Point(x, y))
    },
    async click(button, count) {
      const nativeButton =
        button === 'right' ? Button.RIGHT : button === 'middle' ? Button.MIDDLE : Button.LEFT
      if (count === 2) {
        await mouse.doubleClick(nativeButton)
        return
      }
      if (count === 3) {
        await mouse.click(nativeButton)
        await mouse.click(nativeButton)
        await mouse.click(nativeButton)
        return
      }
      await mouse.click(nativeButton)
    },
    async dragTo(x, y) {
      await mouse.drag([new Point(x, y)])
    },
    async typeText(text) {
      await keyboard.type(text)
    },
    async tapKeys(keys) {
      const names = hotkeyToKeyNames(keys)
      if (!names) {
        return
      }
      const codes = names.map((n) => Key[n]).filter((c) => typeof c === 'number')
      if (codes.length !== names.length) {
        return // an unmapped key - refuse the partial combo
      }
      await keyboard.pressKey(...codes)
      await keyboard.releaseKey(...codes)
    },
    async pressKeys(keys) {
      for (const key of keys) {
        const names = hotkeyToKeyNames(key)
        if (!names || names.length !== 1) throw new Error(`Unsupported key: ${key}`)
        const code = Key[names[0]!]
        if (typeof code !== 'number') throw new Error(`Unsupported key: ${key}`)
        await keyboard.pressKey(code)
        await keyboard.releaseKey(code)
      }
    },
    async keyDown(keys) {
      const codes = keyCodes(keys, Key)
      await keyboard.pressKey(...codes)
    },
    async keyUp(keys) {
      const codes = keyCodes([...keys].reverse(), Key)
      await keyboard.releaseKey(...codes)
    },
    async scroll(direction) {
      const steps = 3
      if (direction === 'up') {
        await mouse.scrollUp(steps)
      } else if (direction === 'down') {
        await mouse.scrollDown(steps)
      } else if (direction === 'left') {
        await mouse.scrollLeft(steps)
      } else {
        await mouse.scrollRight(steps)
      }
    },
    async scrollBy(axis, amount) {
      // VisionAction scroll_by uses pixels on every surface. nut.js accepts
      // wheel steps, so convert at this native boundary instead of allowing
      // browser and desktop behavior to drift.
      const magnitude = Math.ceil(Math.abs(amount) / 120)
      if (magnitude === 0) return
      if (axis === 'horizontal') {
        await (amount > 0 ? mouse.scrollRight(magnitude) : mouse.scrollLeft(magnitude))
      } else {
        await (amount > 0 ? mouse.scrollUp(magnitude) : mouse.scrollDown(magnitude))
      }
    }
  }
}

function keyCodes(keys: readonly string[], keyMap: Record<string, number>): number[] {
  return keys.map((key) => {
    const names = hotkeyToKeyNames(key)
    if (!names || names.length !== 1) throw new Error(`Unsupported key: ${key}`)
    const code = keyMap[names[0]!]
    if (typeof code !== 'number') throw new Error(`Unsupported key: ${key}`)
    return code
  })
}

export function actuationAvailable(): boolean {
  return loadActuation() !== null
}
