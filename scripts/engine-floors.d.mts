export const UPDATABLE_ENGINES: string[]
export function isAppCode(file: string): boolean
// resources/engine-pins.json; only each engine's `ref` and `minApp` are read or written here.
interface EnginePin {
  ref?: string
  minApp?: string
  [field: string]: unknown
}
type Pins = Record<string, EnginePin>
export function applyEngineFloors(input: {
  basePins: Pins
  headPins: Pins
  changedFiles: string[]
  appVersion: string
}): { pins: Pins; floors: Record<string, string> }
