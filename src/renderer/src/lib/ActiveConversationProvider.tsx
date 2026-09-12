import { type ReactNode } from 'react'
import { ActiveConversationContext } from './active-conversation'

export function ActiveConversationProvider({
  conversationId,
  children
}: Readonly<{ conversationId: string | null; children: ReactNode }>): React.JSX.Element {
  return (
    <ActiveConversationContext.Provider value={conversationId}>
      {children}
    </ActiveConversationContext.Provider>
  )
}
