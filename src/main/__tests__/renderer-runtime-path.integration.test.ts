import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const runtimeBoundary = vi.hoisted(() => ({
  appPath: '/Applications/Off Grid AI Desktop.app/Contents/Resources/app.asar',
  checkedPaths: [] as string[]
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => runtimeBoundary.appPath
  }
}))

vi.mock('node:fs', () => ({
  existsSync: (candidate: string) => {
    runtimeBoundary.checkedPaths.push(candidate)
    return true
  }
}))

describe('Desktop renderer runtime path boundary', () => {
  it('resolves and diagnoses the renderer from the real Electron application root', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { rendererHtmlPath } = await import('../renderer-path')
    const expected = path.join(runtimeBoundary.appPath, 'out', 'renderer', 'index.html')

    expect(rendererHtmlPath()).toBe(expected)
    expect(runtimeBoundary.checkedPaths).toEqual([expected])
    expect(log).toHaveBeenCalledWith(
      `[renderer] ${JSON.stringify({
        event: 'path-resolved',
        appPath: runtimeBoundary.appPath,
        resolved: expected,
        exists: true
      })}`
    )

    log.mockRestore()
  })
})
