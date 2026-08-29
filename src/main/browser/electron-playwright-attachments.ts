import type { WebContents } from 'electron'
import type { CdpEvent } from './electron-playwright-relay-protocol'

export interface RelayPage {
  id: number
  contents: WebContents
}

export interface ElectronPlaywrightPageProvider {
  pages(): readonly RelayPage[]
  create(url: string): Promise<RelayPage>
  close(id: number): Promise<void>
}

export interface AttachedPage extends RelayPage {
  sessionId: string
  targetId: string
  childSessions: Set<string>
}

/** Own debugger attachment, target identity, and native listener cleanup. */
export class ElectronPlaywrightAttachments {
  private readonly attached = new Map<number, AttachedPage & { release: () => void }>()
  private readonly crashed = new Set<number>()

  constructor(
    private readonly provider: ElectronPlaywrightPageProvider,
    private readonly publish: (event: CdpEvent) => Promise<void>,
    private readonly onFailure: (error: Error) => void
  ) {}

  pages(): RelayPage[] {
    return this.provider
      .pages()
      .filter((page) => !page.contents.isDestroyed() && !this.crashed.has(page.id))
  }

  async sync(): Promise<void> {
    const current = new Map(this.pages().map((page) => [page.id, page]))
    for (const page of current.values()) {
      if (!this.attached.has(page.id)) await this.attach(page)
    }
    for (const page of [...this.attached.values()]) {
      if (!current.has(page.id) || page.contents.isDestroyed()) this.detach(page.id)
    }
  }

  async attach(page: RelayPage): Promise<void> {
    if (page.contents.isDestroyed() || this.crashed.has(page.id) || this.attached.has(page.id))
      return
    const debuggerApi = page.contents.debugger
    const ownsDebugger = !debuggerApi.isAttached()
    if (ownsDebugger) debuggerApi.attach('1.3')
    const attached: AttachedPage & { release: () => void } = {
      ...page,
      sessionId: `offgrid-page-${page.id}`,
      targetId: targetId(page.id),
      childSessions: new Set(),
      release: () => undefined
    }
    type DebuggerMessage = [Electron.Event, string, unknown, string?]
    const onMessage = (...[_event, method, params, childSessionId]: DebuggerMessage): void => {
      const nestedId = nestedSession(method, params)
      if (method === 'Target.attachedToTarget' && nestedId) attached.childSessions.add(nestedId)
      if (method === 'Target.detachedFromTarget' && nestedId)
        attached.childSessions.delete(nestedId)
      void this.publish({ sessionId: childSessionId ?? attached.sessionId, method, params }).catch(
        this.onFailure
      )
    }
    const onDestroyed = (): void => this.detach(page.id)
    const onDetached = (): void => this.detach(page.id)
    const onFailed = (): void => {
      this.crashed.add(page.id)
      this.detach(page.id)
    }
    debuggerApi.on('message', onMessage)
    debuggerApi.once('detach', onDetached)
    page.contents.once('destroyed', onDestroyed)
    page.contents.once('render-process-gone', onFailed)
    page.contents.once('unresponsive', onFailed)
    attached.release = () => {
      debuggerApi.off('message', onMessage)
      debuggerApi.off('detach', onDetached)
      page.contents.off('destroyed', onDestroyed)
      page.contents.off('render-process-gone', onFailed)
      page.contents.off('unresponsive', onFailed)
      if (ownsDebugger && debuggerApi.isAttached()) debuggerApi.detach()
    }
    this.attached.set(page.id, attached)
    try {
      await this.publish({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: attached.sessionId,
          targetInfo: this.info(attached),
          waitingForDebugger: false
        }
      })
    } catch (error) {
      this.detach(page.id)
      throw error
    }
  }

  detach(id: number): void {
    const page = this.attached.get(id)
    if (!page) return
    this.attached.delete(id)
    page.release()
    void this.publish({
      method: 'Target.detachedFromTarget',
      params: { sessionId: page.sessionId, targetId: page.targetId }
    }).catch(this.onFailure)
  }

  clear(): void {
    for (const page of [...this.attached.values()]) this.detach(page.id)
    this.crashed.clear()
  }

  forTarget(id: string): RelayPage | undefined {
    return this.pages().find((page) => targetId(page.id) === id)
  }

  forSession(id: string): AttachedPage | undefined {
    return [...this.attached.values()].find(
      (page) => page.sessionId === id || page.childSessions.has(id)
    )
  }

  attachedPage(id: number): AttachedPage | undefined {
    return this.attached.get(id)
  }

  targetId(id: number): string {
    return targetId(id)
  }

  info(page: RelayPage): Record<string, unknown> {
    return {
      targetId: targetId(page.id),
      type: 'page',
      title: page.contents.getTitle(),
      url: page.contents.getURL() || 'about:blank',
      attached: this.attached.has(page.id),
      canAccessOpener: false
    }
  }
}

function targetId(id: number): string {
  return `offgrid-target-${id}`
}

function nestedSession(method: string, params: unknown): string | undefined {
  if (method !== 'Target.attachedToTarget' && method !== 'Target.detachedFromTarget')
    return undefined
  if (typeof params !== 'object' || params === null) return undefined
  const value = (params as { sessionId?: unknown }).sessionId
  return typeof value === 'string' ? value : undefined
}
