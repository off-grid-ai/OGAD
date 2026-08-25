export type TaskPanelKind = 'web_use' | 'computer_use'
export type LegacyTaskPanelKind = TaskPanelKind | 'web_task' | 'computer_task'

export interface OpenTaskPanelRequest {
  taskId?: string
  kind?: LegacyTaskPanelKind
}

type Listener = (request: OpenTaskPanelRequest) => void

const listeners = new Set<Listener>()

export function openTaskSidePanel(request: OpenTaskPanelRequest = {}): void {
  const normalized: OpenTaskPanelRequest = {
    ...request,
    ...(request.kind
      ? {
          kind:
            request.kind === 'web_task'
              ? 'web_use'
              : request.kind === 'computer_task'
                ? 'computer_use'
                : request.kind
        }
      : {})
  }
  for (const listener of listeners) {
    listener(normalized)
  }
}

export function onOpenTaskSidePanel(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
