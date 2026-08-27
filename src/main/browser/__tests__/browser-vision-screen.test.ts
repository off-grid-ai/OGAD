import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserRecoveryDisposition,
  createBrowserVisionScreen,
  mapBrowserVisionAction,
  normalizeBrowserShortcut,
  normalizeBrowserModelFrame,
  resolveBrowserModelViewport,
  isTransientBrowserFailure
} from '../browser-vision-screen'
import { browserPageHasVisualContent } from '../browser-page-evidence'
import sharp from 'sharp'
import { createBrowserCoordinateTransform } from '../../../shared/browser-coordinate-transform'
import { DEFAULT_COMPUTER_USE_SETTINGS } from '../../../shared/computer-use-settings'
import type { WebContentsView } from 'electron'
import type { BrowserDriver } from '../browser-driver'

const browserEvidenceMocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  recordTaskRun: vi.fn()
}))

vi.mock('node:fs', () => ({
  default: { writeFileSync: browserEvidenceMocks.writeFileSync }
}))

// Evidence lands through the injected sink seam (BrowserVisionEvidenceSink) -
// no module mock of our own code; only node:fs (the device boundary) is faked.
const evidenceSink = {
  getTaskExecutionDevice: () => ({ id: 'test-device', name: 'Test device' }),
  recordTaskRun: browserEvidenceMocks.recordTaskRun,
  taskScreenshotPath: (taskId: string, captureNumber: string | number) =>
    `/tmp/${taskId}-${captureNumber}.png`
} as unknown as import('../browser-vision-screen').BrowserVisionEvidenceSink

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('browser visual coordinate mapping', () => {
  const encoded = { width: 1000, height: 500 }
  const viewport = { width: 1500, height: 1000 }

  it('maps click coordinates from the model image to the live viewport', () => {
    expect(
      mapBrowserVisionAction({ type: 'click', point: { x: 200, y: 100 } }, encoded, viewport)
    ).toEqual({ type: 'click', point: { x: 300, y: 200 } })
  })

  it('maps Retina screenshot pixels into CSS viewport pixels', () => {
    expect(
      mapBrowserVisionAction(
        { type: 'click', point: { x: 1200, y: 800 } },
        { width: 2400, height: 1600 },
        { width: 1200, height: 800 }
      )
    ).toEqual({ type: 'click', point: { x: 600, y: 400 } })
  })

  it('maps a page-only UI-Mate image directly into its webpage viewport', () => {
    const modelPoint = { x: 100, y: 295 }
    const mapped = mapBrowserVisionAction(
      { type: 'click', point: modelPoint },
      { width: 832, height: 1024 },
      { width: 599, height: 732 }
    )

    expect(mapped).toEqual({
      type: 'click',
      point: { x: 72, y: 211 }
    })
  })

  it('maps both drag endpoints without changing the action type', () => {
    expect(
      mapBrowserVisionAction(
        { type: 'drag', from: { x: 100, y: 50 }, to: { x: 900, y: 450 } },
        encoded,
        viewport
      )
    ).toEqual({
      type: 'drag',
      from: { x: 150, y: 100 },
      to: { x: 1350, y: 900 }
    })
  })

  it('maps the scroll anchor but preserves model scroll direction', () => {
    expect(
      mapBrowserVisionAction(
        { type: 'scroll', point: { x: 500, y: 250 }, direction: 'up' },
        encoded,
        viewport
      )
    ).toEqual({
      type: 'scroll',
      point: { x: 750, y: 500 },
      direction: 'up'
    })
  })

  it('does not transform actions without image coordinates', () => {
    const action = { type: 'type', content: 'Pune' } as const
    expect(mapBrowserVisionAction(action, encoded, viewport)).toEqual(action)
  })
})

