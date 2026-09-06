// Renderer composition root: the shared chat session and context compaction over Desktop's IPC
// boundary. Each Desktop session owns one of each, so these are factories over supplied ports.
import {
  ChatSessionService,
  ContextCompactionService,
  type CompactableGenerationMessage
} from '@offgrid/models'

export function chatSessionService(
  ...ports: ConstructorParameters<typeof ChatSessionService>
): ChatSessionService {
  return new ChatSessionService(...ports)
}

export function chatContextCompactionService(
  ports: ConstructorParameters<typeof ContextCompactionService<CompactableGenerationMessage>>[0]
): ContextCompactionService<CompactableGenerationMessage> {
  return new ContextCompactionService<CompactableGenerationMessage>(ports)
}
