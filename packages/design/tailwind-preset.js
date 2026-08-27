/**
 * Off Grid AI Tailwind preset (Tailwind v3).
 *
 * Maps Tailwind theme tokens onto the --og-rgb-* CSS variables defined in
 * tokens.css, using the rgb(... / <alpha-value>) pattern so opacity modifiers
 * (e.g. bg-primary/20, text-text-muted/60) work and themes switch (dark by
 * default, light under [data-theme="light"]). Import tokens.css once in your
 * app entry, then add this preset to tailwind.config.js:
 *
 *   const offgrid = require('@offgrid/design/tailwind-preset');
 *   module.exports = { presets: [offgrid], content: [...] };
 *
 * `og` is exported so apps can remap legacy color names (neutral, green, ...)
 * onto the same channel variables for a zero-edit migration.
 */
const colorTemplate = 'rgb(var(--og-rgb-$NAME) / <alpha-value>)'
const og = colorTemplate.replace.bind(colorTemplate, '$NAME')

const colors = {
  primary: {
    DEFAULT: og('primary'),
    dark: og('primary-dark'),
    light: og('primary-light')
  },
  background: og('background'),
  surface: {
    DEFAULT: og('surface'),
    light: og('surface-light'),
    hover: og('surface-hover')
  },
  text: {
    DEFAULT: og('text'),
    secondary: og('text-secondary'),
    muted: og('text-muted'),
    disabled: og('text-disabled')
  },
  border: {
    DEFAULT: og('border'),
    light: og('border-light'),
    focus: og('border-focus')
  },
  success: og('success'),
  warning: og('warning'),
  error: og('error'),
  trending: og('trending'),
  info: og('info'),
  overlay: 'var(--og-overlay)',
  divider: 'var(--og-divider)'
}

const fontMono = [
  'Menlo',
  'ui-monospace',
  'SFMono-Regular',
  'SF Mono',
  'Consolas',
  'Liberation Mono',
  'monospace'
]

const preset = {
  theme: {
    extend: {
      colors,
      fontFamily: {
        mono: fontMono,
        sans: fontMono
      },
      fontSize: {
        display: ['22px', { lineHeight: '1.2', letterSpacing: '-0.5px', fontWeight: '200' }],
        h1: ['24px', { lineHeight: '1.2', letterSpacing: '-0.5px', fontWeight: '300' }],
        h2: ['16px', { lineHeight: '1.3', letterSpacing: '-0.2px', fontWeight: '400' }],
        h3: ['13px', { lineHeight: '1.3', letterSpacing: '-0.2px', fontWeight: '400' }],
        body: ['14px', { lineHeight: '1.5', fontWeight: '400' }],
        bodySmall: ['13px', { lineHeight: '1.5', fontWeight: '400' }],
        label: ['10px', { lineHeight: '1.4', letterSpacing: '0.3px', fontWeight: '400' }],
        labelSmall: ['9px', { lineHeight: '1.4', letterSpacing: '0.3px', fontWeight: '400' }],
        meta: ['10px', { lineHeight: '1.4', fontWeight: '300' }],
        metaSmall: ['9px', { lineHeight: '1.4', fontWeight: '300' }]
      },
      spacing: {
        xs: '4px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
        xxl: '32px'
      },
      borderRadius: {
        sm: '2px',
        DEFAULT: '8px',
        md: '8px'
      }
    }
  }
}

module.exports = preset
module.exports.og = og
module.exports.colors = colors