describe('browser coordinate transform', () => {
  it('maps a full browser surface and removes tabs and address bar once for CDP', () => {
    const transform = createBrowserCoordinateTransform({
      encoded: { width: 1024, height: 900 },
      surface: { width: 832, height: 732 },
      page: { x: 0, y: 102, width: 832, height: 630 },
      capture: { width: 1664, height: 1464 }
    })

    const surfacePoint = transform.encodedToSurface({ x: 512, y: 450 })
    expect(surfacePoint).toEqual({ x: 416, y: 366 })
    expect(transform.surfaceToPage(surfacePoint)).toEqual({ x: 416, y: 264 })
  })

  it('uses no chrome offset for a content-only capture', () => {
    const transform = createBrowserCoordinateTransform({
      encoded: { width: 512, height: 384 },
      surface: { width: 1024, height: 768 },
      page: { x: 0, y: 0, width: 1024, height: 768 },
      capture: { width: 2048, height: 1536 }
    })

    const surfacePoint = transform.encodedToSurface({ x: 128, y: 96 })
    expect(surfacePoint).toEqual({ x: 256, y: 192 })
    expect(transform.surfaceToPage(surfacePoint)).toEqual(surfacePoint)
  })

  it('maps Retina capture pixels independently from CSS actuation coordinates', () => {
    const transform = createBrowserCoordinateTransform({
      encoded: { width: 1200, height: 800 },
      surface: { width: 1200, height: 800 },
      page: { x: 0, y: 80, width: 1200, height: 720 },
      capture: { width: 2400, height: 1600 }
    })

    expect(transform.surfaceToCapture({ x: 600, y: 400 })).toEqual({ x: 1200, y: 800 })
    expect(transform.surfaceToPage({ x: 600, y: 400 })).toEqual({ x: 600, y: 320 })
  })

  it('maps a resized and patch-aligned model image by each axis', () => {
    const transform = createBrowserCoordinateTransform({
      encoded: { width: 1024, height: 896 },
      surface: { width: 833, height: 732 },
      page: { x: 0, y: 100, width: 833, height: 632 },
      capture: { width: 1666, height: 1464 }
    })

    expect(transform.encodedToSurface({ x: 768, y: 672 })).toEqual({ x: 625, y: 549 })
  })

  it('does not add document scroll to viewport-local CDP input', () => {
    const transform = createBrowserCoordinateTransform({
      encoded: { width: 1000, height: 1000 },
      surface: { width: 800, height: 700 },
      page: { x: 0, y: 100, width: 800, height: 600 },
      capture: { width: 1600, height: 1400 }
    })

    const beforeScroll = transform.surfaceToPage({ x: 320, y: 460 })
    // A document scroll does not change the captured surface or page viewport frame.
    const afterScroll = transform.surfaceToPage({ x: 320, y: 460 })
    expect(beforeScroll).toEqual({ x: 320, y: 360 })
    expect(afterScroll).toEqual(beforeScroll)
  })

  it('keeps the saved evidence marker on the exact actuated click', () => {
    const transform = createBrowserCoordinateTransform({
      encoded: { width: 1024, height: 900 },
      surface: { width: 833, height: 732 },
      page: { x: 0, y: 102, width: 833, height: 630 },
      // Deliberately use unequal X/Y scales to guard the former vertical bug.
      capture: { width: 1666, height: 1465 }
    })
    const surfacePoint = transform.encodedToSurface({ x: 512, y: 675 })
    const actualCdpPoint = transform.surfaceToPage(surfacePoint)
    const markerPoint = transform.surfaceToCapture(surfacePoint)
    const markerPercent = transform.surfaceToCapturePercent(surfacePoint)

    expect(surfacePoint).toEqual({ x: 417, y: 549 })
    expect(actualCdpPoint).toEqual({ x: 417, y: 447 })
    expect(markerPoint.y).toBeCloseTo(((actualCdpPoint.y + 102) * 1465) / 732)
    expect(markerPercent).toEqual({ x: (417 * 100) / 833, y: (549 * 100) / 732 })
  })
})

describe('browser shortcut normalization', () => {
  it('uses Command on macOS', () => {
    expect(normalizeBrowserShortcut({ type: 'hotkey', keys: 'ctrl a' }, 'darwin')).toEqual({
      type: 'hotkey',
      keys: 'cmd a'
    })
  })

  it('uses Control on Windows', () => {
    expect(normalizeBrowserShortcut({ type: 'hotkey', keys: 'cmd a' }, 'win32')).toEqual({
      type: 'hotkey',
      keys: 'ctrl a'
    })
  })
})

