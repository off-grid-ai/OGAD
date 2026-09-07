/**
 * Artifact previews through the production Electron IPC boundary and real preview owner. Electron
 * WebContents is the only external-process fake; URL ownership, serving, CSP, and revocation stay real.
 */
import { describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: { sender: RendererBoundary }, ...args: unknown[]) => unknown

interface RendererBoundary {
  id: number
  once(event: 'destroyed', listener: () => void): void
}

const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler)
  }
}))

const { setupArtifactPreviewIpc } = await import('../artifact-preview-ipc')
const { serveArtifactPreview } = await import('../artifact-preview')

function renderer(id: number): RendererBoundary & { destroy(): void; subscriptions(): number } {
  const destroyed = new Set<() => void>()
  return {
    id,
    once: (_event, listener) => destroyed.add(listener),
    destroy: () => {
      for (const listener of destroyed) listener()
      destroyed.clear()
    },
    subscriptions: () => destroyed.size
  }
}

function invoke(channel: string, sender: RendererBoundary, ...args: unknown[]): unknown {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`IPC handler ${channel} was not registered.`)
  return handler({ sender }, ...args)
}

describe('artifact preview lifecycle through Desktop IPC', () => {
  it('serves only live renderer-owned previews and revokes all previews when their owner exits', async () => {
    setupArtifactPreviewIpc()
    const firstRenderer = renderer(101)
    const secondRenderer = renderer(202)

    const firstUrl = invoke(
      'artifacts:preview:create',
      firstRenderer,
      '<main>Private release plan</main>'
    ) as string
    const siblingUrl = invoke(
      'artifacts:preview:create',
      firstRenderer,
      '<main>Second artifact</main>'
    ) as string
    const otherUrl = invoke(
      'artifacts:preview:create',
      secondRenderer,
      '<main>Other renderer</main>'
    ) as string

    expect(firstRenderer.subscriptions()).toBe(1)
    const served = serveArtifactPreview(firstUrl)
    expect(served.status).toBe(200)
    await expect(served.text()).resolves.toBe('<main>Private release plan</main>')
    expect(served.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(invoke('artifacts:preview:revoke', secondRenderer, firstUrl)).toBe(false)

    expect(invoke('artifacts:preview:revoke', firstRenderer, firstUrl)).toBe(true)
    expect(serveArtifactPreview(firstUrl).status).toBe(404)

    firstRenderer.destroy()
    expect(serveArtifactPreview(siblingUrl).status).toBe(404)
    expect(serveArtifactPreview(otherUrl).status).toBe(200)

    secondRenderer.destroy()
    expect(serveArtifactPreview(otherUrl).status).toBe(404)
  })
})
