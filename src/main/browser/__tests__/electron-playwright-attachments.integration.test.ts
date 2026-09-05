/**
 * Production debugger-attachment lifecycle with only Electron's WebContents boundary replaced.
 * The test observes the CDP events that the real Playwright relay consumes.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  ElectronPlaywrightAttachments,
  type ElectronPlaywrightPageProvider,
  type RelayPage
} from '../electron-playwright-attachments'

class DebuggerBoundary extends EventEmitter {
  attached = false
  protocol: string | undefined

  isAttached(): boolean {
    return this.attached
  }

  attach(protocol: string): void {
    this.attached = true
    this.protocol = protocol
  }

  detach(): void {
    this.attached = false
  }
}

class ContentsBoundary extends EventEmitter {
  readonly debugger = new DebuggerBoundary()
  destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  getTitle(): string {
    return 'Research page'
  }

  getURL(): string {
    return 'https://example.com/research'
  }
}

describe('Electron Playwright attachment lifecycle', () => {
  it('publishes one target, routes child sessions, and releases a crashed native page', async () => {
    const contents = new ContentsBoundary()
    const page: RelayPage = { id: 7, contents: contents as unknown as WebContents }
    const provider: ElectronPlaywrightPageProvider = {
      pages: () => [page],
      create: vi.fn(),
      close: vi.fn()
    }
    const events: Array<Record<string, unknown>> = []
    const failures: Error[] = []
    const attachments = new ElectronPlaywrightAttachments(
      provider,
      async (event) => {
        events.push(event)
      },
      (error) => failures.push(error)
    )

    await attachments.sync()

    expect(contents.debugger.protocol).toBe('1.3')
    expect(attachments.targetId(7)).toBe('offgrid-target-7')
    expect(attachments.info(page)).toEqual({
      targetId: 'offgrid-target-7',
      type: 'page',
      title: 'Research page',
      url: 'https://example.com/research',
      browserContextId: 'offgrid-journey-context',
      attached: true,
      canAccessOpener: false
    })
    expect(events[0]).toMatchObject({
      method: 'Target.attachedToTarget',
      params: { sessionId: 'offgrid-page-7', waitingForDebugger: false }
    })

    contents.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child-session' })
    await Promise.resolve()
    expect(attachments.forSession('child-session')?.id).toBe(7)
    expect(events.at(-1)).toMatchObject({
      sessionId: 'offgrid-page-7',
      method: 'Target.attachedToTarget'
    })

    contents.debugger.emit(
      'message',
      {},
      'Runtime.consoleAPICalled',
      { type: 'log' },
      'child-session'
    )
    await Promise.resolve()
    expect(events.at(-1)).toMatchObject({
      sessionId: 'child-session',
      method: 'Runtime.consoleAPICalled'
    })

    contents.emit('unresponsive')
    await Promise.resolve()
    expect(contents.debugger.attached).toBe(false)
    expect(attachments.attachedPage(7)).toBeUndefined()
    expect(attachments.pages()).toEqual([])
    expect(events.at(-1)).toEqual({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'offgrid-page-7', targetId: 'offgrid-target-7' }
    })

    attachments.clear()
    expect(attachments.pages()).toEqual([page])
    expect(failures).toEqual([])
  })
})
