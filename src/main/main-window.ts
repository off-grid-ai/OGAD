/**
 * The one reference to the app's MAIN window, set once at creation.
 *
 * `BrowserWindow.getAllWindows()[0]` is not reliably the main window - the
 * clipboard/dictation/supervisor overlays are also BrowserWindows, so `[0]` can
 * be one of them, and anything that lays a WebContentsView over "the window"
 * (the browser rail's live page) then attaches to the wrong one and renders in
 * the wrong place. This holds the real main window so those callers dock right.
 *
 * A tiny standalone module so the main window can be read from anywhere (the
 * browser host) without importing index.ts, which would be a cycle.
 */
import type { BrowserWindow } from 'electron'

let mainWin: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow): void {
  mainWin = win
}

/** The main window, or null before it exists / after it is destroyed. */
export function getMainWindow(): BrowserWindow | null {
  return mainWin && !mainWin.isDestroyed() ? mainWin : null
}
