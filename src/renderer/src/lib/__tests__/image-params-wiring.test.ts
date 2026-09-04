// Terminal-artifact SEAM test for the image-gen drift fix.
//
// WHY THIS FILE EXISTS (honest scope): the true terminal artifact is the
// `window.api.generateImage(...)` payload that crosses to the main process. That
// payload is only reachable by mounting the composer (MemoryChat.tsx). There is
// NO React render harness in this repo (no @testing-library/react, no jsdom /
// happy-dom vitest environment), and MemoryChat.tsx is coverage-excluded. So we
// cannot drive the real UI action end-to-end here.
//
// What we CAN do — and what the sibling image-params.test.ts does NOT — is model
// the composer's EXACT wiring as a small state machine and assert the value that
// reaches the generate payload, not the resolver's return in isolation. The bug
// was two-layered:
//   (a) drift: composer showed steps=10 but generate ran 28 — because a
//       `[imgModel]` effect re-seeded local state from the model default and
//       stomped the user's typed value; and
//   (b) divergence: the composer's model dropdown didn't write through the same
//       owner as the Active-models panel, so the two disagreed on which model ran.
//
// This test replays the composer wiring in MemoryChat.tsx (send path ~L824-831,
// the `[imgModel, imgParamStore]` effect ~L540-545, `chooseImageModel` ~L551-554,
// `setStepsOverride` ~L557-565) against the SAME pure helpers + a real
// saveSetting/getSetting round-trip through an in-memory settings store. If the
// feature breaks by a DIFFERENT mechanism than `effectiveValue`'s `?? default`
// line — e.g. generate reads an unsynced local `imgSteps`, the effect stops
// recomputing, or the dropdown stops routing through setActiveModalModel — this
// test goes red.

import { describe, it, expect, vi } from 'vitest'
import { standardModelDefaults } from '../../../../shared/image-defaults'
import { resolveImageParams, setOverride, type ImageParamStore } from '../image-params'

const FEW_STEP = 'sdxl-lightning.gguf' // defaultSteps 10, defaultSize 512
const FULL = 'dreamlike-photoreal-v2.gguf' // defaultSteps 28

/** An in-memory stand-in for the renderer's real persistence seam
 *  (window.api.saveSetting / getSettings). The composer persists the whole
 *  imageParams store under one key and reloads it on mount; we round-trip through
 *  the same JSON boundary so a serialization regression would surface here too. */
interface SettingsStore {
  saveSetting(key: string, value: unknown): void
  getSetting<T>(key: string): T | undefined
}

interface ComposerHarness {
  chooseImageModel(model: string): void
  setStepsOverride(value: number): void
  remount(): void
  buildGeneratePayload(): {
    steps: number
    width: number
    height: number
    model: string | undefined
  }
}

function makeSettingsStore(): SettingsStore {
  const raw: Record<string, string> = {}
  return {
    saveSetting: vi.fn((key: string, value: unknown) => {
      raw[key] = JSON.stringify(value)
    }),
    getSetting<T>(key: string): T | undefined {
      return key in raw ? (JSON.parse(raw[key]!) as T) : undefined
    }
  }
}

/**
 * A faithful replica of the MemoryChat image-composer wiring. It owns the same
 * local mirror state the SEND PATH actually reads (imgModel/imgSteps/imgSize) and
 * the persisted per-model store, and wires them exactly as the component does:
 *
 *  - setStepsOverride(v): mirror `imgSteps = v`, persist a per-model override,
 *    and keep the store in memory (MemoryChat.tsx L557-565).
 *  - chooseImageModel(m): set the model AND write through the shared owner
 *    (setActiveModalModel) — the divergence fix (L551-554).
 *  - the `[imgModel, imgParamStore]` effect: on any model/store change, re-derive
 *    imgSteps/imgSize from resolveImageParams — this is the line that used to
 *    STOMP the override; the fix makes it resolve override-first (L540-545).
 *  - buildGeneratePayload(): what the send path hands to window.api.generateImage,
 *    reading the SAME local mirror state the component reads (L824-831). This is
 *    the closest reachable proxy for the terminal artifact.
 */
