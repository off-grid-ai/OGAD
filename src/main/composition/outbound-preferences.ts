import { OutboundPreferenceApplication } from '@offgrid/sync'
import type {
  OutboundPreferenceEffectsPort,
  OutboundPreferencePersistencePort
} from '@offgrid/sync'

/** The Desktop composition root is the only constructor of the Shared preference coordinator. */
export const createDesktopOutboundPreferenceApplication = (
  persistence: OutboundPreferencePersistencePort,
  effects: OutboundPreferenceEffectsPort
): OutboundPreferenceApplication => new OutboundPreferenceApplication(persistence, effects)
