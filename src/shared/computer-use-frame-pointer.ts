export interface ComputerUseFramePointer {
  x: number
  y: number
  width: number
  height: number
}

interface Point {
  x: number
  y: number
}

export interface ComputerUseFrameEvidence {
  mappedAction?: string
  actionCoordinateSpace?: 'inference' | 'viewport'
  screenshot?: {
    path?: string
    originalWidth: number
    originalHeight: number
    inferenceWidth: number
    inferenceHeight: number
    viewportWidth?: number
    viewportHeight?: number
  }
}

function point(value: unknown): Point | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.x !== 'number' || !Number.isFinite(candidate.x)) return null
  if (typeof candidate.y !== 'number' || !Number.isFinite(candidate.y)) return null
  return { x: candidate.x, y: candidate.y }
}

/** Select the final point without duplicating the vision action verb list. */
function actionDestination(value: unknown): Point | null {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const destination = actionDestination(value[index])
      if (destination) return destination
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const action = value as Record<string, unknown>
  return (
    point(action.point) ??
    point(action.to) ??
    actionDestination(action.completed) ??
    actionDestination(action.failedAction)
  )
}

/** The same screenshot/action evidence drives the Desktop PiP and portable Mobile frame cursor. */
export function computerUseFramePointer(
  screenshotPath: string,
  details: readonly ComputerUseFrameEvidence[]
): ComputerUseFramePointer | null {
  for (let index = details.length - 1; index >= 0; index -= 1) {
    const detail = details[index]
    if (detail?.screenshot?.path !== screenshotPath || !detail.mappedAction) continue
    let destination: Point | null = null
    try {
      destination = actionDestination(JSON.parse(detail.mappedAction))
    } catch {
      destination = null
    }
    if (!destination) return null
    const screenshot = detail.screenshot
    const width =
      detail.actionCoordinateSpace === 'inference'
        ? screenshot.inferenceWidth
        : (screenshot.viewportWidth ?? screenshot.originalWidth)
    const height =
      detail.actionCoordinateSpace === 'inference'
        ? screenshot.inferenceHeight
        : (screenshot.viewportHeight ?? screenshot.originalHeight)
    if (width <= 0 || height <= 0) return null
    return {
      x: Math.min(Math.max(destination.x, 0), width),
      y: Math.min(Math.max(destination.y, 0), height),
      width,
      height
    }
  }
  return null
}
