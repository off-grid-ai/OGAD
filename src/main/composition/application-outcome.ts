import type { Outcome } from '@offgrid/application'

/** Convert a typed facade failure only at a legacy host boundary that reports Error objects. */
export function requireApplicationOutcome<Value, Failure extends { readonly message: string }>(
  outcome: Outcome<Value, Failure>
): Value {
  if (outcome.ok) return outcome.value
  throw new Error(outcome.failure.message)
}
