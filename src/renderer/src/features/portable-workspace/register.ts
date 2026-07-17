import '@offgrid/design/tokens.css'
import '@offgrid/sync-desktop/styles.css'
import { IconArrowsExchange } from '@tabler/icons-react'
import { registerFeature } from '../../bootstrap/featureRegistry'
import { registerCoreSettingsSection } from '../../bootstrap/sectionRegistry'
import { WorkspaceTransferScreen, WorkspaceTransferSettings } from './views'

/** Registers the package-owned screen and settings section as one host feature. */
export function registerPortableWorkspace(): () => void {
  const unregisterFeature = registerFeature({
    route: 'workspace-transfer',
    label: 'Workspace transfer',
    icon: IconArrowsExchange,
    component: WorkspaceTransferScreen,
    order: 90
  })
  try {
    const unregisterSettings = registerCoreSettingsSection({
      id: 'workspace-transfer',
      component: WorkspaceTransferSettings,
      order: 90
    })
    return () => {
      unregisterSettings()
      unregisterFeature()
    }
  } catch (error) {
    unregisterFeature()
    throw error
  }
}
