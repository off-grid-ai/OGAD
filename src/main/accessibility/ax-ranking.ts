import type { AxElement } from './ax-elements'
import {
  regionDescription,
  stableCandidateId,
  type AxRect,
  type NormalizedCandidate,
  type WindowBoundObservation
} from './ax-state'
import type { OcrBlock } from '../ocr'

function normalizedLabel(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function intersection(a: AxRect, b: AxRect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

export function overlapRatio(a: AxRect, b: AxRect): number {
  const overlap = intersection(a, b)
  const smaller = Math.min(a.width * a.height, b.width * b.height)
  return smaller > 0 ? overlap / smaller : 0
}

function compatibleRole(role: string): boolean {
  return !/image|separator|group/i.test(role)
}

function inside(rect: AxRect, window: AxRect): boolean {
  return (
    rect.width >= 3 &&
    rect.height >= 3 &&
    rect.x < window.x + window.width &&
    rect.y < window.y + window.height &&
    rect.x + rect.width > window.x &&
    rect.y + rect.height > window.y
  )
}

function clipped(rect: AxRect, window: AxRect): AxRect {
  const x = Math.max(rect.x, window.x)
  const y = Math.max(rect.y, window.y)
  return {
    x,
    y,
    width: Math.max(0, Math.min(rect.x + rect.width, window.x + window.width) - x),
    height: Math.max(0, Math.min(rect.y + rect.height, window.y + window.height) - y)
  }
}

function center(bounds: AxRect): { x: number; y: number } {
  return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
}

function axBounds(element: AxElement): AxRect {
  const width = element.width ?? 3
  const height = element.height ?? 3
  return {
    x: element.x ?? element.cx - width / 2,
    y: element.y ?? element.cy - height / 2,
    width,
    height
  }
}

function candidateFromAx(
  element: AxElement,
  observation: WindowBoundObservation,
  displayIndex: number
): NormalizedCandidate | null {
  const rawBounds = axBounds(element)
  const isNativeMenu = /^(?:AXMenuBarItem|AXMenuItem)$/i.test(element.role)
  const bounds = isNativeMenu ? rawBounds : clipped(rawBounds, observation.window.bounds)
  if (
    !element.enabled ||
    (isNativeMenu
      ? bounds.width < 3 || bounds.height < 3
      : !inside(bounds, observation.window.bounds))
  )
    return null
  const label = element.name || element.value
  const id =
    element.stableId ??
    stableCandidateId({
      windowId: observation.window.windowId,
      source: 'ax',
      role: element.role,
      label,
      bounds
    })
  const point = center(bounds)
  const executable = element.executable !== false
  return {
    id,
    displayIndex,
    source: 'ax',
    role: element.role,
    label: element.name,
    value: element.value,
    bounds,
    center: point,
    enabled: true,
    ...(typeof element.checked === 'boolean' ? { checked: element.checked } : {}),
    ...(typeof element.selected === 'boolean' ? { selected: element.selected } : {}),
    ...(typeof element.hasPopup === 'boolean' ? { hasPopup: element.hasPopup } : {}),
    ...(executable
      ? {
          executable: {
            type: 'activate' as const,
            method: element.hasPopup && element.role !== 'AXMenuBarItem'
              ? ('hover' as const)
              : element.actionable
                ? ('press' as const)
                : ('click' as const),
            x: point.x,
            y: point.y
          },
          expected:
            typeof element.checked === 'boolean' && /check|toggle|switch/i.test(element.role)
              ? {
                  type: 'state_change' as const,
                  candidateId: id,
                  property: 'checked' as const,
                  from: element.checked
                }
              : typeof element.selected === 'boolean' && /radio|option|tab/i.test(element.role)
                ? {
                    type: 'state_change' as const,
                    candidateId: id,
                    property: 'selected' as const,
                    from: element.selected
                  }
                : {
                    type: 'candidate_effect' as const,
                    candidateId: id,
                    before: {
                      value: element.value,
                      enabled: element.enabled,
                      ...(typeof element.checked === 'boolean' ? { checked: element.checked } : {}),
                      ...(typeof element.selected === 'boolean'
                        ? { selected: element.selected }
                        : {})
                    }
                  }
        }
      : {}),
    snapshotId: observation.snapshotId,
    revision: observation.revision,
    windowId: observation.window.windowId,
    processId: observation.window.processId,
    risk: element.risk ?? 'reversible',
    region: regionDescription(bounds, observation.window.bounds)
  }
}

function candidateFromOcr(
  block: OcrBlock,
  observation: WindowBoundObservation,
  displayIndex: number,
  allowOcrClicks: boolean
): NormalizedCandidate | null {
  const bounds = clipped(block.bounds, observation.window.bounds)
  if (!inside(bounds, observation.window.bounds) || !block.text.trim()) return null
  const id = stableCandidateId({
    windowId: observation.window.windowId,
    source: 'ocr',
    role: 'visible-text',
    label: block.text,
    bounds
  })
  const point = center(bounds)
  return {
    id,
    displayIndex,
    source: 'ocr',
    role: 'visible-text',
    label: block.text.trim(),
    value: '',
    bounds,
    center: point,
    enabled: true,
    ...(allowOcrClicks
      ? {
          executable: {
            type: 'activate' as const,
            method: 'click' as const,
            x: point.x,
            y: point.y
          },
          expected: {
            type: 'visible_effect' as const,
            description: `Visible state changes after activating ${block.text.trim()}`
          }
        }
      : {}),
    snapshotId: observation.snapshotId,
    revision: observation.revision,
    windowId: observation.window.windowId,
    processId: observation.window.processId,
    risk: 'reversible',
    region: regionDescription(bounds, observation.window.bounds)
  }
}

export function fuseCandidates(input: {
  observation: WindowBoundObservation
  elements: readonly AxElement[]
  ocr: readonly OcrBlock[]
  allowOcrClicks?: boolean
}): NormalizedCandidate[] {
  const seenAxCandidates = new Set<string>()
  const ax = input.elements
    .map((element, index) => candidateFromAx(element, input.observation, index + 1))
    .filter((candidate): candidate is NormalizedCandidate => candidate !== null)
    .filter((candidate) => {
      if (seenAxCandidates.has(candidate.id)) return false
      seenAxCandidates.add(candidate.id)
      return true
    })
  const unmatchedOcr: NormalizedCandidate[] = []
  for (const block of input.ocr) {
    const match = ax.find(
      (candidate) =>
        compatibleRole(candidate.role) &&
        overlapRatio(candidate.bounds, block.bounds) >= 0.45 &&
        normalizedLabel(candidate.label || candidate.value) === normalizedLabel(block.text)
    )
    if (match) {
      match.source = 'ax+ocr'
      continue
    }
    const candidate = candidateFromOcr(
      block,
      input.observation,
      ax.length + unmatchedOcr.length + 1,
      input.allowOcrClicks === true
    )
    if (candidate) unmatchedOcr.push(candidate)
  }
  return [...ax, ...unmatchedOcr].map((candidate, index) => ({
    ...candidate,
    displayIndex: index + 1
  }))
}

export function groupedCandidates<T>(candidates: readonly T[], maxOptions = 10): T[][] {
  if (candidates.length <= maxOptions) return [Array.from(candidates)]
  const size = Math.ceil(candidates.length / maxOptions)
  const groups: T[][] = []
  for (let index = 0; index < candidates.length; index += size) {
    groups.push(candidates.slice(index, index + size))
  }
  return groups
}

export function deterministicCandidateChoice(candidates: readonly NormalizedCandidate[]):
  | { kind: 'execute'; candidate: NormalizedCandidate }
  | { kind: 'abstain'; reason: 'no_executable_candidate' | 'ambiguous_candidates' } {
  const executable = candidates.filter((candidate) => candidate.executable !== undefined)
  if (executable.length === 1) return { kind: 'execute', candidate: executable[0]! }
  return {
    kind: 'abstain',
    reason: executable.length === 0 ? 'no_executable_candidate' : 'ambiguous_candidates'
  }
}
