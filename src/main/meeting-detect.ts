// Meeting auto-detection. Polls for a live call and tells the renderer, which
// surfaces a "Meeting detected — Record?" prompt (we never auto-record without a
// click — consent stays explicit). Signals, in order of reliability:
//   - Zoom: the `CptHost` process runs only while you're IN a Zoom meeting.
//   - Google Meet: the frontmost browser's active tab URL is meet.google.com
//     (via AppleScript; best-effort, may ask for Automation permission once).

import { exec } from 'child_process';
import { promisify } from 'util';
import { BrowserWindow } from 'electron';
import { getActiveWindowInfo } from './focus';

const execAsync = promisify(exec);

// Permission-free signal: the focused window's title/url. Browsers put their
// in-call indicator right in the window title ("… Microphone recording …",
// "… Camera and microphone recording …") and Meet/Teams encode the room in the
// title/url. This needs no AppleScript Automation grant and covers every browser.
function activeWindowMeeting(): 'zoom' | 'meet' | 'teams' | null {
  const { app, title, url } = getActiveWindowInfo();
  const hay = `${title} ${url}`.toLowerCase();
  if (/meet\.google\.com\/[a-z]/.test(hay) || /\bmeet\b.*[a-z]{3}-[a-z]{3,4}-[a-z]{3}/.test(hay)) return 'meet';
  if (/teams\.(microsoft|live)\.com.*(meetup-join|call|conv)/.test(hay)) return 'teams';
  if (/zoom\.us\/(j|wc)\//.test(hay) || /\bzoom meeting\b/.test(hay)) return 'zoom';
  // The browser's own recording indicator in the title — a tab is using the
  // mic/camera, i.e. you're in a live call. Only trust it for browsers.
  if (/(camera and microphone|microphone) recording/.test(hay) && /(chrome|brave|edge|arc|safari|firefox|browser)/i.test(app)) {
    return 'meet';
  }
  return null;
}

async function zoomInMeeting(): Promise<boolean> {
  try {
    await execAsync('pgrep -x CptHost');
    return true; // exits 0 only if the Zoom meeting process is running
  } catch {
    return false;
  }
}

// Scan EVERY tab of EVERY window — not just the frontmost active tab. A live
// Meet/Teams call stays open in a background tab while you work in another tab or
// app; checking only the active tab makes the call "disappear" the moment you
// switch away, which fragments one meeting into many short recordings.
const BROWSERS: { app: string; expr: string }[] = [
  { app: 'Google Chrome', expr: 'URL of every tab of every window' },
  { app: 'Brave Browser', expr: 'URL of every tab of every window' },
  { app: 'Arc', expr: 'URL of every tab of every window' },
  { app: 'Microsoft Edge', expr: 'URL of every tab of every window' },
  { app: 'Safari', expr: 'URL of every tab of every window' },
];

async function browserMeeting(): Promise<'meet' | 'teams' | null> {
  for (const b of BROWSERS) {
    try {
      const { stdout } = await execAsync(
        `osascript -e 'if application "${b.app}" is running then tell application "${b.app}" to get ${b.expr}'`,
        { timeout: 4000 }
      );
      if (/meet\.google\.com\/[a-z]/i.test(stdout)) return 'meet';
      if (/teams\.(microsoft|live)\.com.*(meetup-join|call|conv)/i.test(stdout)) return 'teams';
    } catch {
      /* app not running / not scriptable / permission denied — skip */
    }
  }
  return null;
}

async function teamsNativeInCall(): Promise<boolean> {
  // Teams desktop spawns a media/call helper while in a call.
  try {
    await execAsync("pgrep -if 'Teams.*(call|media)' >/dev/null || pgrep -x 'MSTeams' >/dev/null && false");
    return false;
  } catch {
    return false;
  }
}

async function detect(): Promise<{ active: boolean; platform: 'zoom' | 'meet' | 'teams' | null }> {
  if (await zoomInMeeting()) return { active: true, platform: 'zoom' };
  // Title/url heuristic first — instant, permission-free, covers the case the
  // user is actually looking at the call (which is when it starts).
  const t = activeWindowMeeting();
  if (t) return { active: true, platform: t };
  const b = await browserMeeting();
  if (b) return { active: true, platform: b };
  if (await teamsNativeInCall()) return { active: true, platform: 'teams' };
  return { active: false, platform: null };
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastActive = false;
let missStreak = 0;
// Don't end a meeting on a single negative poll — a tab switch, a transient
// AppleScript timeout, or a moment without the call in the front window would
// otherwise stop the recording and split one meeting into many. Require several
// consecutive misses (~50s at the 10s poll) before declaring the call over.
const END_GRACE_MISSES = 5;

export function startMeetingDetector(): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    try {
      const { active, platform } = await detect();
      if (active) {
        missStreak = 0;
        if (!lastActive) {
          lastActive = true;
          console.log(`[meeting-detect] ${platform} meeting detected`);
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('meeting:detected', platform));
        }
      } else if (lastActive) {
        missStreak += 1;
        if (missStreak >= END_GRACE_MISSES) {
          lastActive = false;
          missStreak = 0;
          console.log('[meeting-detect] meeting ended (grace exhausted)');
          BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('meeting:ended'));
        }
      }
    } catch {
      /* ignore */
    }
  };
  timer = setInterval(tick, 10_000);
  void tick();
  console.log('[meeting-detect] started');
}

/** True if a meeting is currently detected (for the renderer to query on mount). */
export async function meetingActive(): Promise<{ active: boolean; platform: 'zoom' | 'meet' | 'teams' | null }> {
  return detect();
}
