import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { NativeImage, WebContentsView } from 'electron'
import {
  SCREENSHOT_MAX_EDGE,
  SCREENSHOT_RESIZE_KERNEL,
  type ComputerUseSettings
} from '@offgrid/automation'
import { WEB_USE_DESKTOP_VIEWPORT } from '@offgrid/automation'
import { getTaskExecutionDevice, recordTaskRun, taskScreenshotPath } from '../tasks/task-history'
import type { VisionAction } from '../vision/vision-action'
import { RecoverableVisionError, type VisionScreen } from '../vision/vision-agent'
import type { BrowserDriver } from './browser-driver'
import { createBrowserCoordinateTransform } from '@offgrid/automation'
import { browserPageHasVisualContent } from './browser-page-evidence'
import { alignPixelSize, planAspectPreservingResize } from '../vision/screenshot-geometry'

/** Where each capture's evidence lands (task-history disk + DB). Injectable so
 *  tests fake the sink at this seam instead of module-mocking our own code. */
export interface BrowserVisionEvidenceSink {
  getTaskExecutionDevice: typeof getTaskExecutionDevice
  recordTaskRun: typeof recordTaskRun
  taskScreenshotPath: typeof taskScreenshotPath
}

const DEFAULT_EVIDENCE_SINK: BrowserVisionEvidenceSink = {
  getTaskExecutionDevice,
  recordTaskRun,
  taskScreenshotPath
}

interface BrowserVisionScreenInput {
  activePage: () => { view: WebContentsView; driver: BrowserDriver }
  taskId: string
  journeyId: string
  goal: string
  settings: ComputerUseSettings
  screenshotResizeFactor?: number
  platform?: NodeJS.Platform
  evidence?: BrowserVisionEvidenceSink
}

const MAX_TRANSIENT_RECOVERIES = 2
const PAINTED_FRAME_TIMEOUT_MS = 6_000
const PAINTED_FRAME_RETRY_MS = 250

function waitForPaintRetry(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, PAINTED_FRAME_RETRY_MS)
    timer.unref()
  })
}

export function resolveBrowserModelViewport(
  settings: ComputerUseSettings,
  screenshotResizeFactor?: number
): { width: number; height: number } {
  const planned = planAspectPreservingResize(
    WEB_USE_DESKTOP_VIEWPORT,
    SCREENSHOT_MAX_EDGE[settings.screenshotSize]
  ).encodedSize
  return screenshotResizeFactor ? alignPixelSize(planned, screenshotResizeFactor) : planned
}

export async function normalizeBrowserModelFrame(
  sourcePng: Buffer,
  target: { width: number; height: number },
  quality: ComputerUseSettings['screenshotQuality']
): Promise<Buffer> {
  return sharp(sourcePng)
    .resize({ ...target, fit: 'fill', kernel: SCREENSHOT_RESIZE_KERNEL[quality] })
    .png()
    .toBuffer()
}

/** Chromium can report a complete DOM before the compositor has a frame for
 * capturePage(), especially after an SPA route change or native-view resize.
 * Keep that transient wait inside the capture boundary so it does not spend
 * model steps or create false rejected observations. */
interface CapturedBrowserFrame {
  image: NativeImage
  /** The frame encoded once; capture() must reuse it instead of re-encoding. */
  png: Buffer
  viewport: { width: number; height: number }
}

/** The live pane can be any size. The model frame is normalized later, and the
 * coordinate transform maps its actions back to this exact captured viewport. */
function isUsableWebUseViewport(viewport: { width: number; height: number }): boolean {
  if (viewport.width <= 0 || viewport.height <= 0) return false
  const expectedAspect = WEB_USE_DESKTOP_VIEWPORT.width / WEB_USE_DESKTOP_VIEWPORT.height
  const actualAspect = viewport.width / viewport.height
  return Math.abs(actualAspect - expectedAspect) <= 0.02
}

function stableWebUseViewport(
  before: { width: number; height: number },
  after: { width: number; height: number }
): boolean {
  return (
    isUsableWebUseViewport(before) &&
    isUsableWebUseViewport(after) &&
    Math.abs(before.width - after.width) <= 1 &&
    Math.abs(before.height - after.height) <= 1
  )
}

