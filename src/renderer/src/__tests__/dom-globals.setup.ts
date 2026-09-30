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

// media-chrome checks display mode while loading. jsdom has no media-query
// engine; the harness represents an ordinary browser window, not standalone PiP.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  const matchMedia = (query: string): MediaQueryList =>
    Object.assign(new EventTarget(), {
      media: query,
      matches: false,
      onchange: null,
      addListener: () => {},
      removeListener: () => {}
    }) as MediaQueryList
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia
  })
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia
  })
}

// Chromium exposes a TextTrackList EventTarget; jsdom returns a plain array.
// Keep track events functional so the real media-chrome store can subscribe.
if (typeof HTMLMediaElement !== 'undefined') {
  const tracks = new WeakMap<HTMLMediaElement, TextTrackList>()
  Object.defineProperty(HTMLMediaElement.prototype, 'textTracks', {
    configurable: true,
    get(this: HTMLMediaElement): TextTrackList {
      let list = tracks.get(this)
      if (!list) {
        list = Object.assign(new EventTarget(), {
          length: 0,
          onchange: null,
          onaddtrack: null,
          onremovetrack: null,
          getTrackById: () => null,
          [Symbol.iterator]: () => [][Symbol.iterator]()
        }) as unknown as TextTrackList
        tracks.set(this, list)
      }
      return list
    }
  })
  const audioTracks = new WeakMap<HTMLMediaElement, EventTarget>()
  Object.defineProperty(HTMLMediaElement.prototype, 'audioTracks', {
    configurable: true,
    get(this: HTMLMediaElement): EventTarget {
      let list = audioTracks.get(this)
      if (!list) {
        list = Object.assign(new EventTarget(), {
          length: 0,
          [Symbol.iterator]: () => [][Symbol.iterator]()
        })
        audioTracks.set(this, list)
      }
      return list
    }
  })
}
