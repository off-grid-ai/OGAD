import { getSetting, deleteSetting } from './database';

export interface PromptVariable {
  name: string;
  description: string;
}

export interface PromptDef {
  key: string;
  name: string;
  description: string;
  category: 'master-memory' | 'memory-filter' | 'entity' | 'session' | 'chat';
  variables: PromptVariable[];
  defaultTemplate: string;
}

// ---------------------------------------------------------------------------
// Default templates — extracted from the original hardcoded prompts in ipc.ts
// ---------------------------------------------------------------------------

const MASTER_MEMORY_INITIAL = `Create a MASTER MEMORY about this user from the conversation summary below. Write in third person.

Include sections for: About the User, Projects & Work, Technical Environment, Preferences, Key Decisions, Important Relationships. Only include sections with actual content.

Be specific — include names, versions, concrete details. Skip generic info.

Conversation Summary:
{{SUMMARY}}

Master Memory:`;

const MASTER_MEMORY_INCREMENTAL = `Update this master memory by integrating the new conversation summary. Write in third person.

Rules: PRESERVE all existing info. ADD new facts. MERGE related info into sections. Only UPDATE if directly contradicted.

CURRENT MASTER MEMORY:
{{CURRENT_MASTER}}

NEW SUMMARY:
{{NEW_SUMMARY}}

Updated Master Memory:`;

const MASTER_MEMORY_BATCH_FIRST = `Create a MASTER MEMORY about this user from the conversation summaries below. Write in third person.

Include sections for: About the User, Projects & Work, Technical Environment, Preferences, Key Decisions, Important Relationships. Only include sections with actual content. Be specific.

Conversation Summaries:
{{BATCH_TEXT}}

Master Memory:`;

const MASTER_MEMORY_BATCH_EXPAND = `Update this master memory by integrating new conversation summaries. PRESERVE existing info, ADD new facts. Write in third person.

CURRENT MASTER MEMORY:
{{CURRENT_MASTER}}

ADDITIONAL SUMMARIES (batch {{BATCH_NUM}}):
{{BATCH_TEXT}}

Updated Master Memory:`;

const MASTER_MEMORY_MERGE = `Merge these partial summaries into one unified MASTER MEMORY about the user. Write in third person.

Combine all information, remove duplicates, organize into sections: About the User, Projects & Work, Technical Environment, Preferences, Key Decisions, Important Relationships. Be specific — keep all names, versions, concrete details.

Partial Summaries:
{{PARTIAL_SUMMARIES}}

Master Memory:`;

const MEMORY_FILTER_LENIENT = `You are a inclusive memory filter. Decide if the following single message should be saved as LONG-TERM memory that a user would want in future chats.

Store information that could be useful in future conversations, including:
- Personal preferences, facts, or profile information
- Projects, specs, requirements, or technical choices
- Decisions, commitments, or agreements
- Instructions, constraints, or guidelines
- Plans, schedules, goals, or deadlines
- Facts about entities, tools, technologies mentioned
- General knowledge shared that might be referenced again

Do NOT store:
- Simple greetings or pleasantries
- Generic filler phrases

If the role is 'assistant', store ONLY if it repeats a verified user fact or a decision the user made.
If unsure, set store to true.

Return JSON ONLY with this shape:
{
    "store": boolean,
    "name": "short 3-5 word title for this memory",
    "memory": "short standalone statement suitable for future retrieval"
}

Role: {{ROLE}}
Message: {{MESSAGE}}
JSON:`;

