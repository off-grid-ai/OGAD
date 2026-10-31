// The one place task model roles change. The settings stores and the model inventory are real, in
// a temp profile; models are installed as their files, where a download puts them.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const profile = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => profile.dir, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { clearTaskRolesFor, setTaskRoleModel } from '../task-role-models'
import { setTaskRoleFromRequest } from '../task-role-requests'
import { getComputerUseSettings, setComputerUseSettings } from '../computer-use-settings'
import { getWebUseSettings, setWebUseSettings } from '../web-use-settings'
import { DECIDER_2B, desktopCatalog } from '../models-manager'
import { configureRuntime } from '../runtime-env'
import { llm } from '../llm'

profile.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-roles-'))
configureRuntime({ dataDir: profile.dir })

// One installed decision model, one installed grounding specialist, one grounding model not installed.
const decision = DECIDER_2B.id
let grounding: string
let notInstalled: string

beforeAll(async () => {
  const specialists = (await desktopCatalog()).filter(
    (model) => model.kind === 'computer_use' && !model.tags?.includes('Decision')
  )
  grounding = specialists[0]!.id
  notInstalled = specialists[1]!.id
  for (const model of [DECIDER_2B, specialists[0]!]) {
    for (const file of model.files) {
      const target = path.join(llm.getModelsDir(), file.name)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const bytes = Buffer.alloc(2048, 7)
      bytes.write('GGUF')
      fs.writeFileSync(target, bytes)
    }
  }
})

afterAll(() => {
  configureRuntime({ dataDir: undefined })
  fs.rmSync(profile.dir, { recursive: true, force: true })
})

beforeEach(() => {
  setComputerUseSettings({
    ...getComputerUseSettings(),
    groundingModelId: null,
    decisionModelId: null
  })
  setWebUseSettings({ ...getWebUseSettings(), decisionModelId: null })
})

describe('task model roles', () => {
  it('shares one grounding specialist, and keeps a decision model per task', () => {
    setTaskRoleModel('web_use', 'grounding', 'ui-tars')
    expect(getComputerUseSettings().groundingModelId).toBe('ui-tars')
    setTaskRoleModel('computer_use', 'decision', 'kev-4b')
    setTaskRoleModel('web_use', 'decision', 'jev')
    expect(getComputerUseSettings().decisionModelId).toBe('kev-4b')
    expect(getWebUseSettings().decisionModelId).toBe('jev')
  })

  it('clears every role a removed model held, and no other', () => {
    setTaskRoleModel('computer_use', 'grounding', 'ui-tars')
    setTaskRoleModel('computer_use', 'decision', 'jev')
    setTaskRoleModel('web_use', 'decision', 'jev')
    clearTaskRolesFor('jev')
    expect(getComputerUseSettings()).toMatchObject({
      groundingModelId: 'ui-tars',
      decisionModelId: null
    })
    expect(getWebUseSettings().decisionModelId).toBeNull()
  })

  it('sets a role asked for only when the request is complete and the model can fill it', async () => {
    expect(
      await setTaskRoleFromRequest({ task: 'web_use', role: 'decision', modelId: decision })
    ).toEqual({ success: true })
    expect(getWebUseSettings().decisionModelId).toBe(decision)
    // Review finding: any id was accepted. Now an unknown, uninstalled or wrong-role model is not.
    for (const bad of [
      { task: 'chat', role: 'decision', modelId: decision },
      { task: 'web_use', role: 'reasoner', modelId: decision },
      { task: 'web_use', role: 'decision', modelId: '' },
      { task: 'web_use', role: 'decision', modelId: grounding },
      { task: 'web_use', role: 'grounding', modelId: decision },
      { task: 'web_use', role: 'grounding', modelId: notInstalled },
      { task: 'web_use', role: 'grounding', modelId: 'made-up' }
    ]) {
      expect((await setTaskRoleFromRequest(bad)).success).toBe(false)
    }
    expect(getWebUseSettings().decisionModelId).toBe(decision)
    expect(getComputerUseSettings().groundingModelId).toBeNull()

    expect(
      await setTaskRoleFromRequest({ task: 'web_use', role: 'grounding', modelId: grounding })
    ).toEqual({ success: true })
    expect(getComputerUseSettings().groundingModelId).toBe(grounding)
  })
})
