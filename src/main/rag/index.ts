// Assembles the desktop RAG: the shared RagService over the better-sqlite3
// store, MiniLM embeddings, and the Node/native extraction bridges. Also the
// project-chat flow: retrieve from the KB, prepend the project system prompt +
// context, call the active local model, and persist the thread.

import { RagService, formatForPrompt } from '@offgrid/rag';
import type { EmbeddingProvider } from '@offgrid/rag';
import { embeddings } from '../embeddings';
import { llm } from '../llm';
import { desktopVectorStore } from './store';
import { desktopExtraction } from './extractors';
import { appendThreadMessage, getThreadMessages, listProjects } from './store';

const embeddingProvider: EmbeddingProvider = {
  dimension: 384,
  embed: (text) => embeddings.generateEmbedding(text),
};

export const ragService = new RagService({
  store: desktopVectorStore,
  embeddings: embeddingProvider,
  extraction: desktopExtraction,
  chunkOptions: { chunkSize: 600, overlap: 120, minChunkLength: 20 },
});

function projectSystemPrompt(projectId: string): string {
  const p = listProjects().find((x) => x.id === projectId);
  return p?.systemPrompt?.trim() || 'You are a helpful assistant for this project.';
}

/**
 * Run one turn of a project chat: retrieve KB context for the query, assemble a
 * grounded prompt (system + history + context + question), call the active model,
 * and persist both messages to the thread. Returns the assistant reply.
 */
export async function projectChat(params: {
  projectId: string;
  threadId: string;
  message: string;
}): Promise<{ reply: string; sources: { name: string; position: number; score: number }[] }> {
  const { projectId, threadId, message } = params;

  // Retrieve (uploaded docs + captured memory) and format for the prompt.
  const search = await ragService.searchProject(projectId, message, { topK: 6, contextLength: 4096 });
  const context = formatForPrompt(search);

  const history = getThreadMessages(threadId)
    .slice(-8)
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n');

  const prompt = [
    projectSystemPrompt(projectId),
    context,
    history ? `Conversation so far:\n${history}` : '',
    `User: ${message}`,
    'Assistant:',
  ]
    .filter(Boolean)
    .join('\n\n');

  appendThreadMessage(threadId, 'user', message);
  const reply = (await llm.chat(prompt, [], 300000, 2048)).trim();
  appendThreadMessage(threadId, 'assistant', reply);

  const sources = search.chunks.map((c) => ({ name: c.name, position: c.position, score: c.score }));
  return { reply, sources };
}

export { desktopVectorStore } from './store';
export * from './store';
