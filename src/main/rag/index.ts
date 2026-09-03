// The desktop RAG is composed once, in the composition root; this module is its public door.
// Project chat runs through the main rag_conversations path (ipc.ts).
export { DesktopRagService, createDesktopRagService, ragService } from '../composition/rag'
export * from './store'
