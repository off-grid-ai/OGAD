import { expect } from 'vitest'
import { PAGE_GUTTER, PAGE_TOP } from '../../components/PageShell'

/** The URL a top-level screen opens at: its view name, except Chat. */
export function routePathOf(view: string): string {
  return view === 'memory-chat' ? '/chat' : `/${view}`
}

/** Padding classes a wrapper must not add between the route host and the shell. */
const PADDING = /^-?(p|px|py|pt|pl|pr|pb)-/

/**
 * The shell on the open route, with what makes it the standard page: one header with an h1, the
 * gutters and top padding on the header, and the same gutters on the content unless the screen
 * took the documented full-bleed opt-out. Nothing between the route host and the shell pads it.
 */
export function expectPageShell(view: string): void {
  const host = document.querySelector<HTMLElement>('[data-route-host]')
  expect(host, `${view}: route host`).not.toBeNull()
  expect(host!.className, `${view}: the route host adds no padding`).not.toMatch(/\bp[xytblr]?-\d/)

  const shells = host!.querySelectorAll<HTMLElement>('[data-slot="page-shell"]')
  expect(shells, `${view}: renders in exactly one PageShell`).toHaveLength(1)
  const shell = shells[0]!

  for (let el = shell.parentElement; el && el !== host; el = el.parentElement) {
    const padded = [...el.classList].filter((name) => PADDING.test(name))
    expect(padded, `${view}: a wrapper outside the shell adds padding`).toEqual([])
  }

  const header = shell.querySelector<HTMLElement>('[data-slot="page-shell-header"]')
  expect(header, `${view}: shell header`).not.toBeNull()
  expect(header!.classList.contains(PAGE_GUTTER), `${view}: header gutter`).toBe(true)
  expect(header!.classList.contains(PAGE_TOP), `${view}: header top padding`).toBe(true)
  expect(header!.querySelectorAll('[data-slot="page-header"]'), `${view}: one header`).toHaveLength(
    1
  )
  expect(header!.querySelector('h1'), `${view}: header title`).not.toBeNull()
  // No screen draws a second page header of its own inside the shell.
  expect(
    host!.querySelectorAll('[data-slot="page-header"]'),
    `${view}: no second header`
  ).toHaveLength(1)

  const content = shell.querySelector<HTMLElement>('[data-slot="page-content"]')
  expect(content, `${view}: shell content`).not.toBeNull()
  if (shell.dataset.bleed === undefined) {
    expect(content!.classList.contains(PAGE_GUTTER), `${view}: content gutter`).toBe(true)
  }
}