async function capturePaintedBrowserFrame(
  view: WebContentsView,
  driver: BrowserDriver
): Promise<CapturedBrowserFrame> {
  const deadline = Date.now() + PAINTED_FRAME_TIMEOUT_MS
  let sawPixels = false
  // WHY the loop gave up, not just that it did. Four different conditions end it and they were all
  // reported as one of two sentences, so a failure could not be told apart: the commonest case does
  // not even reach capturePage - if the view never reports the fixed desktop viewport (no region
  // claimed, or a surface too small to reach the 0.25 zoom floor) it spins to the deadline and still
  // said "empty screenshot". Record the last blocker and the numbers behind it.
  let blocker = 'the view never reported a usable Web Use viewport'
  for (;;) {
    // The injected pointer is part of the page. Put it in the compositor frame
    // before capture so Task history and the model receive the same pixels.
    const [, viewportBefore] = await Promise.all([
      driver.ensurePointer(true),
      driver.viewportSize()
    ])
    if (!isUsableWebUseViewport(viewportBefore)) {
      blocker =
        `the view reported a ${viewportBefore.width}x${viewportBefore.height} viewport, ` +
        'not a usable 16:10 browser viewport'
      if (Date.now() >= deadline) break
      await waitForPaintRetry()
      continue
    }
    view.webContents.invalidate()
    const image = await view.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true
    })
    const viewportAfter = await driver.viewportSize()
    if (image.isEmpty()) {
      blocker = 'capturePage returned no pixels at all (the native view is hidden or has no bounds)'
    } else if (!stableWebUseViewport(viewportBefore, viewportAfter)) {
      blocker =
        `the viewport changed mid-capture, ${viewportBefore.width}x${viewportBefore.height} ` +
        `then ${viewportAfter.width}x${viewportAfter.height}`
    } else {
      sawPixels = true
      const png = image.toPNG()
      if (await browserPageHasVisualContent(png)) {
        return { image, png, viewport: viewportBefore }
      }
      blocker = 'the captured frame had pixels but no visual content (the page had not painted)'
    }
    if (Date.now() >= deadline) break
    await waitForPaintRetry()
  }
  throw new Error(
    `${
      sawPixels
        ? 'The browser returned a blank screenshot.'
        : 'The browser returned an empty screenshot.'
    } Wait for the current page and capture it again. (after ${PAINTED_FRAME_TIMEOUT_MS}ms: ${blocker})`
  )
}

/** Chromium uses several messages for the same short-lived document-boundary
 * condition. Keep that knowledge at the browser boundary. */
export function isTransientBrowserFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:blank|loading|current display surface not available for capture|context (?:was )?destroyed|cannot find context|target (?:was )?(?:closed|detached)|no target with given id|frame (?:was )?detached|session closed|object has been destroyed|webcontents was destroyed)/i.test(
    message
  )
}

export function browserRecoveryDisposition(
  error: unknown,
  priorFailures: number
): 'retry' | 'fail' {
  return isTransientBrowserFailure(error) && priorFailures < MAX_TRANSIENT_RECOVERIES
    ? 'retry'
    : 'fail'
}

/** Map model-image coordinates back into Chromium viewport coordinates. */
export function mapBrowserVisionAction(
  action: VisionAction,
  encoded: { width: number; height: number },
  viewport: { width: number; height: number }
): VisionAction {
  const mapPoint = createBrowserCoordinateTransform({
    encoded,
    surface: viewport,
    page: { x: 0, y: 0, ...viewport },
    capture: viewport
  }).encodedToSurface
  switch (action.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'middle_click':
    case 'triple_click':
    case 'mouse_move':
      return { ...action, point: mapPoint(action.point) }
    case 'drag':
      return {
        ...action,
        from: mapPoint(action.from),
        to: mapPoint(action.to)
      }
    case 'drag_to':
      return { ...action, to: mapPoint(action.to) }
    case 'scroll':
      return { ...action, point: mapPoint(action.point) }
    default:
      return action
  }
}

/** Translate the model's generic desktop shortcuts into the host platform's
 * primary modifier before browser actuation. */
export function normalizeBrowserShortcut(
  action: VisionAction,
  platform: NodeJS.Platform
): VisionAction {
  if (action.type !== 'hotkey') return action
  const primaryModifier = platform === 'darwin' ? 'cmd' : 'ctrl'
  return {
    ...action,
    keys: action.keys.replace(/\b(?:ctrl|control|cmd|command|meta)\b/i, primaryModifier)
  }
}

