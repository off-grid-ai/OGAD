import {
  PortableWorkspaceScreen,
  PortableWorkspaceSettingsSection,
  PortableWorkspaceUiController
} from '@offgrid/sync-desktop'
import { portableWorkspaceHost } from './host'

const controller = new PortableWorkspaceUiController(portableWorkspaceHost)

export function WorkspaceTransferScreen(): React.ReactElement {
  return <PortableWorkspaceScreen controller={controller} />
}

export function WorkspaceTransferSettings(): React.ReactElement {
  return <PortableWorkspaceSettingsSection controller={controller} />
}
