import { desktopCapturer, app, screen } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { isWaylandSession, captureWaylandWindow } from './linux-desktop'
import { captureComputerUseDisplay } from './vision/computer-use-display-capture'

export interface CapturedDisplayFrame {
  path: string
  width: number
  height: number
  displayBounds: { x: number; y: number; width: number; height: number }
}

class VisionService {
  private capturesDir: string

  constructor() {
    this.capturesDir = path.join(app.getPath('userData'), 'captures')
    if (!fs.existsSync(this.capturesDir)) {
      fs.mkdirSync(this.capturesDir, { recursive: true })
    }
  }

  async captureAppWindow(
    appName: string,
    windowTitle?: string,
    bounds?: { x: number; y: number; width: number; height: number },
    windowId?: number
  ): Promise<string | null> {
    try {
      if (isWaylandSession()) {
        if (!windowId) return null
        const png = await captureWaylandWindow(windowId)
        return png ? await this.writeThumb(png) : null
      }
      console.log(
        `Vision: Attempting to capture window for ${appName} (Title: ${windowTitle || 'Any'})...`
      )

      // Native IDs identify the focused window even when its title is empty or
      // another window has the same title. Electron's source id is window:ID:0.
      if (windowId || (windowTitle && windowTitle.trim())) {
        const windows = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 1920, height: 1080 }
        })
        const byId = windowId
          ? windows.find((source) => source.id.split(':')[1] === String(windowId))
          : undefined
        // On X11, the focus library may report the client leader instead of the
        // individual window ID. A unique title still identifies that window.
        const matchingTitles = windowTitle
          ? windows.filter((source) => source.name === windowTitle)
          : []
        const exact = byId ?? (matchingTitles.length === 1 ? matchingTitles[0] : undefined)
        if (exact && !exact.thumbnail.isEmpty()) {
          return await this.writeThumb(exact.thumbnail.toPNG())
        }
      }

      // If Electron has no window source, use the focused window's bounds on its
      // display. A missing rectangle must not turn a Replay frame into a full
      // display image.
      if (
        !bounds ||
        !Number.isFinite(bounds.x) ||
        !Number.isFinite(bounds.y) ||
        !Number.isFinite(bounds.width) ||
        !Number.isFinite(bounds.height) ||
        bounds.width <= 0 ||
        bounds.height <= 0
      )
        return null
      return (
        (await this.captureDisplayFrame(bounds, undefined, { windowBounds: bounds }))?.path ?? null
      )
    } catch (e) {
      console.error('Vision Capture Failed:', e)
      return null
    }
  }

  /** Capture the display that owns the target app. Replay can crop to the focused window;
   * Computer Use still receives the full display for its live supervisor. */
  async captureDisplayFrame(
    bounds?: { x: number; y: number; width: number; height: number },
    outputPath?: string,
    options: {
      forComputerUse?: boolean
      windowBounds?: { x: number; y: number; width: number; height: number }
    } = {}
  ): Promise<CapturedDisplayFrame | null> {
    try {
      const point =
        bounds && Number.isFinite(bounds.x)
          ? {
              x: Math.round(bounds.x + bounds.width / 2),
              y: Math.round(bounds.y + bounds.height / 2)
            }
          : screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(point)
      if (options.forComputerUse) {
        const scale = Math.min(1920 / display.bounds.width, 1080 / display.bounds.height)
        const captured = await captureComputerUseDisplay({
          displayId: Number(display.id),
          width: Math.max(1, Math.round(display.bounds.width * scale)),
          height: Math.max(1, Math.round(display.bounds.height * scale))
        })
        const framePath = await this.writeThumb(captured.png, outputPath)
        return {
          path: framePath,
          width: captured.width,
          height: captured.height,
          displayBounds: display.bounds
        }
      }
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })
      if (!sources.length) {
        console.log('Vision: No screen sources available')
        return null
      }
      const target =
        sources.find((source) => String(source.display_id) === String(display.id)) ??
        (sources.length === 1 ? sources[0] : undefined)
      if (!target) {
        console.log('Vision: Cannot identify the active window display')
        return null
      }
      if (target.thumbnail.isEmpty()) {
        console.log('Vision: Active screen thumbnail empty (screen may be locked)')
        return null
      }
      const size = target.thumbnail.getSize()
      if (options.windowBounds) {
        const win = options.windowBounds
        const x0 = Math.max(win.x, display.bounds.x)
        const y0 = Math.max(win.y, display.bounds.y)
        const x1 = Math.min(win.x + win.width, display.bounds.x + display.bounds.width)
        const y1 = Math.min(win.y + win.height, display.bounds.y + display.bounds.height)
        if (x1 <= x0 || y1 <= y0) return null
        const left = Math.max(
          0,
          Math.floor(((x0 - display.bounds.x) * size.width) / display.bounds.width)
        )
        const top = Math.max(
          0,
          Math.floor(((y0 - display.bounds.y) * size.height) / display.bounds.height)
        )
        const right = Math.min(
          size.width,
          Math.ceil(((x1 - display.bounds.x) * size.width) / display.bounds.width)
        )
        const bottom = Math.min(
          size.height,
          Math.ceil(((y1 - display.bounds.y) * size.height) / display.bounds.height)
        )
        if (right <= left || bottom <= top) return null
        const { default: sharp } = await import('sharp')
        const png = await sharp(target.thumbnail.toPNG())
          .extract({ left, top, width: right - left, height: bottom - top })
          .png()
          .toBuffer()
        const framePath = await this.writeThumb(png, outputPath)
        return {
          path: framePath,
          width: right - left,
          height: bottom - top,
          displayBounds: display.bounds
        }
      }
      const framePath = await this.writeThumb(target.thumbnail.toPNG(), outputPath)
      return { path: framePath, ...size, displayBounds: display.bounds }
    } catch (error) {
      console.error('Vision Capture Failed:', error)
      return null
    }
  }

  private async writeThumb(png: Buffer, outputPath?: string): Promise<string> {
    const filePath = outputPath ?? path.join(this.capturesDir, `capture-${Date.now()}.png`)
    await fs.promises.writeFile(filePath, png)
    console.log(`Vision: Captured ${filePath}`)
    return filePath
  }

  cleanup(filePath: string): void {
    fs.unlink(filePath, (err) => {
      if (err) console.error('Failed to cleanup capture:', err)
    })
  }
}

