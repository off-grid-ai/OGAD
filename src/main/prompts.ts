interface PromptVariable {
  name: string
  description: string
}

export interface PromptDef {
  key: string
  name: string
  description: string
  category: 'master-memory' | 'memory-filter' | 'entity' | 'session' | 'chat'
  variables: PromptVariable[]
  defaultTemplate: string
}

// ---------------------------------------------------------------------------
// Default templates — extracted from the original hardcoded prompts in ipc.ts
// ---------------------------------------------------------------------------

const SESSION_SUMMARY = `Extract a user profile summary from this conversation. Focus on the USER, not the assistant. Write in third person.

Include: what they're working on, their preferences, decisions made, tools/tech they use, people mentioned.
Skip: generic advice, code snippets, things merely asked about but not adopted.

Conversation:
{{CONVERSATION_TEXT}}

User Profile Summary:`

// ---------------------------------------------------------------------------
// Prompt registry
// ---------------------------------------------------------------------------

export const PROMPT_REGISTRY: PromptDef[] = [

  // Session
  {
    key: 'sessionSummary',
    name: 'Session Summary',
    description: 'Extracts a user profile summary from a conversation for the master memory.',
    category: 'session',
    variables: [
      { name: 'CONVERSATION_TEXT', description: 'Full conversation text with role labels' }
    ],
    defaultTemplate: SESSION_SUMMARY
  }
]

// Build a lookup map for fast access
const registryMap = new Map<string, PromptDef>()
for (const def of PROMPT_REGISTRY) {
  registryMap.set(def.key, def)
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Returns the registered default template and rejects unknown prompt keys. */
export function getDefaultPromptTemplate(key: string): string {
  const def = registryMap.get(key)
  if (!def) throw new Error(`Unknown prompt key: ${key}`)
  return def.defaultTemplate
}

/** Replaces {{VAR}} placeholders with the provided values. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    return vars[varName] !== undefined ? vars[varName] : match
  })
}

/** Returns the full registry for the Settings UI. */
export function getAllPromptDefs(): PromptDef[] {
  return PROMPT_REGISTRY
}
