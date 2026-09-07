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

vi.mock('fs', () => ({
  existsSync: (candidate: string) => {
    runtimeBoundary.checkedPaths.push(candidate)
    return true
  }
}))

describe('Desktop preload path boundary', () => {
  it('resolves and diagnoses the built preload from the real Electron application root', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { preloadPath } = await import('../preload-path')
    const expected = path.join(runtimeBoundary.appPath, 'out', 'preload', 'index.js')

    expect(preloadPath()).toBe(expected)
    expect(runtimeBoundary.checkedPaths).toEqual([expected])
    expect(log).toHaveBeenCalledWith(
      `[preload] ${JSON.stringify({
        event: 'path-resolved',
        appPath: runtimeBoundary.appPath,
        resolved: expected,
        exists: true
      })}`
    )

    log.mockRestore()
  })
})
