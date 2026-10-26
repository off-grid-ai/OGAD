import { describe, expect, it } from 'vitest'
import { standardModelDefaults } from '../image-defaults'
import {
  resolveImageDimensions,
  setImageDimensions,
  setImageParameter,
  snapImageDimension
} from '../image-dimensions'

const MODEL = 'dreamlike-photoreal-v2.gguf'
const defaults = standardModelDefaults(MODEL)

describe('snapImageDimension', () => {
  it('rounds to a multiple of 64 and clamps to 256-2048', () => {
    expect(snapImageDimension(1000)).toBe(1024)
    expect(snapImageDimension(1216)).toBe(1216)
    expect(snapImageDimension(100)).toBe(256)
    expect(snapImageDimension(4096)).toBe(2048)
    expect(snapImageDimension(Number.NaN)).toBe(256)
  })
})

describe('per-model width × height', () => {
  it('renders at the square size when no custom dimensions are stored', () => {
    const resolved = resolveImageDimensions({ id: MODEL }, { [MODEL]: { size: 768 } })
    expect(resolved).toMatchObject({ size: 768, width: 768, height: 768 })
  })

  it('stores a non-square choice as snapped width and height', () => {
    const store = setImageDimensions({}, MODEL, 1200, 830)
    expect(store[MODEL]).toEqual({ width: 1216, height: 832 })
    expect(resolveImageDimensions({ id: MODEL }, store)).toMatchObject({
      width: 1216,
      height: 832
    })
  })

  it('stores a square choice as size, dropping earlier custom dimensions', () => {
    const custom = setImageDimensions({}, MODEL, 1216, 832)
    expect(setImageDimensions(custom, MODEL, 1536, 1536)[MODEL]).toEqual({ size: 1536 })
  })

  it('keeps custom dimensions when steps go back to the model default', () => {
    let store = setImageParameter({}, MODEL, 'steps', defaults.defaultSteps + 4)
    store = setImageDimensions(store, MODEL, 1216, 832)
    store = setImageParameter(store, MODEL, 'steps', defaults.defaultSteps)
    expect(store[MODEL]).toEqual({ width: 1216, height: 832 })
  })

  it('choosing a preset size replaces custom dimensions', () => {
    const store = setImageParameter(
      setImageDimensions({}, MODEL, 1216, 832),
      MODEL,
      'size',
      defaults.defaultSize
    )
    expect(store[MODEL]).toBeUndefined()
    expect(resolveImageDimensions({ id: MODEL }, store)).toMatchObject({
      width: defaults.defaultSize,
      height: defaults.defaultSize
    })
  })
})