/**
 * The focused window's rectangle expressed as a FRACTION of its display — used to
 * crop a full-display screenshot down to exactly that window. Window bounds are
 * global (screen) coords; we subtract the window's display origin and divide by
 * the display size. desktopCapturer thumbnails preserve the display's aspect
 * ratio, so these fractions map cleanly onto the screenshot pixels. Returns null
 * if bounds are missing/degenerate (caller then OCRs the whole screen).
 */
export function windowRegionOnDisplay(bounds?: {
  x: number
  y: number
  width: number
  height: number
}): { x: number; y: number; w: number; h: number } | null {
  if (!bounds || !Number.isFinite(bounds.x) || bounds.width < 50 || bounds.height < 50) return null
  try {
    const center = {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2)
    }
    const db = screen.getDisplayNearestPoint(center).bounds
    if (!db.width || !db.height) return null
    const clamp = (n: number): number => Math.min(1, Math.max(0, n))
    const r = {
      x: clamp((bounds.x - db.x) / db.width),
      y: clamp((bounds.y - db.y) / db.height),
      w: clamp(bounds.width / db.width),
      h: clamp(bounds.height / db.height)
    }
    // Ignore if it's basically the whole display (no useful crop) or degenerate.
    if (r.w < 0.15 || r.h < 0.15) return null
    if (r.x <= 0.01 && r.y <= 0.01 && r.w >= 0.99 && r.h >= 0.99) return null
    return r
  } catch {
    return null
  }
}

export const vision = new VisionService()
