// Loads the private pro package's RENDERER features, if present. In the free
// build the Vite alias resolves `@offgrid/pro/renderer` to proStub (default
// null), so activateRenderer is absent and this is a no-op.

import { registerScreen } from './screenRegistry';
import { registerNav } from './navRegistry';
import { registerSlot } from './slotRegistry';
import { registerSettingsSection } from './sectionRegistry';
import { registerHook } from './hookRegistry';

export interface ProRendererApi {
  registerScreen: typeof registerScreen;
  registerNav: typeof registerNav;
  registerSlot: typeof registerSlot;
  registerSettingsSection: typeof registerSettingsSection;
  registerHook: typeof registerHook;
}

export async function loadProFeaturesRenderer(): Promise<void> {
  let pro: unknown;
  try {
    pro = await import('@offgrid/pro/renderer');
  } catch {
    return; // free / contributor build
  }
  const activateRenderer = (pro as { activateRenderer?: (api: ProRendererApi) => void })?.activateRenderer;
  if (typeof activateRenderer !== 'function') return; // stub resolved to null
  try {
    activateRenderer({ registerScreen, registerNav, registerSlot, registerSettingsSection, registerHook });
    console.log('[pro] renderer features activated');
  } catch (e) {
    console.error('[pro] activateRenderer failed', e);
  }
}
