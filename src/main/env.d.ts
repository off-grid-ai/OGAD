// Ambient types for the main process's build-time imports.
//
// `electron-vite` resolves `import icon from '../../resources/icon.png?asset'` at build time and
// declares the `*?asset` module shape in `electron-vite/node`. `tsconfig.node.json` picks that up
// through `"types": ["electron-vite/node"]`, but the WEB program had no equivalent - it simply never
// saw a main-process file that used one, because it excluded the single entry that did.
//
// Moving the entry's body into `application-main.ts` and `create-main-window.ts` brought those
// imports inside `src/main/**/*`, which the web program does include, and the missing declaration
// surfaced as TS2307.
//
// A reference here rather than a `types` array on the web config: setting `types` replaces
// automatic `@types` resolution for that program, which would drop Node's own globals from the main
// files this exists to type. This file is inside `src/main/**/*`, so both programs pick it up, and
// nothing is excluded or loosened to achieve it.
/// <reference types="electron-vite/node" />
