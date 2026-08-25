import type {
  BrowserChromeState,
  BrowserSessionKind,
  BrowserSessionsSnapshot,
  BrowserTaskPointer
} from '../../shared/browser-session'

export interface BrowserSessionRecord<Resource> {
  sessionId: string
  historyId?: string
  kind: BrowserSessionKind
  resource: Resource
  chrome: BrowserChromeState
  task?: BrowserTaskPointer
}

const EMPTY_CHROME: BrowserChromeState = {
  url: '',
  title: 'New tab',
  canGoBack: false,
  canGoForward: false,
  isLoading: false
}

/**
 * Owns browser-session identity and selection. Electron resources remain opaque
 * so the complete tab lifecycle can be proved without starting Electron.
 */
export class BrowserSessionStore<Resource> {
  private readonly records = new Map<string, BrowserSessionRecord<Resource>>()
  private activeId: string | null = null

  create(input: {
    sessionId: string
    historyId?: string
    kind: BrowserSessionKind
    resource: Resource
    task?: BrowserTaskPointer
  }): BrowserSessionRecord<Resource> {
    if (this.records.has(input.sessionId)) {
      throw new Error(`Browser session already exists: ${input.sessionId}`)
    }
    const record: BrowserSessionRecord<Resource> = {
      ...input,
      chrome: { ...EMPTY_CHROME }
    }
    this.records.set(record.sessionId, record)
    this.activeId = record.sessionId
    return record
  }

  get(sessionId: string): BrowserSessionRecord<Resource> | undefined {
    return this.records.get(sessionId)
  }

  get active(): BrowserSessionRecord<Resource> | undefined {
    return this.activeId ? this.records.get(this.activeId) : undefined
  }

  findTask(taskId: string): BrowserSessionRecord<Resource> | undefined {
    for (const record of this.records.values()) {
      if (record.task?.taskId === taskId) return record
    }
    return undefined
  }

  activate(sessionId: string): boolean {
    if (!this.records.has(sessionId)) return false
    this.activeId = sessionId
    return true
  }

  deactivate(sessionId: string): boolean {
    if (!this.records.has(sessionId)) return false
    if (this.activeId === sessionId) this.activeId = null
    return true
  }

  updateChrome(sessionId: string, chrome: BrowserChromeState): boolean {
    const record = this.records.get(sessionId)
    if (!record) return false
    record.chrome = { ...chrome }
    return true
  }

  updateTask(sessionId: string, task: BrowserTaskPointer): boolean {
    const record = this.records.get(sessionId)
    if (!record || record.kind !== 'task') return false
    record.task = { ...task, steps: [...task.steps] }
    return true
  }

  close(sessionId: string): BrowserSessionRecord<Resource> | undefined {
    const record = this.records.get(sessionId)
    if (!record) return undefined
    this.records.delete(sessionId)
    if (this.activeId === sessionId) {
      this.activeId = [...this.records.keys()].at(-1) ?? null
    }
    return record
  }

  clear(): BrowserSessionRecord<Resource>[] {
    const records = [...this.records.values()]
    this.records.clear()
    this.activeId = null
    return records
  }

  snapshot(): BrowserSessionsSnapshot {
    return {
      activeSessionId: this.activeId,
      sessions: [...this.records.values()].map((record) => ({
        sessionId: record.sessionId,
        historyId: record.historyId,
        kind: record.kind,
        taskId: record.task?.taskId,
        status: record.task?.status ?? 'open',
        ...record.chrome
      }))
    }
  }
}