describe('browser screenshot evidence', () => {
  it('uses the selected screenshot size for one fixed 16:10 browser frame', async () => {
    const retina = await sharp({
      create: { width: 2048, height: 1280, channels: 4, background: '#ffffff' }
    })
      .png()
      .toBuffer()

    const target = resolveBrowserModelViewport(DEFAULT_COMPUTER_USE_SETTINGS)
    expect(target).toEqual({ width: 1440, height: 900 })
    await expect(
      sharp(
        await normalizeBrowserModelFrame(
          retina,
          target,
          DEFAULT_COMPUTER_USE_SETTINGS.screenshotQuality
        )
      ).metadata()
    ).resolves.toMatchObject(target)
  })

  it('aligns the selected frame when the model requires patch-sized images', () => {
    expect(resolveBrowserModelViewport(DEFAULT_COMPUTER_USE_SETTINGS, 32)).toEqual({
      width: 1440,
      height: 896
    })
  })

  it('waits inside one capture while Chromium paints instead of spending model steps', async () => {
    vi.useFakeTimers()
    const capturePage = vi.fn(async () => ({
      isEmpty: () => true,
      toPNG: () => Buffer.alloc(0),
      getSize: () => ({ width: 0, height: 0 })
    }))
    const screen = createBrowserVisionScreen({
      evidence: evidenceSink,
      activePage: () => ({
        view: {
          webContents: {
            invalidate: vi.fn(),
            capturePage,
            getURL: () => 'https://example.test',
            getTitle: () => 'Example'
          }
        } as unknown as WebContentsView,
        driver: {
          ensurePageReady: async () => ({
            url: 'https://example.test',
            readyState: 'complete',
            documentId: 'document-a'
          }),
          ensurePointer: vi.fn(async () => undefined),
          viewportSize: vi.fn(async () => ({ width: 1920, height: 1200 }))
        } as unknown as BrowserDriver
      }),
      taskId: 'paint-recovery',
      journeyId: 'paint-recovery-chat',
      goal: 'Wait for the rendered page',
      settings: DEFAULT_COMPUTER_USE_SETTINGS
    })
    const outcome = screen.capture().catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(10_000)

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining('empty screenshot')
    })
    expect(capturePage.mock.calls.length).toBeGreaterThan(1)
  })

  it('keeps one exact model frame and clicks the captured target after the pane resizes', async () => {
    const sourcePng = await sharp({
      create: { width: 1920, height: 1200, channels: 4, background: '#ffffff' }
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="120" height="80"><rect width="120" height="80" fill="#059669"/></svg>'
          ),
          left: 900,
          top: 560
        }
      ])
      .png()
      .toBuffer()
    const ensurePointer = vi.fn(async () => undefined)
    const capturePage = vi.fn(async () => ({
      isEmpty: () => false,
      toPNG: () => sourcePng,
      getSize: () => ({ width: 1920, height: 1200 })
    }))
    const viewportSize = vi
      .fn()
      .mockResolvedValueOnce({ width: 1920, height: 1200 })
      .mockResolvedValueOnce({ width: 1920, height: 1200 })
      // The former click-time remap consumed this transient resize value.
      .mockResolvedValue({ width: 1, height: 1 })
    const actuate = vi.fn(async () => ({ ok: true as const }))
    const driver = {
      ensurePageReady: vi.fn(async () => ({
        url: 'https://example.test',
        readyState: 'complete',
        documentId: 'document-a'
      })),
      ensurePointer,
      viewportSize,
      pageState: vi.fn(async () => ({
        url: 'https://example.test',
        readyState: 'complete',
        documentId: 'document-a'
      })),
      actuate
    } as unknown as BrowserDriver
    const view = {
      webContents: {
        invalidate: vi.fn(),
        capturePage,
        getURL: () => 'https://example.test',
        getTitle: () => 'Example'
      }
    } as unknown as WebContentsView
    const screen = createBrowserVisionScreen({
      evidence: evidenceSink,
      activePage: () => ({ view, driver }),
      taskId: 'resize-journey',
      journeyId: 'resize-journey-chat',
      goal: 'Click the center target',
      settings: { ...DEFAULT_COMPUTER_USE_SETTINGS, screenshotSize: 'compact' },
      platform: 'darwin'
    })

    const captured = await screen.capture()
    const persistedPng = browserEvidenceMocks.writeFileSync.mock.calls[0]?.[1] as Buffer
    expect(captured.image).toMatch(/^\/tmp\/resize-journey-[0-9a-f-]{36}-1\.png$/)
    expect(captured.bounds).toEqual({ width: 1024, height: 640 })
    expect(await sharp(persistedPng).metadata()).toMatchObject({ width: 1024, height: 640 })
    expect(ensurePointer.mock.invocationCallOrder[0]).toBeLessThan(
      capturePage.mock.invocationCallOrder[0]!
    )

    // This is the exact inference point that the real run incorrectly remapped
    // to (1, 1) while the user resized the task pane.
    await screen.actuate({ type: 'click', point: { x: 281, y: 186 } })

    expect(actuate).toHaveBeenCalledWith({ type: 'click', point: { x: 527, y: 349 } })
    expect(viewportSize).toHaveBeenCalledTimes(2)
  })

  it('rejects a valid PNG that contains only a blank browser background', async () => {
    const blank = await sharp({
      create: { width: 200, height: 100, channels: 4, background: '#202020' }
    })
      .png()
      .toBuffer()
    expect(await browserPageHasVisualContent(blank)).toBe(false)
  })

  it('accepts a rendered page with visible contrast', async () => {
    const rendered = await sharp({
      create: { width: 200, height: 100, channels: 4, background: '#202020' }
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="80" height="20"><rect width="80" height="20" fill="white"/></svg>'
          ),
          left: 10,
          top: 10
        }
      ])
      .png()
      .toBuffer()
    expect(await browserPageHasVisualContent(rendered)).toBe(true)
  })
})

describe('transient Chromium failures', () => {
  it.each([
    'Execution context was destroyed.',
    'Cannot find context with specified id',
    'Target was detached',
    'Frame was detached',
    'The browser returned a blank screenshot.',
    'The page is loading'
  ])('classifies %s for bounded re-observation', (message) => {
    expect(isTransientBrowserFailure(new Error(message))).toBe(true)
  })

  it('keeps an invalid action as a terminal programming failure', () => {
    expect(isTransientBrowserFailure(new Error('unsupported key F13'))).toBe(false)
  })

  it('bounds blank-page recovery to two fresh observations', () => {
    const blank = new Error('The browser returned a blank screenshot after recovery.')
    expect(browserRecoveryDisposition(blank, 0)).toBe('retry')
    expect(browserRecoveryDisposition(blank, 1)).toBe('retry')
    expect(browserRecoveryDisposition(blank, 2)).toBe('fail')
  })
})
