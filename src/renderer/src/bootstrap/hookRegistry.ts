// Function-hook seam (renderer). Pro registers behaviour functions during
// activation; core calls them when present and falls back to a default when
// absent. Mirrors the main-process hookRegistry and mobile's.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookFn = (...args: any[]) => any;

const hooks: Record<string, HookFn> = {};

export function registerHook(name: string, fn: HookFn): void {
  hooks[name] = fn;
}

export function callHook<R = unknown>(name: string, ...args: unknown[]): R | undefined {
  const fn = hooks[name];
  return fn ? (fn(...args) as R) : undefined;
}
