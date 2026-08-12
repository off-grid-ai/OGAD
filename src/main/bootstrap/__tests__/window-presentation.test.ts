import { describe, expect, it } from 'vitest'
import { resolveWindowPresentation } from '../window-presentation'

/**
 * Deciding whether a launch is allowed to interrupt the person at the keyboard.
 *
 * The failure this guards is not a crash, it is an interruption: the e2e suite drives the real app, so
 * before this existed every local run stole focus once per spec and the workaround was to not run the
 * tests at all. The other direction matters more - a real user's app must never resolve to hidden,
 * because an app that launches with no window and no Dock tile is indistinguishable from one that
 * failed to start.
 */
describe('deciding whether a launch shows itself', () => {
  it('shows the window and keeps the Dock tile for a normal launch', () => {
    // The env a user's app actually has: neither variable set.
    expect(resolveWindowPresentation({})).toEqual({ showWindow: true, showInDock: true })
  })

  it('shows nothing when the run is headless', () => {
    // Both halves: a hidden window still leaves the app frontmost if it holds a Dock tile, and taking
    // the menu bar over is the part a developer notices even without a window appearing.
    expect(resolveWindowPresentation({ OFFGRID_E2E_HEADLESS: '1' })).toEqual({
      showWindow: false,
      showInDock: false
    })
  })

  it('lets a developer watch a headless run happen', () => {
    // OFFGRID_E2E_HEADED wins, because `npm run test:e2e` sets HEADLESS unconditionally - without an
    // override that wins, a failing spec could never be watched.
    expect(
      resolveWindowPresentation({ OFFGRID_E2E_HEADLESS: '1', OFFGRID_E2E_HEADED: '1' })
    ).toEqual({ showWindow: true, showInDock: true })
  })

  it('treats any value other than 1 as not set', () => {
    // Exported-but-empty is the common shape in a shell (`OFFGRID_E2E_HEADLESS=` or a stale ''), and it
    // must not hide a real user's window.
    expect(resolveWindowPresentation({ OFFGRID_E2E_HEADLESS: '' }).showWindow).toBe(true)
    expect(resolveWindowPresentation({ OFFGRID_E2E_HEADLESS: 'true' }).showWindow).toBe(true)
    expect(resolveWindowPresentation({ OFFGRID_E2E_HEADLESS: '0' }).showWindow).toBe(true)
  })
})