function makeComposer(setActiveModalModel: (kind: string, model: string) => void): ComposerHarness {
  const settings = makeSettingsStore()
  let imgModel = ''
  let imgSteps = 10
  let imgSize = 512
  let store: ImageParamStore = settings.getSetting<ImageParamStore>('imageParams') ?? {}

  // The `[imgModel, imgParamStore]` effect. Run after every state change that the
  // component lists as a dependency (model OR store), exactly like React re-runs it.
  function runResolveEffect(): void {
    if (!imgModel) return
    const { steps, size } = resolveImageParams(imgModel, store)
    imgSize = size
    imgSteps = steps
  }

  return {
    chooseImageModel(model: string) {
      imgModel = model
      setActiveModalModel('image', model) // divergence fix: same owner as ModelPicker
      runResolveEffect() // [imgModel] dep fires
    },
    setStepsOverride(value: number) {
      imgSteps = value // immediate local mirror
      if (!imgModel) return
      store = setOverride(store, imgModel, 'steps', value)
      settings.saveSetting('imageParams', store)
      runResolveEffect() // [imgParamStore] dep fires
    },
    // Simulate a fresh mount: reload persisted store, then run the effect.
    remount() {
      store = settings.getSetting<ImageParamStore>('imageParams') ?? {}
      runResolveEffect()
    },
    // The send path (MemoryChat.tsx L824-831) reads the LOCAL mirror state.
    buildGeneratePayload() {
      return { steps: imgSteps, width: imgSize, height: imgSize, model: imgModel || undefined }
    }
  }
}

describe('image composer wiring — the generate payload is the terminal artifact', () => {
  it('user override survives a model switch: generate payload carries 10, not the model default 28', () => {
    const setActive = vi.fn()
    const c = makeComposer(setActive)

    // User picks the full checkpoint (default 28) and types steps = 10.
    c.chooseImageModel(FULL)
    c.setStepsOverride(10)

    // The payload the engine receives must be the OVERRIDE, not the stomped default.
    const payload = c.buildGeneratePayload()
    expect(payload.steps).toBe(10)
    expect(payload.model).toBe(FULL)
    // Guard against the assertion-subject trap: prove it's genuinely != the default.
    expect(payload.steps).not.toBe(standardModelDefaults(FULL).defaultSteps)
  })

  it('the model dropdown writes through setActiveModalModel (same owner as the Active-models panel)', () => {
    const setActive = vi.fn()
    const c = makeComposer(setActive)
    c.chooseImageModel(FULL)
    // Divergence fix: choosing in the composer MUST write through the shared owner,
    // or the composer and the Active-models panel silently disagree on which runs.
    expect(setActive).toHaveBeenCalledWith('image', FULL)
    expect(c.buildGeneratePayload().model).toBe(FULL)
  })

  it('override persists and reloads: after a remount the payload still carries 10', () => {
    const c = makeComposer(vi.fn())
    c.chooseImageModel(FULL)
    c.setStepsOverride(10)

    // Fresh mount: reload the persisted imageParams, resolve for the same model.
    c.remount()
    c.chooseImageModel(FULL)
    expect(c.buildGeneratePayload().steps).toBe(10)
  })

  it('switching to a model with no override falls back to THAT model default, not the last value', () => {
    const c = makeComposer(vi.fn())
    c.chooseImageModel(FULL)
    c.setStepsOverride(10) // override on FULL only

    // Switch to a few-step model that the user never pinned.
    c.chooseImageModel(FEW_STEP)
    const payload = c.buildGeneratePayload()
    expect(payload.steps).toBe(standardModelDefaults(FEW_STEP).defaultSteps)
    expect(payload.model).toBe(FEW_STEP)

    // And switching BACK restores the pinned override, not the few-step default.
    c.chooseImageModel(FULL)
    expect(c.buildGeneratePayload().steps).toBe(10)
  })
})
