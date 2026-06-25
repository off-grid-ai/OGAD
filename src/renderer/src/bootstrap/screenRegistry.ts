import type { ComponentType } from 'react';

// Screen seam. Pro registers full screens (route name → component) during
// activation; App.tsx renders core screens + whatever is registered. Free build
// registers nothing. Mirrors mobile/src/navigation/screenRegistry.ts.

export interface RegisteredScreen {
  /** Route name, e.g. 'day', 'entities', 'connectors'. */
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
}

const screens: RegisteredScreen[] = [];

export function registerScreen(screen: RegisteredScreen): void {
  if (!screens.some((s) => s.name === screen.name)) screens.push(screen);
}

export function getRegisteredScreen(name: string): RegisteredScreen | undefined {
  return screens.find((s) => s.name === name);
}

export function getRegisteredScreens(): RegisteredScreen[] {
  return screens;
}
