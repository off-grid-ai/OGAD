// Loads the private pro package's MAIN-process features, if present. In the free
// build the Vite alias resolves `@offgrid/pro/main` to proStub (default null),
// so activateMain is absent and this is a no-op. Mirrors
// mobile/src/bootstrap/loadProFeatures.ts.

import { getDB, runMigration } from '../database';
import { llm } from '../llm';
import { registerHook } from './hookRegistry';
import { registerToolExtension } from '../tools';

// What the pro main entry receives. Pro registers IPC handlers + intervals +
// tool extensions itself, using these core helpers (no core→pro imports).
export interface ProMainApi {
  getDB: typeof getDB;
  runMigration: typeof runMigration;
  llm: typeof llm;
  registerHook: typeof registerHook;
  registerToolExtension: typeof registerToolExtension;
}

export async function loadProFeaturesMain(): Promise<void> {
  let pro: unknown;
  try {
    pro = await import('@offgrid/pro/main');
  } catch {
    return; // free / contributor build: package not present
  }
  const activateMain = (pro as { activateMain?: (api: ProMainApi) => void | Promise<void> })?.activateMain;
  if (typeof activateMain !== 'function') return; // stub resolved to null
  try {
    await activateMain({ getDB, runMigration, llm, registerHook, registerToolExtension });
    console.log('[pro] main features activated');
  } catch (e) {
    console.error('[pro] activateMain failed', e);
  }
}
