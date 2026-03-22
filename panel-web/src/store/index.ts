import { create } from 'zustand'

export type Message = {
  id: string
  sessionId: string
  author: 'agent' | 'user'
  text: string
  timestamp: string
}
export type Session = { id: string; name: string; updated?: string }

type State = {
  sessions: Session[]
  currentSessionId: string
  messagesBySession: Record<string, Message[]>
  setSessionId: (id: string) => void
  addUserMessage: (sessionId: string, text: string) => void
  addAgentMessage: (sessionId: string, text: string) => void
}

const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export const useChatStore = create<State>((set) => {
  const initialSessions: Session[] = [
    { id: 'sess1', name: 'Session 1', updated: '2m' },
    { id: 'sess2', name: 'Session 2', updated: '5m' }
  ]
  const initialMessages: Record<string, Message[]> = {
    sess1: [
      { id: 'm1', sessionId: 'sess1', author: 'agent', text: 'Hi there — how can I help?', timestamp: '09:00' }
    ],
  }
  const appendMessage = (state: State, sessionId: string, author: Message['author'], text: string) => {
    const id = `m${Object.values(state.messagesBySession).flat().length + 1}`
    const message: Message = { id, sessionId, author, text, timestamp: now() }
    const nextMessages = state.messagesBySession[sessionId]
      ? [...state.messagesBySession[sessionId], message]
      : [message]

    return {
      ...state,
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: nextMessages,
      },
    }
  }

  return {
    sessions: initialSessions,
    currentSessionId: 'sess1',
    messagesBySession: initialMessages,
    setSessionId: (id: string) => set((s) => ({ ...s, currentSessionId: id })),
    addUserMessage: (sessionId: string, text: string) => set((state) => appendMessage(state, sessionId, 'user', text)),
    addAgentMessage: (sessionId: string, text: string) => set((state) => appendMessage(state, sessionId, 'agent', text)),
  }
})
