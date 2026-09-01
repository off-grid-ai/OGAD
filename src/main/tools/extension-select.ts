/**
 * Which registered tool extensions join an agentic turn. Pure, so the rule
 * is testable and defined once: the assistant's own tools ride every
 * agentic turn; connector extensions (external accounts) join only when the
 * user turned Connectors on. An extension that declares no category is
 * treated as a connector - fail closed for anything that might touch an
 * external service.
 *
 * Structural on purpose: importing ToolExtension from ../tools would create
 * the cycle tools -> extension-select -> tools (dependency-cruiser blocks
 * it). The selector only needs the category field, so it asks for exactly
 * that and stays generic over the caller's richer type.
 */
import { selectToolExtensions as selectSharedToolExtensions } from '@offgrid/models'

export interface CategorizedExtension { category?: 'tool' | 'connector' }

export function selectToolExtensions<T extends CategorizedExtension>(
  extensions: T[],
  opts: { connectors: boolean }
): T[] {
  return selectSharedToolExtensions(extensions, opts)
}
