/**
 * The DOM globals jsdom does not implement, installed once for every suite that renders.
 *
 * `ResizeObserver` is the one that bites: `@radix-ui/react-use-size` constructs one in a layout effect,
 * so a component that merely CONTAINS a Radix primitive throws during commit. React reports that as an
 * uncaught exception rather than a failed assertion, and the test that follows then fails on missing
 * text it never had a chance to render - which is how a real UI journey came to report "unable to find
 * the text" while the actual cause was a global nobody had defined.
 *
 * Guarded twice: only where a document exists, so the same file is inert in a node-environment suite,
 * and only when nothing else has already provided one.
 *
 * Imported by `browser-boundaries.setup.ts` and listed in `vitest.db.config.ts`, because the UI journeys
 * that run against the real database need it just as much as the renderer suite does - and a shim each
 * test file installs for itself is a shim the next file forgets.
 */
if (typeof window !== 'undefined' && typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverBoundary implements ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}

    observe(_target: Element, _options?: ResizeObserverOptions): void {}

    unobserve(_target: Element): void {}

    disconnect(): void {}
  }

  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserverBoundary
  })
}

// Element.scrollTo: jsdom leaves it undefined, so a component that scrolls a feed
// to the bottom in an effect (the watched browser pane's step log) throws during
// commit and takes the render down. Chromium provides it; keep the shim inert.
if (typeof window !== 'undefined' && typeof Element.prototype.scrollTo === 'undefined') {
  Element.prototype.scrollTo = function scrollTo(): void {}
}

/**
 * `localStorage`. jsdom serves these suites from an opaque origin, where the spec says web storage
 * is unavailable, so BOTH `window.localStorage` and the bare `localStorage` are undefined. Chromium
 * always provides them, and product code that remembers a choice between visits writes plain
 * `localStorage`. Install one real in-memory store under both names, so a component and its test
 * read and write the SAME storage - two stores here would let them disagree about what was saved.
 */
if (typeof window !== 'undefined' && !window.localStorage) {
  const entries = new Map<string, string>()
  const store: Storage = {
    get length(): number {
      return entries.size
    },
    clear: (): void => {
      entries.clear()
    },
    getItem: (key: string): string | null => entries.get(String(key)) ?? null,
    key: (index: number): string | null => [...entries.keys()][index] ?? null,
    removeItem: (key: string): void => {
      entries.delete(String(key))
    },
    setItem: (key: string, value: string): void => {
      entries.set(String(key), String(value))
    }
  }
  for (const target of [window, globalThis]) {
    Object.defineProperty(target, 'localStorage', {
      configurable: true,
      writable: true,
      value: store
    })
  }
}