const MEMORY_FILTER_BALANCED = `You are a balanced memory filter. Decide if the following single message should be saved as LONG-TERM memory that a user would want in future chats.

Store ONLY explicitly stated, durable, high-signal information such as:
- Personal preferences the user directly and clearly stated ("I prefer X", "I always use Y")
- Concrete project names, product names, or specific technical architecture decisions
- Firm decisions or commitments the user explicitly made ("We decided to go with X", "I chose Y")
- Specific constraints, requirements, or deadlines stated as facts
- Long-term goals or plans the user described in their own words

Do NOT store:
- Greetings, small talk, pleasantries, or filler
- Code snippets, error messages, stack traces, or log output
- Questions the user asked (unless the question itself reveals a strong preference)
- Assistant explanations, suggestions, or recommendations (unless the user confirmed them as a decision)
- One-off troubleshooting steps, debugging attempts, or ephemeral details
- Generic or common-knowledge statements ("React is a library", "APIs use HTTP")
- Vague or implied preferences ("seems like they like X")
- Redundant facts already implied by the message itself
- Speculation, hypotheticals, or unverified claims
- Anything that won't clearly matter in future conversations

If the role is 'assistant', store ONLY if it repeats a verified user fact or a decision the user made.
If unsure, set store to false.

Return JSON ONLY with this shape:
{
    "store": boolean,
    "name": "short 3-5 word title for this memory",
    "memory": "short standalone statement suitable for future retrieval"
}

Role: {{ROLE}}
Message: {{MESSAGE}}
JSON:`;

const MEMORY_FILTER_STRICT = `You are a very strict memory filter. Decide if the following single message should be saved as LONG-TERM memory that a user would want in future chats.

Store ONLY high-value, explicitly stated information:
- Direct personal preferences the user explicitly stated
- Major decisions or commitments clearly made
- Critical project requirements explicitly mentioned
- Core facts about important entities central to the user's work

Do NOT store:
- Greetings, small talk, or pleasantries
- Troubleshooting steps or temporary solutions
- Generic statements or common knowledge
- Technical details that are easily searchable
- Speculation, suggestions, or hypotheticals
- Anything not explicitly and directly stated by the user
- Inferred or implied information

If the role is 'assistant', store ONLY if it repeats a verified user fact or a decision the user made.
If unsure, set store to false.

Return JSON ONLY with this shape:
{
    "store": boolean,
    "name": "short 3-5 word title for this memory",
    "memory": "short standalone statement suitable for future retrieval"
}

Role: {{ROLE}}
Message: {{MESSAGE}}
JSON:`;

const ENTITY_EXTRACTION_LENIENT = `You are extracting entities from long-term memory statements. Be inclusive - capture entities that might be useful later.

Return JSON only with this shape:
{
    "entities": [
        {
            "name": "string",
            "type": "Person | Organization | Product | Place | Object | Project | Concept | Event | Other",
            "facts": ["short factual statements about the entity"]
        }
    ]
}

Rules:
- Include all entities mentioned in the memory statements.
- Include people, organizations, products, places, projects, technologies, tools, and concepts.
- Be inclusive - if an entity is mentioned, it's probably worth tracking.
- Facts should be concise and verifiable.
- Return {"entities": []} only if there are no discernible entities at all.

Memory statements:
{{MEMORY_TEXT}}

JSON:`;

const ENTITY_EXTRACTION_BALANCED = `You are extracting entities from long-term memory statements. Only keep entities worth remembering for future chats.

Return JSON only with this shape:
{
    "entities": [
        {
            "name": "string",
            "type": "Person | Organization | Product | Place | Object | Project | Concept | Event | Other",
            "facts": ["short factual statements about the entity"]
        }
    ]
}

Rules:
- Only include entities explicitly and repeatedly mentioned or clearly central to the user's work.
- Include ONLY entities the user has a specific, ongoing relationship with (their projects, their tools, people they work with, organizations they belong to).
- Exclude passing mentions, one-off references, generic examples, or entities mentioned only in assistant advice.
- Exclude generic or common single-word entities like "API", "database", "server", "frontend", "backend", "app", "website", "code".
- Exclude entities used only as illustrative examples or in generic advice.
- Entity names must be at least 3 characters long.
- Facts must be concise, specific, durable, and directly from the memory statements — no inferred facts.
- If no entities clearly meet the bar, return {"entities": []}.

Memory statements:
{{MEMORY_TEXT}}

JSON:`;

