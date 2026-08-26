import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { NativeImage, WebContentsView } from 'electron'
import { SCREENSHOT_MAX_EDGE, type ComputerUseSettings } from '../../shared/computer-use-settings'
import { WEB_USE_DESKTOP_VIEWPORT } from '../../shared/browser-session'
import { getTaskExecutionDevice, recordTaskRun, taskScreenshotPath } from '../tasks/task-history'
import type { VisionAction } from '../vision/vision-action'
import { RecoverableVisionError, type VisionScreen } from '../vision/vision-agent'
import type { BrowserDriver } from './browser-driver'
import { createBrowserCoordinateTransform } from '../../shared/browser-coordinate-transform'
import { browserPageHasVisualContent } from './browser-page-evidence'
import { alignPixelSize, planAspectPreservingResize } from '../vision/screenshot-geometry'

interface BrowserVisionScreenInput {
  activePage: () => { view: WebContentsView; driver: BrowserDriver }
  taskId: string
  journeyId: string
  goal: string
  settings: ComputerUseSettings
  screenshotResizeFactor?: number
  platform?: NodeJS.Platform
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
  const kernel =
    quality === 'efficient'
      ? sharp.kernel.nearest
      : quality === 'detailed'
        ? sharp.kernel.lanczos3
        : sharp.kernel.cubic
  return sharp(sourcePng)
    .resize({ ...target, fit: 'fill', kernel })
    .png()
    .toBuffer()
}

/** Chromium can report a complete DOM before the compositor has a frame for
 * capturePage(), especially after an SPA route change or native-view resize.
 * Keep that transient wait inside the capture boundary so it does not spend
 * model steps or create false rejected observations. */
interface CapturedBrowserFrame {
  image: NativeImage
  viewport: { width: number; height: number }
}

function stableWebUseViewport(
  left: { width: number; height: number },
  right: { width: number; height: number }
): boolean {
  const tolerance = 2
  const closeToFixedFrame = (viewport: { width: number; height: number }): boolean =>
    Math.abs(viewport.width - WEB_USE_DESKTOP_VIEWPORT.width) <= tolerance &&
    Math.abs(viewport.height - WEB_USE_DESKTOP_VIEWPORT.height) <= tolerance
  return (
    closeToFixedFrame(left) &&
    closeToFixedFrame(right) &&
    Math.abs(left.width - right.width) <= 1 &&
    Math.abs(left.height - right.height) <= 1
  )
}

async function capturePaintedBrowserFrame(
  view: WebContentsView,
  driver: BrowserDriver
): Promise<CapturedBrowserFrame> {
  const deadline = Date.now() + PAINTED_FRAME_TIMEOUT_MS
  let sawPixels = false
  for (;;) {
    // The injected pointer is part of the page. Put it in the compositor frame
    // before capture so Task history and the model receive the same pixels.
    await driver.ensurePointer(true)
    const viewportBefore = await driver.viewportSize()
    if (!stableWebUseViewport(viewportBefore, viewportBefore)) {
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
    if (!image.isEmpty() && stableWebUseViewport(viewportBefore, viewportAfter)) {
      sawPixels = true
      const png = image.toPNG()
      if (await browserPageHasVisualContent(png)) {
        return { image, viewport: viewportBefore }
      }
    }
    if (Date.now() >= deadline) break
    await waitForPaintRetry()
  }
  throw new Error(
    sawPixels
      ? 'The browser returned a blank screenshot. Wait for the current page and capture it again.'
      : 'The browser returned an empty screenshot. Wait for the current page and capture it again.'
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
  let encoded = { width: 1, height: 1 }
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
        const sourcePng = captured.image.toPNG()
        capturedDocumentId = ready.documentId
        capturedPage = page
        viewport = captured.viewport
        encoded = modelViewport
        // Normalize the complete rendered surface once. This exact PNG is both
        // the model input and the Task-history image.
        const png = await normalizeBrowserModelFrame(
          sourcePng,
          modelViewport,
          input.settings.screenshotQuality
        )
        if (!png.length) throw new Error('The browser returned an invalid screenshot.')
        captureNumber += 1
        const savedPath = taskScreenshotPath(input.taskId, `${captureSeriesId}-${captureNumber}`)
        fs.writeFileSync(savedPath, png)
        const device = getTaskExecutionDevice()
        recordTaskRun({
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
          bounds: encoded,
          metadata: {
            path: savedPath,
            viewport,
            geometry: {
              sourceBounds: { x: 0, y: 0, ...captured.image.getSize() },
              encodedSize: encoded,
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
          mapBrowserVisionAction(action, encoded, viewport),
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
