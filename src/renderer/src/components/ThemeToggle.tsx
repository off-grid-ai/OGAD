import { useState } from 'react';
import { Sun, Moon, Monitor } from '@phosphor-icons/react';
import { getThemeMode, setThemeMode, type ThemeMode } from '../theme';

// Always-visible theme switch (system -> light -> dark -> system). Fixed
// top-right so it works on every screen (onboarding, setup, models, app).
const ORDER: ThemeMode[] = ['system', 'light', 'dark'];
const ICON = { system: Monitor, light: Sun, dark: Moon };
const LABEL = { system: 'System', light: 'Light', dark: 'Dark' };

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(getThemeMode());
  const Icon = ICON[mode];

  const cycle = (): void => {
    const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    setThemeMode(next);
    setMode(next);
  };

  return (
    <button
      onClick={cycle}
      title={`Theme: ${LABEL[mode]} (click to change)`}
      className="fixed bottom-4 right-4 z-[100] flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900/70 px-2.5 py-1.5 text-xs text-neutral-400 shadow-lg backdrop-blur-md transition-colors hover:border-green-500 hover:text-green-500"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <Icon className="h-3.5 w-3.5" />
      {LABEL[mode]}
    </button>
  );
}
