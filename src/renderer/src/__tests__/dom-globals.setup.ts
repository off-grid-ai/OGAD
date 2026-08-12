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
