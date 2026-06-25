// Function-hook seam (main process). Pro features register plain functions
// against named hooks during activation; core calls them when present and falls
// back to a default/no-op when absent. Use for BEHAVIOUR the core must defer to
// pro for — e.g. augmenting the chat prompt with captured context, contributing
// extra universal-search sources, or adding tray menu items.
//
// Free builds register nothing, so callHook returns undefined and core keeps its
// own default behaviour. Mirrors mobile/src/bootstrap/hookRegistry.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookFn = (...args: any[]) => any;

const hooks: Record<string, HookFn> = {};

export function registerHook(name: string, fn: HookFn): void {
  hooks[name] = fn;
}

/** Call a hook if registered; returns its result, or undefined when absent. */
export function callHook<R = unknown>(name: string, ...args: unknown[]): R | undefined {
  const fn = hooks[name];
  return fn ? (fn(...args) as R) : undefined;
}

/** Await a hook if registered; returns its resolved result, or undefined. */
export async function callHookAsync<R = unknown>(name: string, ...args: unknown[]): Promise<R | undefined> {
  const fn = hooks[name];
  if (!fn) return undefined;
  return (await fn(...args)) as R;
}

/** Known hook names, centralised so core and pro stay in sync. */
export const HOOKS = {
  /** (basePrompt: string, query: string) => Promise<string> — augment the chat
   *  system/context with captured memory + entity/observation context (pro). */
  chatAugmentContext: 'chat.augmentContext',
  /** () => Promise<SearchSource[]> — extra universal-search sources (pro). */
  searchExtraSources: 'search.extraSources',
} as const;
