import { describe, expect, it } from 'vitest'
import { deterministicCandidateChoice, fuseCandidates, groupedCandidates } from '../ax-ranking'
import {
  nextObservationRevision,
  observationOwnsCandidate,
  stableCandidateId,
  type WindowBoundObservation
} from '../ax-state'
import type { AxElement } from '../ax-elements'

const observation: WindowBoundObservation = {
  snapshotId: 'snapshot-7',
  revision: 7,
  window: {
    platform: 'darwin',
    processId: 42,
    processName: 'Example',
    windowId: 'window-42',
    windowTitle: 'Example',
    bounds: { x: 100, y: 200, width: 800, height: 600 }
  },
  capture: {
    sourceBounds: { x: 100, y: 200, width: 800, height: 600 },
    encodedWidth: 800,
    encodedHeight: 600,
    scaleX: 1,
    scaleY: 1
  },
  sources: {
    ax: { available: true },
    uia: { available: false, degradedReason: 'not_windows' },
    ocr: { available: true },
    capture: { available: true }
  }
}

function element(index: number, label: string, x: number, role = 'AXButton'): AxElement {
  return {
    index,
    role,
    name: label,
    value: '',
    x,
    y: 240,
    width: 100,
    height: 40,
    cx: x + 50,
    cy: 260,
    stableId: `element-${index}`,
    source: 'ax',
    processId: 42,
    windowId: 'window-42',
    revision: 7,
    actionable: true,
    enabled: true
  }
}

describe('candidate fusion and state', () => {
  it('keeps AX-only icon controls and OCR-only visible text', () => {
    const candidates = fuseCandidates({
      observation,
      elements: [element(1, '', 120, 'AXButton')],
      ocr: [
        {
          text: 'Account total',
          confidence: 0.98,
          bounds: { x: 400, y: 300, width: 150, height: 30 }
        }
      ]
    })
    expect(candidates.map((candidate) => candidate.source)).toEqual(['ax', 'ocr'])
    expect(candidates[0]?.executable).toMatchObject({ type: 'activate' })
    expect(candidates[1]?.executable).toBeUndefined()
  })

  it('keeps AX semantic evidence without making it executable', () => {
    const evidence = {
      ...element(1, '', 120, 'AXStaticText'),
      value: '1.4142135624',
      actionable: false,
      executable: false
    }
    const candidates = fuseCandidates({ observation, elements: [evidence], ocr: [] })
    expect(candidates[0]).toMatchObject({ role: 'AXStaticText', value: '1.4142135624' })
    expect(candidates[0]?.executable).toBeUndefined()
    expect(deterministicCandidateChoice(candidates)).toEqual({
      kind: 'abstain',
      reason: 'no_executable_candidate'
    })
  })

  it('merges equal overlapping AX and OCR labels but keeps duplicate labels in different regions', () => {
    const candidates = fuseCandidates({
      observation,
      elements: [element(1, 'Open', 120), element(2, 'Open', 700)],
      ocr: [
        { text: 'Open', confidence: 0.99, bounds: { x: 120, y: 240, width: 100, height: 40 } },
        { text: 'Open', confidence: 0.99, bounds: { x: 450, y: 500, width: 100, height: 40 } }
      ]
    })
    expect(candidates).toHaveLength(3)
    expect(candidates[0]?.source).toBe('ax+ocr')
    expect(candidates[1]?.source).toBe('ax')
    expect(candidates[2]?.source).toBe('ocr')
  })

  it('drops disabled and off-window controls and preserves exact bounds and centers', () => {
    const disabled = { ...element(1, 'Disabled', 120), enabled: false }
    const candidates = fuseCandidates({
      observation,
      elements: [disabled, element(2, 'Outside', 1_200), element(3, 'Inside', 200)],
      ocr: []
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      label: 'Inside',
      bounds: { x: 200, y: 240, width: 100, height: 40 },
      center: { x: 250, y: 260 }
    })
  })

  it('keeps all targets reachable through deterministic groups', () => {
    const values = Array.from({ length: 121 }, (_, index) => index)
    expect(groupedCandidates(values, 10).flat()).toEqual(values)

    const candidates = fuseCandidates({
      observation,
      elements: Array.from({ length: 130 }, (_, index) =>
        element(index + 1, `Target ${index + 1}`, 120 + index)
      ),
      ocr: [
        {
          text: 'Visible blocker',
          confidence: 0.99,
          bounds: { x: 400, y: 300, width: 150, height: 30 }
        }
      ]
    })
    expect(candidates).toHaveLength(131)
    expect(candidates.at(-1)).toMatchObject({ source: 'ocr', label: 'Visible blocker' })
  })

  it('uses exact fail-closed deterministic paths', () => {
    const none = deterministicCandidateChoice([])
    const one = fuseCandidates({ observation, elements: [element(1, 'Only', 120)], ocr: [] })
    expect(none).toEqual({ kind: 'abstain', reason: 'no_executable_candidate' })
    expect(deterministicCandidateChoice(one)).toMatchObject({ kind: 'execute' })
  })

  it('keeps stable IDs across equivalent observations and changes the revision on relevant change', () => {
    const first = nextObservationRevision(undefined, observation.window, ['button:Open:120:240'])
    const same = nextObservationRevision(first, observation.window, ['button:Open:120:240'])
    const changed = nextObservationRevision(same, observation.window, ['button:Close:120:240'])
    const id = stableCandidateId({
      windowId: 'window-42',
      source: 'ax',
      role: 'AXButton',
      label: 'Open',
      bounds: { x: 120, y: 240, width: 100, height: 40 }
    })
    expect(same.revision).toBe(first.revision)
    expect(changed.revision).toBe(first.revision + 1)
    expect(id).toBe(
      stableCandidateId({
        windowId: 'window-42',
        source: 'ax',
        role: 'AXButton',
        label: 'Open',
        bounds: { x: 120, y: 240, width: 100, height: 40 }
      })
    )
  })

  it('rejects stale revision and window ownership', () => {
    const [candidate] = fuseCandidates({
      observation,
      elements: [element(1, 'Open', 120)],
      ocr: []
    })
    expect(observationOwnsCandidate(observation, candidate!)).toBe(true)
    expect(observationOwnsCandidate({ ...observation, revision: 8 }, candidate!)).toBe(false)
    expect(
      observationOwnsCandidate(
        { ...observation, window: { ...observation.window, windowId: 'other-window' } },
        candidate!
      )
    ).toBe(false)
  })
})
