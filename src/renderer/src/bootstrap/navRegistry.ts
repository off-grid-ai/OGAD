import type { ComponentType } from 'react';

// Navigation seam. Pro registers sidebar nav entries during activation; App.tsx
// renders core items + registered items in order. Each entry points at a route
// name that a registered screen (screenRegistry) renders.
//
// Note: the FREE build also shows pro entries — sourced from the static pro
// catalog (see components/pro/proCatalog.ts) — as locked upsell items. This
// registry is only populated when the pro package is actually activated, so a
// route present here = unlocked.

export interface NavEntry {
  /** Route name, matches a RegisteredScreen.name. */
  route: string;
  /** Sidebar label. */
  label: string;
  /** Phosphor icon component. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: ComponentType<any>;
  /** Lower sorts first; core items use 0..99, pro items 100+. */
  order?: number;
}

const entries: NavEntry[] = [];

export function registerNav(entry: NavEntry): void {
  if (!entries.some((e) => e.route === entry.route)) entries.push(entry);
}

export function getRegisteredNav(): NavEntry[] {
  return [...entries].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/** True once the pro package has registered at least one screen — used by the
 *  shell to decide between rendering the real screen vs the upgrade teaser. */
export function isProActive(): boolean {
  return entries.length > 0;
}
