// Focus detection via get-windows (active-win) in the MAIN process — reliable
// where the spawned Swift watcher failed (it never saw iTerm2). Runs with the
// app's real Screen-Recording permission, and because capture is screenshot+OCR
// (not AX/keystrokes), it works even for apps with macOS "Secure Keyboard Entry"
// on — no user setting changes required.
//
// On each tick we hand the focused app/title/url to the CRM extractor, which
// self-gates (per-app interval, dedupe, ignored apps) and does the screenshot +
// OCR + distill.

import { extractObservationFromScreen } from './crm/extract';

let timer: ReturnType<typeof setInterval> | null = null;
let paused = false;
let currentApp = '';
let currentTitle = '';
let currentUrl = '';

export function setCapturePaused(p: boolean): void {
  paused = p;
}
export function isCapturePaused(): boolean {
  return paused;
}
/** The app currently in focus (for the tray "recalibrate current app"). */
export function getActiveAppName(): string {
  return currentApp;
}
/** Latest focused window info — used by the meeting detector (title carries the
 *  browser's "… Microphone recording …" in-call indicator, no AppleScript needed). */
export function getActiveWindowInfo(): { app: string; title: string; url: string } {
  return { app: currentApp, title: currentTitle, url: currentUrl };
}

async function tick(): Promise<void> {
  if (paused) return;
  try {
    const { activeWindow } = await import('get-windows');
    // CRITICAL: do NOT require the helper's own Screen-Recording / Accessibility
    // grant. The get-windows helper is a SEPARATE signed binary, and macOS ties
    // TCC permissions to the exact binary — every rebuild silently revokes the
    // grant (the same failure we hit with the Swift watcher). We only need the
    // frontmost app NAME here (NSWorkspace, no SR needed); the screenshot+OCR is
    // done by Electron, which holds the real Screen-Recording permission. This
    // keeps capture working with zero extra per-helper permission prompts.
    const w = await activeWindow({
      screenRecordingPermission: false,
      accessibilityPermission: false,
    });
    const app = w?.owner?.name;
    if (!app) {
      console.log('[focus] no active window');
      return;
    }
    currentApp = app;
    currentTitle = w?.title ? String(w.title) : '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    currentUrl = (w as any)?.url ? String((w as any).url) : '';
    console.log(`[focus] active: ${app}${currentTitle ? ` — ${currentTitle.slice(0, 50)}` : ''}`);
    // Focused-window bounds → which display to screenshot (multi-monitor: the
    // cursor may be on a different screen than the focused window).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = (w as any)?.bounds;
    const bounds =
      b && Number.isFinite(b.x)
        ? { x: b.x, y: b.y, width: b.width, height: b.height }
        : undefined;
    await extractObservationFromScreen({
      appName: app,
      windowTitle: w?.title ?? '',
      // get-windows resolves the URL for browsers — useful for web-app identity.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      url: (w as any)?.url ?? undefined,
      content: '',
      bounds,
    });
  } catch (e) {
    console.error('[focus] tick failed:', e);
  }
}

export function startFocusLoop(): void {
  if (timer) return;
  timer = setInterval(tick, 5000);
  tick();
  console.log('[focus] get-windows focus loop started');
}