const ENTITY_EXTRACTION_STRICT = `You are extracting entities from long-term memory statements. Be very selective - only keep high-value entities.

Return JSON only with this shape:
{
    "entities": [
        {
            "name": "string",
            "type": "Person | Organization | Product | Place | Object | Project | Concept | Event | Other",
            "facts": ["short factual statements about the entity"]
        }
    ]
}

Rules:
- Only include entities that are CENTRAL to the user's work or life.
- Exclude generic tools, common technologies, libraries, or frameworks unless the user has a specific relationship to them.
- Exclude one-time mentions or incidental references.
- Only include entities the user has explicitly discussed in detail or shown clear importance.
- Facts must be specific, verified, and directly from the memory statements.
- When in doubt, exclude the entity.
- Return {"entities": []} if no entities are clearly significant.

Memory statements:
{{MEMORY_TEXT}}

JSON:`;

const ENTITY_SUMMARY = `You are updating an entity profile summary.

Entity: {{NAME}}
Type: {{TYPE}}

Existing summary:
{{EXISTING_SUMMARY}}

New facts:
{{NEW_FACTS}}

Write a concise, well-structured summary. Include only verified facts. Do not add speculation. Output plain text only.`;

const SESSION_SUMMARY = `Extract a user profile summary from this conversation. Focus on the USER, not the assistant. Write in third person.

Include: what they're working on, their preferences, decisions made, tools/tech they use, people mentioned.
Skip: generic advice, code snippets, things merely asked about but not adopted.

Conversation:
{{CONVERSATION_TEXT}}

User Profile Summary:`;

const RAG_CHAT = `You are a helpful assistant that answers using ONLY the provided context from the user's memories, conversations, summaries, and entities.
Prefer specific evidence from messages, summaries, entities, and memories over the master memory. Use the master memory only as supplemental context.
If the context does not contain the answer, say you don't have that information and ask a brief follow-up question.
Do not fabricate details. Be DATA-BACKED, not a black box: back every factual claim with a citation to the SOURCES list using its tag in square brackets, e.g. [S2] or [S5]. Cite the specific source (which memory, chat, project, meeting, or screen) — never invent a citation, and only cite sources you actually used.

ARTIFACTS: You have a LIVE, sandboxed code canvas built into this app. When the user asks you to CREATE or BUILD something runnable — a React app or component, a web page, an interactive UI, a chart/graph, a diagram, or a vector graphic — emit ONE fenced code block and it runs IMMEDIATELY in a canvas beside the chat. You do NOT have or need a terminal, npm, Vite, build tools, or the user's filesystem. NEVER give installation/setup steps (no "npm create vite", "npm install", "run npm run dev"), NEVER tell them to create files, and NEVER say you "can't execute" or "can't build" it — you can, right here. Just write the finished, self-contained code:
- a React app or component -> \`\`\`jsx — define ONE top-level component named \`App\` containing everything; plain JSX, NO import/export statements; React, ReactDOM, useState, useEffect and the other hooks are already global; it is auto-rendered into #root. Put ALL the code in this one block — no separate App.jsx/index.css/main.jsx files.
- a plain web page or interactive UI (no React) -> \`\`\`html (one complete document; inline all CSS and JS; no external/CDN/network resources)
- a flowchart, sequence, or relationship diagram -> \`\`\`mermaid
- a static graphic, icon, or illustration -> \`\`\`svg
When the user says React/Next/component/hooks, ALWAYS use \`\`\`jsx (never \`\`\`html, never setup instructions). The code is shown only in the canvas — do NOT also paste it in prose. Produce a complete, runnable artifact even if it isn't in the provided context — this is a creative/build task, so the "only use context" rule does not apply. At most one short sentence before the block. For ordinary questions, answer normally (no code block).

SKILLS: The user can install skills (reusable instruction packs) in their .skills folder and invoke one with /skill-name. Installed skills:
{{SKILLS_BLOCK}}
When a message invokes a skill, its full instructions are prepended to the question — follow them for that request.

CLARIFY: When you genuinely need more information to answer well, you may ask ONE concise multiple-choice question instead of guessing. Emit it as a fenced \`\`\`ask block containing only JSON: {"question": "…", "options": ["…", "…"], "multiSelect": false}. The app turns the options into clickable buttons. Use this sparingly — only when the choice materially changes your answer — otherwise answer directly.

IMAGE: When the user asks you to generate, create, draw, or make a picture/image/photo/logo/illustration, respond with ONLY a fenced \`\`\`image block containing a single vivid, detailed image-generation prompt (subject, style, lighting, composition) — no other text. The app generates it on-device. Do this only for genuine image requests; for everything else, never emit an image block.
{{HISTORY_BLOCK}}
User question:
{{QUERY}}

Context:
{{CONTEXT_BLOCK}}

Answer:`;

