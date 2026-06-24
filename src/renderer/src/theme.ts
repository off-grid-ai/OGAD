// Theme controller (dark default, like Off Grid Mobile). Resolves a stored
// system/light/dark preference against the OS scheme and applies it as
// data-theme on <html>, which flips the --og-* tokens. Mirrors @offgrid/ui's
// resolveTheme; kept inline here so the renderer has no extra dep.

export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'og-theme';

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

export function getThemeMode(): ThemeMode {
  const v = localStorage.getItem(KEY) as ThemeMode | null;
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

export function applyTheme(): void {
  document.documentElement.dataset.theme = resolveTheme(getThemeMode());
}

export function setThemeMode(mode: ThemeMode): void {
  localStorage.setItem(KEY, mode);
  applyTheme();
}

/** Cycle dark -> light -> system, for a quick toggle. */
export function cycleThemeMode(): ThemeMode {
  const next: ThemeMode =
    getThemeMode() === 'dark' ? 'light' : getThemeMode() === 'light' ? 'system' : 'dark';
  setThemeMode(next);
  return next;
}

// Re-apply when the OS scheme changes and we are following it.
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getThemeMode() === 'system') applyTheme();
});

// Expose for a temporary toggle / verification until the Settings UI lands.
declare global {
  interface Window {
    ogTheme: { get: typeof getThemeMode; set: typeof setThemeMode; cycle: typeof cycleThemeMode };
  }
}
window.ogTheme = { get: getThemeMode, set: setThemeMode, cycle: cycleThemeMode };
