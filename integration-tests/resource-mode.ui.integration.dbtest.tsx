// @vitest-environment jsdom

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { SetupPanel } from '../src/renderer/src/components/setup/SetupPanel'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-resource-mode-ui-'))
const previousDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = profile

vi.mock('electron', () => ({
  app: { getPath: () => profile, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('resource mode in Desktop setup', () => {
  it('keeps the old choice when saving to disk fails, then applies the new choice', async () => {
    const { llm } = await import('../src/main/llm')
    llm.pause()
    const modeBefore = llm.getSettings().performanceMode
    if (modeBefore !== 'balanced') throw new Error(`Expected a fresh profile, got ${modeBefore}`)
    const planModes: string[] = []

    // Electron IPC and the file system are external boundaries. The rendered setup
    // panel and LLM settings owner both run their production code.
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        setupPlan: async (mode: string) => {
          planModes.push(mode)
          return {
            mode, ramGb: 16, totalDownloadGb: 0,
            items: [{ kind: 'chat', capability: 'Chat', id: 'local-chat', name: 'Local Chat',
              sizeGb: 1, installed: true, required: true }]
          }
        },
        setLlmSettings: async (settings: { performanceMode: 'balanced' | 'conservative' | 'extreme' }) =>
          llm.setSettings(settings),
        getLlmSettings: async () => llm.getSettings(),
        onSetupProgress: () => () => {},
        autoConfigure: async () => ({ success: true }),
        cancelModelDownload: async () => true
      }
    })
    const user = userEvent.setup()
    render(<SetupPanel hideHealth />)
    expect(await screen.findByText('Local Chat')).toBeTruthy()

    // A directory at the destination makes the real atomic rename fail.
    const settingsFile = path.join(profile, 'models', 'llm-settings.json')
    fs.mkdirSync(settingsFile, { recursive: true })
    await user.click(screen.getByRole('button', { name: 'Conservative' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Balanced' }).getAttribute('aria-pressed')).toBe('true'))
    expect(llm.getSettings().performanceMode).toBe('balanced')
    expect(planModes.at(-1)).toBe('balanced')

    fs.rmdirSync(settingsFile)
    await user.click(screen.getByRole('button', { name: 'Conservative' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Conservative' }).getAttribute('aria-pressed')).toBe('true'))
    expect(llm.getSettings().performanceMode).toBe('conservative')
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).performanceMode).toBe('conservative')
  })
})
