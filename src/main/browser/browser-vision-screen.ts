import fs from 'node:fs'
import type { NativeImage, WebContentsView } from 'electron'
import type { ComputerUseSettings } from '../../shared/computer-use-settings'
import { SCREENSHOT_MAX_EDGE, SCREENSHOT_RESIZE_QUALITY } from '../../shared/computer-use-settings'
import { getTaskExecutionDevice, recordTaskRun, taskScreenshotPath } from '../tasks/task-history'
import type { VisionAction } from '../vision/vision-action'
import { RecoverableVisionError, type VisionScreen } from '../vision/vision-agent'
import { alignPixelSize, planAspectPreservingResize } from '../vision/screenshot-geometry'
import type { BrowserDriver } from './browser-driver'
import { createBrowserCoordinateTransform } from '../../shared/browser-coordinate-transform'
import { browserPageHasVisualContent } from './browser-page-evidence'

interface BrowserVisionScreenInput {
  activeView: () => WebContentsView
  activeDriver: () => BrowserDriver
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

/** Chromium can report a complete DOM before the compositor has a frame for
 * capturePage(), especially after an SPA route change or native-view resize.
 * Keep that transient wait inside the capture boundary so it does not spend
 * model steps or create false rejected observations. */
async function capturePaintedBrowserFrame(view: WebContentsView): Promise<NativeImage> {
  const deadline = Date.now() + PAINTED_FRAME_TIMEOUT_MS
  let sawPixels = false
  for (;;) {
    view.webContents.invalidate()
    const image = await view.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true
    })
    if (!image.isEmpty()) {
      sawPixels = true
      const png = image.toPNG()
      if (png.length && (await browserPageHasVisualContent(png))) return image
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

/** Recalculate a page-local action when the live browser was resized after the
 * screenshot. Web Use keeps one fixed 1920x1200 CSS viewport and changes only
 * its native zoom, so this proportional transform preserves the target. */
export function remapPageActionToCurrentViewport(
  action: VisionAction,
  capturedPage: { width: number; height: number },
  currentViewport: { width: number; height: number }
): VisionAction {
  return mapBrowserVisionAction(action, capturedPage, currentViewport)
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
  let encoded = { width: 1, height: 1 }
  let viewport = { width: 1, height: 1 }
  let captureNumber = 0
  let capturedPageUrl = ''
  let transientCaptureFailures = 0
  let transientActuationFailures = 0
  return {
    async capture() {
      try {
        const view = input.activeView()
        const driver = input.activeDriver()
        const ready = await driver.ensurePageReady()
        const image = await capturePaintedBrowserFrame(view)
        capturedPageUrl = ready.url
        const capturedPixels = image.getSize()
        viewport = await input.activeDriver().viewportSize()
        const planned = planAspectPreservingResize(
          capturedPixels,
          SCREENSHOT_MAX_EDGE[input.settings.screenshotSize]
        ).encodedSize
        const target = input.screenshotResizeFactor
          ? alignPixelSize(planned, input.screenshotResizeFactor)
          : planned
        const inferenceImage =
          target.width === capturedPixels.width && target.height === capturedPixels.height
            ? image
            : image.resize({
                ...target,
                quality: SCREENSHOT_RESIZE_QUALITY[input.settings.screenshotQuality]
              })
        encoded = inferenceImage.getSize()
        const png = inferenceImage.toPNG()
        if (!png.length) throw new Error('The browser returned an invalid screenshot.')
        captureNumber += 1
        const savedPath = taskScreenshotPath(input.taskId, captureNumber)
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
        return {
          image: savedPath,
          bounds: encoded,
          metadata: {
            path: savedPath,
            viewport,
            geometry: {
              sourceBounds: { x: 0, y: 0, ...capturedPixels },
              encodedSize: encoded,
              scale: Math.min(
                encoded.width / capturedPixels.width,
                encoded.height / capturedPixels.height
              )
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
        const driver = input.activeDriver()
        const pageState = await driver.pageState()
        if (pageState.url !== capturedPageUrl || pageState.readyState === 'loading') {
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
        const currentViewport = await driver.viewportSize()
        const pageAction = remapPageActionToCurrentViewport(mapped, viewport, currentViewport)
        const result = await driver.actuate(pageAction)
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
        return { mappedAction: pageAction }
      } catch (error) {
        if (browserRecoveryDisposition(error, transientActuationFailures) === 'fail') throw error
        transientActuationFailures += 1
        const detail = error instanceof Error ? error.message : String(error)
        return { rejected: `${detail} Take a new screenshot before acting.` }
      }
    }
  }
}
