import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronBoundary = vi.hoisted(() => ({
  appData: '',
  setName: vi.fn(),
  setPath: vi.fn(),
  exit: vi.fn(),
  getPath: vi.fn((name: string) => {
    if (name !== 'appData') throw new Error(`Unexpected Electron path: ${name}`)
    return electronBoundary.appData
  })
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: electronBoundary.getPath,
    setName: electronBoundary.setName,
    setPath: electronBoundary.setPath,
    exit: electronBoundary.exit
  }
}))

let root = ''
const originalOverride = process.env.OFFGRID_USER_DATA

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-user-data-'))
  electronBoundary.appData = root
  delete process.env.OFFGRID_USER_DATA
})

afterEach(() => {
  if (originalOverride === undefined) delete process.env.OFFGRID_USER_DATA
  else process.env.OFFGRID_USER_DATA = originalOverride
  fs.rmSync(root, { recursive: true, force: true })
})

describe('user-data bootstrap', () => {
  it('uses an explicit profile and restores the visible product name', async () => {
    const profile = path.join(root, 'explicit-profile')
    process.env.OFFGRID_USER_DATA = profile

    const bootstrap = await import('../bootstrap/user-data')

    expect(fs.statSync(profile).isDirectory()).toBe(true)
    expect(electronBoundary.setPath).toHaveBeenCalledWith('userData', profile)
    bootstrap.restoreCanonicalProductName()
    expect(electronBoundary.setName).toHaveBeenLastCalledWith('Off Grid AI Desktop')
  })

  it('moves legacy model and database data into the canonical profile', async () => {
    const legacyModels = path.join(root, 'My Memories', 'models')
    const legacyDatabase = path.join(root, 'my-memories', 'memories.db')
    fs.mkdirSync(legacyModels, { recursive: true })
    fs.mkdirSync(path.dirname(legacyDatabase), { recursive: true })
    fs.writeFileSync(path.join(legacyModels, 'model.gguf'), 'model')
    fs.writeFileSync(legacyDatabase, 'database')

    await import('../bootstrap/user-data')

    const canonical = path.join(root, 'Off Grid AI Desktop')
    expect(fs.readFileSync(path.join(canonical, 'models', 'model.gguf'), 'utf8')).toBe('model')
    expect(fs.readFileSync(path.join(canonical, 'memories.db'), 'utf8')).toBe('database')
    expect(electronBoundary.setPath).toHaveBeenCalledWith('userData', canonical)
  })
})
