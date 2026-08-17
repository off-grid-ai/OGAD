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
  click(button: 'left' | 'right', double: boolean): Promise<void>
  dragTo(x: number, y: number): Promise<void>
  typeText(text: string): Promise<void>
  tapKeys(keys: string): Promise<void>
  scroll(direction: 'up' | 'down' | 'left' | 'right'): Promise<void>
}

/** The slice of the nut.js API the adapter uses. */
interface NutApi {
  mouse: {
    setPosition(p: unknown): Promise<unknown>
    leftClick(): Promise<unknown>
    rightClick(): Promise<unknown>
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
  const { mouse, keyboard, Point, Button, Key } = nut
  return {
    async moveMouse(x, y) {
      await mouse.setPosition(new Point(x, y))
    },
    async click(button, double) {
      if (double) {
        await mouse.doubleClick(Button.LEFT)
        return
      }
      await (button === 'right' ? mouse.rightClick() : mouse.leftClick())
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
    }
  }
}

export function actuationAvailable(): boolean {
  return loadActuation() !== null
}
