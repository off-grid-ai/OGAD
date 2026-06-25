// Build-time flag injected by electron.vite.config.ts (define). True only when
// the private pro/ submodule is present at build time (pro build); false in the
// free/open build. Read by preload (isPro) and the main pro loader.
declare const __OFFGRID_PRO__: boolean;
