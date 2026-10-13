// SHARED VERBATIM with off-grid-ai/browser-extension src/shared/bridge/chat.ts. Change both.
// Shared bridge contract. Desktop owns execution; browsers read bounded event pages.
import type { AutomationTaskControlIntent as TaskControlIntent } from '@offgrid/automation'
export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}
export interface ChatStart {
  runId: string
  conversationId: string
  prompt: string
  mode: 'chat' | 'agent' | 'image'
  branch?: boolean | undefined
  /** Number of Desktop-stored user and assistant turns to keep before the prompt. */
  branchFrom?: number | undefined
  history?: ChatTurn[] | undefined
  pageText?: string | undefined
  page?: { title: string; url: string; text: string } | undefined
  imageDataUrl?: string | undefined
  tabId?: number | undefined
}
export interface ChatRead {
  runId: string
  conversationId: string
  cursor: number
  done: boolean
  events: unknown[]
  prompt?: string | undefined
  history?: ChatTurn[] | undefined
  tabId?: number | undefined
}
export type ChatRequest =
  | { action: 'start'; input: ChatStart }
  | { action: 'read'; runId: string; cursor: number }
  | { action: 'stop'; runId: string }
  | { action: 'control'; runId: string; intent: TaskControlIntent }
  | { action: 'guide'; runId: string; text: string }
  | { action: 'disconnect' }
  | { action: 'conversations' }

export const validChatId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v)
export const MAX_BRANCH_FROM = 10_000
export const MAX_HISTORY_TURNS = 160
export const MAX_TURN_CHARS = 20_000
export const MAX_PROMPT_CHARS = 20_000
export const MAX_PAGE_TEXT_CHARS = 100_000
export const MAX_PAGE_TITLE_CHARS = 500
export const MAX_PAGE_URL_CHARS = 2000
const object = (raw: unknown): Record<string, unknown> | null =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const prompt = (v: unknown): v is string => text(v, MAX_PROMPT_CHARS) && !!v.trim()
const optionalText = (v: unknown, max: number): boolean => v === undefined || text(v, max)
const tab = (v: unknown): boolean => v === undefined || (Number.isSafeInteger(v) && Number(v) >= 0)
function history(raw: unknown): ChatTurn[] | undefined | null {
  if (raw === undefined) {
    return undefined
  }
  if (!Array.isArray(raw) || raw.length > MAX_HISTORY_TURNS) {
    return null
  }
  const turns: ChatTurn[] = []
  for (const value of raw) {
    const t = object(value)
    if (!t || (t.role !== 'user' && t.role !== 'assistant') || !text(t.content, MAX_TURN_CHARS)) {
      return null
    }
    turns.push({ role: t.role, content: t.content })
  }
  return turns
}
function page(raw: unknown): ChatStart['page'] | null {
  if (raw === undefined) {
    return undefined
  }
  const p = object(raw)
  if (
    !p ||
    (Object.getPrototypeOf(p) !== Object.prototype && Object.getPrototypeOf(p) !== null) ||
    Reflect.ownKeys(p).length !== 3 ||
    !Object.hasOwn(p, 'title') ||
    !Object.hasOwn(p, 'url') ||
    !Object.hasOwn(p, 'text') ||
    !text(p.title, MAX_PAGE_TITLE_CHARS) ||
    !text(p.url, MAX_PAGE_URL_CHARS) ||
    !text(p.text, MAX_PAGE_TEXT_CHARS)
  ) {
    return null
  }
  try {
    const { protocol } = new URL(p.url)
    if (protocol !== 'http:' && protocol !== 'https:') {
      return null
    }
  } catch {
    return null
  }
  return { title: p.title, url: p.url, text: p.text }
}
export { page as parseChatPage }
function attachmentValid(r: Record<string, unknown>): boolean {
  if (!optionalText(r.pageText, MAX_PAGE_TEXT_CHARS) || !tab(r.tabId)) {
    return false
  }
  if (r.imageDataUrl === undefined) {
    return true
  }
  return (
    text(r.imageDataUrl, 2500000) &&
    /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(r.imageDataUrl)
  )
}
const branchFromValid = (v: unknown): boolean =>
  v === undefined || (Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= MAX_BRANCH_FROM)

export function parseChatStart(raw: unknown): ChatStart | null {
  const r = object(raw)
  if (!r || !validChatId(r.runId) || !validChatId(r.conversationId)) {
    return null
  }
  if (!prompt(r.prompt)) {
    return null
  }
  if (r.mode !== 'chat' && r.mode !== 'agent' && r.mode !== 'image') {
    return null
  }
  if (!branchFromValid(r.branchFrom)) {
    return null
  }
  const turns = history(r.history)
  const parsedPage = page(r.page)
  if (turns === null || parsedPage === null || !attachmentValid(r)) {
    return null
  }
  // AES-GCM plus base64 must still fit the bridge's 4 MB HTTP body limit.
  if (JSON.stringify(r).length > 2800000) {
    return null
  }
  return {
    runId: r.runId,
    conversationId: r.conversationId,
    prompt: r.prompt,
    mode: r.mode,
    branch: r.branch === true,
    branchFrom: r.branchFrom as number | undefined,
    history: turns,
    pageText: r.pageText as string | undefined,
    page: parsedPage,
    imageDataUrl: r.imageDataUrl as string | undefined,
    tabId: r.tabId as number | undefined
  }
}
export function parseChatRead(raw: unknown): ChatRead | null {
  const r = object(raw)
  if (!r || !validChatId(r.runId) || !validChatId(r.conversationId)) {
    return null
  }
  if (
    !Number.isSafeInteger(r.cursor) ||
    Number(r.cursor) < 0 ||
    typeof r.done !== 'boolean' ||
    !Array.isArray(r.events)
  ) {
    return null
  }
  const turns = history(r.history)
  if (turns === null || !optionalText(r.prompt, MAX_PROMPT_CHARS) || !tab(r.tabId)) {
    return null
  }
  return {
    runId: r.runId,
    conversationId: r.conversationId,
    cursor: Number(r.cursor),
    done: r.done,
    events: r.events,
    prompt: r.prompt as string | undefined,
    history: turns,
    tabId: r.tabId as number | undefined
  }
}
