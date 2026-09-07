// Off Grid AI design tokens, shared across desktop (my-memories), mobile, and sync.
// Mirrors the canonical React Native tokens in:
//   mobile/src/theme/palettes.ts        (COLORS_LIGHT / COLORS_DARK)
//   mobile/src/constants/index.ts       (TYPOGRAPHY / SPACING / FONTS)
// Keep these values in lockstep with the mobile source of truth.
// The matching CSS variables live in ./tokens.css and the Tailwind mapping
// in ../tailwind-preset.js.

export const COLORS_LIGHT = {
  primary: '#059669',
  primaryDark: '#047857',
  primaryLight: '#34D399',

  background: '#FFFFFF',
  surface: '#F5F5F5',
  surfaceLight: '#EBEBEB',
  surfaceHover: '#E0E0E0',

  text: '#0A0A0A',
  textSecondary: '#525252',
  textMuted: '#8A8A8A',
  textDisabled: '#BFBFBF',

  border: '#E5E5E5',
  borderLight: '#D4D4D4',
  borderFocus: '#059669',

  success: '#525252',
  warning: '#0A0A0A',
  error: '#DC2626',
  trending: '#D97706',
  errorBackground: 'rgba(220, 38, 38, 0.10)',
  info: '#525252',

  overlay: 'rgba(0, 0, 0, 0.4)',
  divider: '#EBEBEB'
} as const

export const COLORS_DARK = {
  primary: '#34D399',
  primaryDark: '#10B981',
  primaryLight: '#6EE7B7',

  background: '#0A0A0A',
  surface: '#141414',
  surfaceLight: '#1E1E1E',
  surfaceHover: '#252525',

  text: '#FFFFFF',
  textSecondary: '#B0B0B0',
  textMuted: '#808080',
  textDisabled: '#4A4A4A',

  border: '#1E1E1E',
  borderLight: '#2A2A2A',
  borderFocus: '#34D399',

  success: '#B0B0B0',
  warning: '#FFFFFF',
  error: '#C75050',
  trending: '#F59E0B',
  errorBackground: 'rgba(239, 68, 68, 0.15)',
  info: '#B0B0B0',

  overlay: 'rgba(0, 0, 0, 0.7)',
  divider: '#1A1A1A'
} as const

export type ThemeColors = typeof COLORS_LIGHT
export type ColorToken = keyof ThemeColors

// Monospace font stack. Menlo is the canonical Off Grid AI face; the rest are
// graceful fallbacks for non-macOS web environments.
export const FONT_MONO =
  "'Menlo', ui-monospace, SFMono-Regular, 'SF Mono', Consolas, 'Liberation Mono', monospace"

export const FONTS = {
  mono: 'Menlo'
} as const

// Spacing scale in pixels (mobile/src/constants/index.ts SPACING).
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32
} as const

export type SpacingToken = keyof typeof SPACING

// Single accent radius. The design guide favours crisp, sharp edges; 8px is
// the standard control radius, 2px for inline code and chips.
export const RADIUS = {
  sm: 2,
  md: 8
} as const

// Typography scale (mobile/src/constants/index.ts TYPOGRAPHY). Sizes in px,
// weights as numeric strings to match the RN tokens. Weights stay <= 400.
export const TYPOGRAPHY = {
  display: { fontSize: 22, fontFamily: FONTS.mono, fontWeight: '200', letterSpacing: -0.5 },
  h1: { fontSize: 24, fontFamily: FONTS.mono, fontWeight: '300', letterSpacing: -0.5 },
  h2: { fontSize: 16, fontFamily: FONTS.mono, fontWeight: '400', letterSpacing: -0.2 },
  h3: { fontSize: 13, fontFamily: FONTS.mono, fontWeight: '400', letterSpacing: -0.2 },
  body: { fontSize: 14, fontFamily: FONTS.mono, fontWeight: '400', letterSpacing: 0 },
  bodySmall: { fontSize: 13, fontFamily: FONTS.mono, fontWeight: '400', letterSpacing: 0 },
  label: { fontSize: 10, fontFamily: FONTS.mono, fontWeight: '400', letterSpacing: 0.3 },
  labelSmall: { fontSize: 9, fontFamily: FONTS.mono, fontWeight: '400', letterSpacing: 0.3 },
  meta: { fontSize: 10, fontFamily: FONTS.mono, fontWeight: '300', letterSpacing: 0 },
  metaSmall: { fontSize: 9, fontFamily: FONTS.mono, fontWeight: '300', letterSpacing: 0 }
} as const

export type TypographyToken = keyof typeof TYPOGRAPHY

// Build a CSS variable reference from a color token, e.g.
// cssVar('primary') -> 'var(--og-primary)'.
export function cssVar(token: ColorToken): string {
  return `var(--og-${kebab(token)})`
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}
