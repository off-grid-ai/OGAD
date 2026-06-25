import type { ComponentType } from 'react';

// Component-slot seam. Pro registers UI components into named slots inside core
// screens during activation; core renders whatever is registered and renders its
// own fallback (or nothing) when a slot is empty. Lets pro inject UI into core
// screens without core importing pro. Mirrors mobile/src/bootstrap/slotRegistry.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const slots: Record<string, ComponentType<any>> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerSlot(name: string, component: ComponentType<any>): void {
  slots[name] = component;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSlot(name: string): ComponentType<any> | undefined {
  return slots[name];
}

/** Known slot names, centralised so core and pro stay in sync. */
export const SLOTS = {
  /** Extra row(s) in the chat composer tool menu (e.g. the Connectors toggle). */
  composerToolMenu: 'composer.toolMenu',
  /** Always-mounted root component(s) near the app root (e.g. capture indicator). */
  appRoot: 'app.root',
} as const;
