// @offgrid/clipboard - cross-platform clipboard capture + history engine.
// Absorbed from copyclip (https://github.com/alichherawalla/copyclip, MIT) and
// restructured to be embeddable in Off Grid AI Desktop and Off Grid AI Mobile.
//
// The engine is platform-agnostic; platform specifics live behind ClipboardBridge
// (see ./adapters/electron for the desktop bridge) and persistence behind
// ClipboardStore (a local SQLite store today, an @offgrid/memory op-log later so
// the clipboard syncs across devices).

export * from './types'
export { ClipboardEngine } from './engine'
export type { ClipboardEngineOptions } from './engine'
export { fuzzyMatch, fuzzySearch } from './fuzzy-search'
