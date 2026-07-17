import { describe, expect, it, vi } from 'vitest'
import { SYNC_PORTABLE_CHANNELS } from '../../shared/sync-portable-contract'
import { createSyncPortableApi } from '../sync-portable'

describe('createSyncPortableApi', () => {
  it('exposes the narrow namespaced IPC contract', async () => {
    const invoke = vi.fn().mockResolvedValue({ canceled: false })
    const api = createSyncPortableApi(invoke)

    await api.exportProject('project-1')
    await api.importPicker('replace-existing')

    expect(invoke).toHaveBeenNthCalledWith(1, SYNC_PORTABLE_CHANNELS.exportProject, 'project-1')
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      SYNC_PORTABLE_CHANNELS.importPicker,
      'replace-existing'
    )
    expect(api).not.toHaveProperty('importPath')
  })
})
