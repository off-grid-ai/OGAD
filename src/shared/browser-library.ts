/**
 * What the built-in browser keeps for the person beyond the open pages: every visit (history),
 * bookmarks, downloads, and whether the Vault can sign in to the page. Shared by main, preload
 * and the browser chrome.
 */

/** One page visit. Task visits carry the task, so the agent can see where it has been. */
export interface BrowserVisit {
  visitId: number
  url: string
  title: string
  visitedAt: number
  /** Set when a Web Use task opened the page, not the person. */
  taskId?: string
}

export interface BrowserBookmark {
  bookmarkId: string
  url: string
  title: string
  createdAt: number
}

export type BrowserDownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

export interface BrowserDownload {
  downloadId: string
  url: string
  fileName: string
  /** Where the file is saved. Empty until the browser has picked a path. */
  savePath: string
  receivedBytes: number
  /** 0 when the site does not say. */
  totalBytes: number
  state: BrowserDownloadState
  paused: boolean
  startedAt: number
}

/** Whether the Vault can sign in to the page. It never carries a password. */
export type BrowserVaultState =
  | { state: 'unavailable' }
  | { state: 'locked' }
  | { state: 'none' }
  | { state: 'available'; logins: BrowserVaultLogin[] }

export interface BrowserVaultLogin {
  uuid: string
  title: string
  username: string
}

export type BrowserFillOutcome =
  | { ok: true; username: string }
  | { ok: false; reason: 'locked' | 'no_login' | 'no_form' | 'origin_mismatch' | 'unavailable' }

/** Commands the page's own keyboard shortcuts ask the browser chrome to show. */
export type BrowserChromeCommand = 'focus-address' | 'find' | 'history' | 'bookmarks' | 'downloads'

export interface BrowserFindResult {
  sessionId: string
  activeMatch: number
  matches: number
}

/** History search: newest first, at most this many rows per page. */
export const BROWSER_HISTORY_PAGE = 100
/** Visits older than this are dropped, the same window Chrome keeps. */
export const BROWSER_HISTORY_DAYS = 90
