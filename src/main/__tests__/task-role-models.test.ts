// The one place task model roles change. The settings stores are the boundary replaced.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  computer: { groundingModelId: null as string | null, decisionModelId: null as string | null },
  web: { decisionModelId: null as string | null }
}))
vi.mock('../computer-use-settings', () => ({
  getComputerUseSettings: () => ({ ...store.computer }),
  setComputerUseSettings: (next: typeof store.computer) => void (store.computer = next)
}))
// The model inventory: one installed decision model and one installed grounding specialist.
vi.mock('../models-manager', () => ({
  getCatalog: async () => ({
    kinds: [],
    models: [
      { id: 'jev', kind: 'computer_use', tags: ['Decision'] },
      { id: 'ui-tars', kind: 'computer_use', tags: [] },
      { id: 'not-installed', kind: 'computer_use', tags: [] }
    ]
  }),
  listInstalled: async () => ['jev', 'ui-tars']
}))
vi.mock('../web-use-settings', () => ({
  getWebUseSettings: () => ({ ...store.web }),
  setWebUseSettings: (next: typeof store.web) => void (store.web = next)
}))

import { clearTaskRolesFor, setTaskRoleModel } from '../task-role-models'
import { setTaskRoleFromRequest } from '../task-role-requests'

beforeEach(() => {
  store.computer = { groundingModelId: null, decisionModelId: null }
  store.web = { decisionModelId: null }
})

describe('task model roles', () => {
  it('shares one grounding specialist, and keeps a decision model per task', () => {
    setTaskRoleModel('web_use', 'grounding', 'ui-tars')
    expect(store.computer.groundingModelId).toBe('ui-tars')
    setTaskRoleModel('computer_use', 'decision', 'kev-4b')
    setTaskRoleModel('web_use', 'decision', 'jev')
    expect(store.computer.decisionModelId).toBe('kev-4b')
    expect(store.web.decisionModelId).toBe('jev')
  })

  it('clears every role a removed model held, and no other', () => {
    store.computer = { groundingModelId: 'ui-tars', decisionModelId: 'jev' }
    store.web = { decisionModelId: 'jev' }
    clearTaskRolesFor('jev')
    expect(store.computer).toEqual({ groundingModelId: 'ui-tars', decisionModelId: null })
    expect(store.web.decisionModelId).toBeNull()
  })

  it('sets a role asked for only when the request is complete and the model can fill it', async () => {
    expect(
      await setTaskRoleFromRequest({ task: 'web_use', role: 'decision', modelId: 'jev' })
    ).toEqual({ success: true })
    expect(store.web.decisionModelId).toBe('jev')
    // Review finding: any id was accepted. Now an unknown, uninstalled or wrong-role model is not.
    for (const bad of [
      { task: 'chat', role: 'decision', modelId: 'jev' },
      { task: 'web_use', role: 'reasoner', modelId: 'jev' },
      { task: 'web_use', role: 'decision', modelId: '' },
      { task: 'web_use', role: 'decision', modelId: 'ui-tars' },
      { task: 'web_use', role: 'grounding', modelId: 'jev' },
      { task: 'web_use', role: 'grounding', modelId: 'not-installed' },
      { task: 'web_use', role: 'grounding', modelId: 'made-up' }
    ]) {
      expect((await setTaskRoleFromRequest(bad)).success).toBe(false)
    }
    expect(store.web.decisionModelId).toBe('jev')
    expect(store.computer.groundingModelId).toBeNull()
  })
})
