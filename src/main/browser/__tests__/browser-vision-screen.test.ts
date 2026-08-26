import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserRecoveryDisposition,
  createBrowserVisionScreen,
  mapBrowserVisionAction,
  normalizeBrowserShortcut,
  remapPageActionToCurrentViewport,
  isTransientBrowserFailure
} from '../browser-vision-screen'
import { browserPageHasVisualContent } from '../browser-page-evidence'
import sharp from 'sharp'
import { createBrowserCoordinateTransform } from '../../../shared/browser-coordinate-transform'
import { DEFAULT_COMPUTER_USE_SETTINGS } from '../../../shared/computer-use-settings'

afterEach(() => {
  vi.useRealTimers()
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

describe('browser resize coordinate recalculation', () => {
  it('rescales a captured page click into the current browser viewport', () => {
    expect(
      remapPageActionToCurrentViewport(
        { type: 'click', point: { x: 400, y: 300 } },
        { width: 800, height: 600 },
        { width: 1200, height: 900 }
      )
    ).toEqual({ type: 'click', point: { x: 600, y: 450 } })
  })

  it('rescales both drag endpoints after a proportional browser resize', () => {
    expect(
      remapPageActionToCurrentViewport(
        { type: 'drag', from: { x: 80, y: 60 }, to: { x: 720, y: 540 } },
        { width: 800, height: 600 },
        { width: 400, height: 300 }
      )
    ).toEqual({
      type: 'drag',
      from: { x: 40, y: 30 },
      to: { x: 360, y: 270 }
    })
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
  it('waits inside one capture while Chromium paints instead of spending model steps', async () => {
    vi.useFakeTimers()
    const capturePage = vi.fn(async () => ({ isEmpty: () => true }))
    const invalidate = vi.fn()
    const screen = createBrowserVisionScreen({
      activeView: () =>
        ({ webContents: { capturePage, invalidate } }) as unknown as ReturnType<
          Parameters<typeof createBrowserVisionScreen>[0]['activeView']
        >,
      activeDriver: () =>
        ({
          ensurePageReady: async () => ({ url: 'https://example.test' })
        }) as unknown as ReturnType<
          Parameters<typeof createBrowserVisionScreen>[0]['activeDriver']
        >,
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
    expect(invalidate).toHaveBeenCalledTimes(capturePage.mock.calls.length)
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
