import { createContext, useContext } from 'react'

export const ActiveConversationContext = createContext<string | null>(null)

export function useActiveConversationId(): string | null {
  return useContext(ActiveConversationContext)
}
