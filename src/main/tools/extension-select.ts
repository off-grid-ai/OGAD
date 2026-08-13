/**
 * Which registered tool extensions join an agentic turn. Pure, so the rule
 * is testable and defined once: the assistant's own tools ride every
 * agentic turn; connector extensions (external accounts) join only when the
 * user turned Connectors on. An extension that declares no category is
 * treated as a connector - fail closed for anything that might touch an
 * external service.
 */
import type { ToolExtension } from '../tools'

export function selectToolExtensions(
  extensions: ToolExtension[],
  opts: { connectors: boolean }
): ToolExtension[] {
  return extensions.filter((e) => e.category === 'tool' || opts.connectors)
}
