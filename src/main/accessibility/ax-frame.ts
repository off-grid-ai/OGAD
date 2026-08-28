import { taskScreenshotPath } from '../tasks/task-history'
import type { AxSnapshot } from './ax-elements'
import type { AxObservationFrame } from './ax-observation'

function snapshotBounds(
  snapshot: AxSnapshot
): { x: number; y: number; width: number; height: number } | undefined {
  if (!snapshot.elements.length) return undefined
  const xs = snapshot.elements.map((element) => element.cx)
  const ys = snapshot.elements.map((element) => element.cy)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.max(...xs) - left),
    height: Math.max(1, Math.max(...ys) - top)
  }
}

/** Capture evidence only when a live AX run reaches the native I/O boundary. The dynamic import
 * keeps Electron's app-bound Vision singleton out of pure tool and routing imports. */
export async function captureAxObservationFrame(
  taskId: string,
  captureNumber: number,
  snapshot: AxSnapshot
): Promise<AxObservationFrame | undefined> {
  const { vision } = await import('../vision')
  const capture = await vision.captureDisplayFrame(
    snapshotBounds(snapshot),
    taskScreenshotPath(taskId, `ax-${captureNumber}`)
  )
  return capture ? { capture, snapshot } : undefined
}
