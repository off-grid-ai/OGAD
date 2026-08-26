/**
 * Hotkey parsing for the vision rail's actuation (R2-D2b). UI-TARS emits
 * `hotkey(key='ctrl c')` - a space-separated combo. This maps the tokens to
 * nut.js Key enum MEMBER NAMES ('LeftControl', 'C'), which the host then
 * resolves to the enum values.
 *
 * Kept pure and free of the native package (which is an optional dependency and
 * must never be imported where it might be absent), so the mapping is unit-
 * tested here; the host does the trivial name -> Key[name] lookup.
 */

const MODIFIERS: Record<string, string> = {
  ctrl: 'LeftControl',
  control: 'LeftControl',
  cmd: 'LeftSuper',
  command: 'LeftSuper',
  meta: 'LeftSuper',
  win: 'LeftSuper',
  super: 'LeftSuper',
  alt: 'LeftAlt',
  option: 'LeftAlt',
  opt: 'LeftAlt',
  shift: 'LeftShift'
}

const NAMED: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  esc: 'Escape',
  escape: 'Escape',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  delete: 'Delete',
  backspace: 'Backspace'
}

/** One token -> a Key enum member name, or null if unrecognised. */
function tokenToKeyName(token: string): string | null {
  const t = token.toLowerCase()
  if (MODIFIERS[t]) {
    return MODIFIERS[t]
  }
  if (NAMED[t]) {
    return NAMED[t]
  }
  if (/^[a-z]$/.test(t)) {
    return t.toUpperCase()
  }
  if (/^[0-9]$/.test(t)) {
    return `Num${t}`
  }
  return null
}

/**
 * `'ctrl c'` -> `['LeftControl', 'C']`. Returns null if the combo is empty or
 * any token is unrecognised - the host then refuses the hotkey rather than
 * pressing a partial, wrong combination.
 */
export function hotkeyToKeyNames(keys: string): string[] | null {
  const tokens = keys
    .trim()
    .split(/[\s+]+/)
    .filter(Boolean)
  if (tokens.length === 0) {
    return null
  }
  const names: string[] = []
  for (const token of tokens) {
    const name = tokenToKeyName(token)
    if (!name) {
      return null
    }
    names.push(name)
  }
  return names
}
