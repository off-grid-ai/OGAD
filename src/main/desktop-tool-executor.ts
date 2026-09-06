import type {
  GenerationToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolExecutorPort
} from '@offgrid/models'

export interface DesktopToolExecutionSession {
  prepare?(
    call: GenerationToolCall,
    context: ToolExecutionContext
  ): GenerationToolCall | Promise<GenerationToolCall>
  execute(call: GenerationToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>
}

/**
 * The shared generation service owns the loop. Desktop supplies the platform
 * execution boundary for the active turn, keyed by the shared turn identity.
 */
class DesktopToolExecutor implements ToolExecutorPort {
  private readonly sessions = new Map<string, DesktopToolExecutionSession>()

  register(turnId: string, session: DesktopToolExecutionSession): () => void {
    this.sessions.set(turnId, session)
    return () => {
      if (this.sessions.get(turnId) === session) this.sessions.delete(turnId)
    }
  }

  prepare(
    call: GenerationToolCall,
    context: ToolExecutionContext
  ): GenerationToolCall | Promise<GenerationToolCall> {
    const turnId = context.identity?.turnId
    const session = turnId ? this.sessions.get(turnId) : undefined
    return session?.prepare?.(call, context) ?? call
  }

  execute(call: GenerationToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const turnId = context.identity?.turnId
    const session = turnId ? this.sessions.get(turnId) : undefined
    if (!session) {
      return Promise.resolve({
        content: 'No Desktop tool execution session is active.',
        isError: true
      })
    }
    return session.execute(call, context)
  }
}

export const desktopToolExecutor = new DesktopToolExecutor()
