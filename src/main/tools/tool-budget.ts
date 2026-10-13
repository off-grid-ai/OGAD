// Keep the tool-schema payload within the model's context budget.
//
// With many MCP connectors enabled, the combined tool schemas can exceed the
// whole context window: llama-server inlines every tool schema into the prompt
// AND compiles it into a GBNF grammar. Too big and the server rejects the turn
// with a 400 ("request … exceeds the available context size"). Certain schema
// keywords (numeric/string RANGE constraints) also expand into enormous nested
// grammars — the exact thing that made tool-call grammars fail to parse.
//
// Strategy, cheapest first:
//   1. PRUNE every schema — drop the grammar-bloating, low-value keywords and
//      truncate long descriptions. Keeps ALL tools available.
//   2. If still over budget, DROP whole connector tools from the end until it
//      fits — but NEVER below the built-ins — and report how many went (never a
//      silent cap; the caller logs it and tells the model).

/** Shared ceiling for schemas sent by Desktop chat and browser tasks. */
export const MAX_TOOL_TOKENS = 4000

// Rough token estimate: ~4 chars/token for compact JSON. Good enough for a guard.
function estTokens(v: unknown): number {
  return Math.ceil(JSON.stringify(v ?? '').length / 4)
}

// Keywords stripped from a schema: they bloat tokens and/or the compiled grammar
// without changing which tool or arguments exist. The numeric/string RANGE
// constraints (minimum/maximum/…) are the worst offenders — they expand into
// giant nested-digit grammars. enum/type/properties/required/items are KEPT.
const DROP_KEYS = new Set([
  'examples',
  'example',
  '$comment',
  'title',
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems'
])

const MAX_DESC = 120 // chars — enough to guide tool choice, not to bloat the prompt

function pruneSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(pruneSchema)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(node as Record<string, unknown>)) {
    if (DROP_KEYS.has(k)) continue
    if (k === 'description' && typeof val === 'string') {
      out[k] = val.length > MAX_DESC ? val.slice(0, MAX_DESC - 1) + '…' : val
    } else {
      out[k] = pruneSchema(val)
    }
  }
  return out
}

export interface ToolBudgetResult {
  tools: unknown[]
  droppedCount: number // connector tools removed to fit
  pruned: boolean // schemas were pruned to fit
  estTokens: number // final estimate
}

/** Fit `tools` into `maxTokens`. `keepFirst` leading tools are BUILT-INS that are
 *  never dropped (only the connector tools after them are). */
export function budgetTools(
  tools: unknown[],
  maxTokens: number,
  keepFirst: number
): ToolBudgetResult {
  if (estTokens(tools) <= maxTokens) {
    return { tools, droppedCount: 0, pruned: false, estTokens: estTokens(tools) }
  }
  // 1) Prune every schema first — cheap, keeps all tools available.
  const prunedAll = tools.map(pruneSchema)
  if (estTokens(prunedAll) <= maxTokens) {
    return { tools: prunedAll, droppedCount: 0, pruned: true, estTokens: estTokens(prunedAll) }
  }
  // 2) Still over: drop connector tools from the end, never below the built-ins.
  const kept = prunedAll.slice()
  let dropped = 0
  while (kept.length > keepFirst && estTokens(kept) > maxTokens) {
    kept.pop()
    dropped++
  }
  return { tools: kept, droppedCount: dropped, pruned: true, estTokens: estTokens(kept) }
}