/** The browser counterpart of the desktop VisionScreen: screenshot the
 * isolated agent page, then execute the official computer-use action space by
 * CDP. The saved frame is also the durable last state for Task history. */
export function createBrowserVisionScreen(input: BrowserVisionScreenInput): VisionScreen {
  // Freeze the selected model frame for the full task. Settings and pane bounds
  // cannot change the coordinate space between an observation and its action.
  const modelViewport = resolveBrowserModelViewport(input.settings, input.screenshotResizeFactor)
  let viewport = { width: 1, height: 1 }
  let captureNumber = 0
  const captureSeriesId = randomUUID()
  let capturedDocumentId = ''
  let capturedPage: ReturnType<BrowserVisionScreenInput['activePage']> | undefined
  let transientCaptureFailures = 0
  let transientActuationFailures = 0
  return {
    async capture() {
      try {
        const page = input.activePage()
        const { view, driver } = page
        const ready = await driver.ensurePageReady()
        const captured = await capturePaintedBrowserFrame(view, driver)
        capturedDocumentId = ready.documentId
        capturedPage = page
        viewport = captured.viewport
        // Normalize the complete rendered surface once. This exact PNG is both
        // the model input and the Task-history image.
        const png = await normalizeBrowserModelFrame(
          captured.png,
          modelViewport,
          input.settings.screenshotQuality
        )
        if (!png.length) throw new Error('The browser returned an invalid screenshot.')
        captureNumber += 1
        const evidence = input.evidence ?? DEFAULT_EVIDENCE_SINK
        const savedPath = evidence.taskScreenshotPath(
          input.taskId,
          `${captureSeriesId}-${captureNumber}`
        )
        fs.writeFileSync(savedPath, png)
        const device = evidence.getTaskExecutionDevice()
        evidence.recordTaskRun({
          taskId: input.taskId,
          journeyId: input.journeyId,
          kind: 'web_use',
          title: input.goal,
          screenshotPath: savedPath,
          screenshotDeviceId: device.id,
          lastUrl: view.webContents.getURL(),
          lastTitle: view.webContents.getTitle()
        })
        transientCaptureFailures = 0
        transientActuationFailures = 0
        return {
          image: savedPath,
          bounds: modelViewport,
          metadata: {
            path: savedPath,
            viewport,
            geometry: {
              sourceBounds: { x: 0, y: 0, ...captured.image.getSize() },
              encodedSize: modelViewport,
              scale: modelViewport.width / captured.image.getSize().width
            }
          }
        }
      } catch (error) {
        if (browserRecoveryDisposition(error, transientCaptureFailures) === 'fail') throw error
        transientCaptureFailures += 1
        const detail = error instanceof Error ? error.message : String(error)
        throw new RecoverableVisionError(detail)
      }
    },
    async actuate(action) {
      try {
        const mapped = normalizeBrowserShortcut(
          mapBrowserVisionAction(action, modelViewport, viewport),
          input.platform ?? process.platform
        )
        const driver = capturedPage?.driver
        if (!driver) return { rejected: 'Take a new screenshot before acting.' }
        const pageState = await driver.pageState()
        if (
          pageState.readyState === 'loading' ||
          (capturedDocumentId && pageState.documentId !== capturedDocumentId)
        ) {
          transientActuationFailures += 1
          if (transientActuationFailures > MAX_TRANSIENT_RECOVERIES) {
            throw new Error(
              'The browser page kept changing or loading after repeated observations.'
            )
          }
          return {
            rejected:
              'The page changed or started loading after the screenshot. Take a new screenshot before acting.'
          }
        }
        // The captured CSS viewport owns this action. Native pane bounds and
        // zoom are presentation only and must not remap an approved target.
        const result = await driver.actuate(mapped)
        if (!result.ok) {
          if (result.reason === 'takeover') return { handoff: result.detail }
          if (result.reason === 'recoverable') return { rejected: result.detail }
          throw new Error(result.detail)
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 350)
          timer.unref()
        })
        transientActuationFailures = 0
        return { mappedAction: mapped }
      } catch (error) {
        if (browserRecoveryDisposition(error, transientActuationFailures) === 'fail') throw error
        transientActuationFailures += 1
        const detail = error instanceof Error ? error.message : String(error)
        return { rejected: `${detail} Take a new screenshot before acting.` }
      }
    }
  }
}