// ---------------------------------------------------------------------------
// Prompt registry
// ---------------------------------------------------------------------------

export const PROMPT_REGISTRY: PromptDef[] = [
  // Master Memory
  {
    key: 'masterMemory.initial',
    name: 'Initial Creation',
    description: 'Creates the first master memory document from a single conversation summary.',
    category: 'master-memory',
    variables: [{ name: 'SUMMARY', description: 'The conversation summary to build from' }],
    defaultTemplate: MASTER_MEMORY_INITIAL,
  },
  {
    key: 'masterMemory.incremental',
    name: 'Incremental Update',
    description: 'Merges a new conversation summary into the existing master memory.',
    category: 'master-memory',
    variables: [
      { name: 'CURRENT_MASTER', description: 'The current master memory content' },
      { name: 'NEW_SUMMARY', description: 'The new conversation summary to integrate' },
    ],
    defaultTemplate: MASTER_MEMORY_INCREMENTAL,
  },
  {
    key: 'masterMemory.batchFirst',
    name: 'Batch First',
    description: 'Creates master memory from the first batch of summaries during full regeneration.',
    category: 'master-memory',
    variables: [{ name: 'BATCH_TEXT', description: 'Formatted batch of conversation summaries' }],
    defaultTemplate: MASTER_MEMORY_BATCH_FIRST,
  },
  {
    key: 'masterMemory.batchExpand',
    name: 'Batch Expand',
    description: 'Expands master memory with additional batches during full regeneration.',
    category: 'master-memory',
    variables: [
      { name: 'CURRENT_MASTER', description: 'The current master memory content' },
      { name: 'BATCH_NUM', description: 'The current batch number' },
      { name: 'BATCH_TEXT', description: 'Formatted batch of conversation summaries' },
    ],
    defaultTemplate: MASTER_MEMORY_BATCH_EXPAND,
  },

  // Memory Filter
  {
    key: 'memoryFilter.lenient',
    name: 'Lenient Filter',
    description: 'Inclusive memory filter that stores most potentially useful information.',
    category: 'memory-filter',
    variables: [
      { name: 'ROLE', description: 'Message role (user or assistant)' },
      { name: 'MESSAGE', description: 'The message content to evaluate' },
    ],
    defaultTemplate: MEMORY_FILTER_LENIENT,
  },
  {
    key: 'memoryFilter.balanced',
    name: 'Balanced Filter',
    description: 'Balanced memory filter that stores explicitly stated, high-signal information.',
    category: 'memory-filter',
    variables: [
      { name: 'ROLE', description: 'Message role (user or assistant)' },
      { name: 'MESSAGE', description: 'The message content to evaluate' },
    ],
    defaultTemplate: MEMORY_FILTER_BALANCED,
  },
  {
    key: 'memoryFilter.strict',
    name: 'Strict Filter',
    description: 'Very selective memory filter that only stores high-value, directly stated information.',
    category: 'memory-filter',
    variables: [
      { name: 'ROLE', description: 'Message role (user or assistant)' },
      { name: 'MESSAGE', description: 'The message content to evaluate' },
    ],
    defaultTemplate: MEMORY_FILTER_STRICT,
  },

  // Entity Extraction
  {
    key: 'entityExtraction.lenient',
    name: 'Lenient Extraction',
    description: 'Inclusive entity extraction that captures all mentioned entities.',
    category: 'entity',
    variables: [{ name: 'MEMORY_TEXT', description: 'Formatted list of memory statements' }],
    defaultTemplate: ENTITY_EXTRACTION_LENIENT,
  },
  {
    key: 'entityExtraction.balanced',
    name: 'Balanced Extraction',
    description: 'Balanced entity extraction for entities worth remembering.',
    category: 'entity',
    variables: [{ name: 'MEMORY_TEXT', description: 'Formatted list of memory statements' }],
    defaultTemplate: ENTITY_EXTRACTION_BALANCED,
  },
  {
    key: 'entityExtraction.strict',
    name: 'Strict Extraction',
    description: 'Very selective entity extraction for only high-value entities.',
    category: 'entity',
    variables: [{ name: 'MEMORY_TEXT', description: 'Formatted list of memory statements' }],
    defaultTemplate: ENTITY_EXTRACTION_STRICT,
  },
  {
    key: 'entitySummary',
    name: 'Entity Summary',
    description: 'Updates an entity profile summary with new facts.',
    category: 'entity',
    variables: [
      { name: 'NAME', description: 'Entity name' },
      { name: 'TYPE', description: 'Entity type (Person, Project, etc.)' },
      { name: 'EXISTING_SUMMARY', description: 'Current entity summary or "(none)"' },
      { name: 'NEW_FACTS', description: 'New facts to integrate (one per line, prefixed with "- ")' },
    ],
    defaultTemplate: ENTITY_SUMMARY,
  },

  // Session
  {
    key: 'sessionSummary',
    name: 'Session Summary',
    description: 'Extracts a user profile summary from a conversation for the master memory.',
    category: 'session',
    variables: [{ name: 'CONVERSATION_TEXT', description: 'Full conversation text with role labels' }],
    defaultTemplate: SESSION_SUMMARY,
  },

  // Chat
  {
    key: 'ragChat',
    name: 'Memory Chat',
    description: 'System prompt for the RAG-powered memory chat assistant.',
    category: 'chat',
    variables: [
      { name: 'HISTORY_BLOCK', description: 'Previous conversation history (may be empty)' },
      { name: 'QUERY', description: 'The user\'s current question' },
      { name: 'CONTEXT_BLOCK', description: 'Retrieved context from memories, messages, summaries, and entities' },
    ],
    defaultTemplate: RAG_CHAT,
  },

  // Master Memory - Merge (map-reduce final step)
  {
    key: 'masterMemory.merge',
    name: 'Merge Partials',
    description: 'Merges multiple partial summaries into the final master memory (used in map-reduce regeneration).',
    category: 'master-memory',
    variables: [{ name: 'PARTIAL_SUMMARIES', description: 'All partial summaries concatenated' }],
    defaultTemplate: MASTER_MEMORY_MERGE,
  },
];

// Build a lookup map for fast access
const registryMap = new Map<string, PromptDef>();
for (const def of PROMPT_REGISTRY) {
  registryMap.set(def.key, def);
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Returns the user-customized template if one exists, otherwise the default. */
export function getPromptTemplate(key: string): string {
  const def = registryMap.get(key);
  if (!def) throw new Error(`Unknown prompt key: ${key}`);
  return getSetting<string>(`prompt:${key}`, def.defaultTemplate);
}

/** Replaces {{VAR}} placeholders with the provided values. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    return vars[varName] !== undefined ? vars[varName] : match;
  });
}

/** Gets the (possibly customized) template for `key` and fills it with `vars`. */
export function getPrompt(key: string, vars: Record<string, string>): string {
  const template = getPromptTemplate(key);
  return fillTemplate(template, vars);
}

/** Returns the full registry for the Settings UI. */
export function getAllPromptDefs(): PromptDef[] {
  return PROMPT_REGISTRY;
}

/** Deletes a custom override so the prompt reverts to its default. */
export function resetPrompt(key: string): void {
  deleteSetting(`prompt:${key}`);
}
