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
  journeyId?: string
  parentSessionId?: string
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
    journeyId?: string
    parentSessionId?: string
    resource: Resource
    task?: BrowserTaskPointer
  }): BrowserSessionRecord<Resource> {
    if (this.records.has(input.sessionId)) {
      throw new Error(`Browser session already exists: ${input.sessionId}`)
    }
    const record: BrowserSessionRecord<Resource> = {
      ...input,
      task: input.task ? { ...input.task, steps: [...input.task.steps] } : undefined,
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

  /** A chat journey owns one browser workspace. Prefer its active page, then
   * its root page. Child pages remain available without changing identity. */
  findJourney(journeyId: string): BrowserSessionRecord<Resource> | undefined {
    const active = this.active
    if (active?.journeyId === journeyId) return active
    for (const record of this.records.values()) {
      if (record.journeyId === journeyId && !record.parentSessionId) return record
    }
    return undefined
  }

  /** Every page that belongs to one chat journey, in creation order. */
  journeyRecords(journeyId: string): readonly BrowserSessionRecord<Resource>[] {
    return [...this.records.values()].filter((record) => record.journeyId === journeyId)
  }

  updateJourneyTask(journeyId: string, task: BrowserTaskPointer): number {
    let updated = 0
    for (const record of this.records.values()) {
      if (record.kind !== 'task' || record.journeyId !== journeyId) continue
      record.task = { ...task, steps: [...task.steps] }
      updated += 1
    }
    return updated
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
        journeyId: record.journeyId,
        parentSessionId: record.parentSessionId,
        taskId: record.task?.taskId,
        status: record.task?.status ?? 'open',
        ...record.chrome
      }))
    }
  }
}
