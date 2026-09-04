/**
 * What desktop supplies so shared can commit model settings: I/O, and nothing else.
 *
 * The rules that used to live here in pieces - which keys are launch arguments, when a change is
 * really a change, how many restarts one slider drag earns, which values publish to the other
 * devices - belong to shared now (`planModelSettingsCommit`, `createLaunchRestartCoordinator`).
 * This port reads the engine's committed record, persists one committed record per save, restarts
 * the engine once when asked, and hands portable changes to the sync hook. It validates nothing,
 * diffs nothing and decides nothing.
 *
 * The restart is a PLAIN effect on purpose - stop, then init. Supersession, the rule that a drag
 * can never leave the engine running arguments the user has moved past, is the coordinator's; a
 * copy of it here is exactly what made two owners of one rule.
 */
import type { EncodedModelSetting, ModelsSettingsPort } from '@offgrid/application'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from '../sync-mutation'
import { llm, type LlmSettings } from '../llm'

/** The committed record narrowed to the keys this save moved: one persist, no unrelated writes. */
export function committedSettingsPatch(
  settings: Readonly<Record<string, unknown>>,
  changed: readonly string[]
): LlmSettings {
  const patch: Record<string, unknown> = {}
  for (const key of changed) patch[key] = settings[key]
  return patch as LlmSettings
}

export function createDesktopModelSettingsPort(): ModelsSettingsPort {
  return {
    platform: 'desktop',
    // Synchronous by contract, and it can be: the engine holds the hydrated record in memory, so a
    // settings form never waits on SQLite to render what is committed.
    read: () => llm.getSettings() as Readonly<Record<string, unknown>>,
    /**
     * One persist per save.
     *
     * `emitSync: false` because publishing is the facade's job now, driven by the committed plan.
     * The engine's own desktop policy - pinning a launch field the user set explicitly, merging a
     * resource-mode preset over the fields they did not - stays where it belongs, inside the
     * engine, and runs on the committed values rather than on a draft.
     */
    write: async (settings, changed) => {
      await llm.setSettings(committedSettingsPatch(settings, changed), { emitSync: false })
    },
    restartEngine: () => llm.restartForLaunchSettings(),
    publish: async (mutations: readonly EncodedModelSetting[]) => {
      for (const setting of mutations) {
        emitSyncMutation({
          entity: CORE_SYNC_ENTITIES.modelSetting,
          entityId: setting.wireKey,
          kind: 'put',
          fields: { version: setting.version, value: JSON.parse(setting.valueJson) as unknown }
        })
      }
    }
  }
}
