// Shared setup types, kept in a leaf module so the pure setup-logic and the IO
// shell (setup.ts) can both import RecMode without a circular dependency.

export type { RecMode } from '../../shared/setup-contract'
