import { create } from 'zustand'
import type { AgentSummary, ChatSession } from '../api/client'

export type Message = {
  id: string
  sessionId: string
  author: 'agent' | 'user'
  text: string
  timestamp: string
}

type State = {
  agents: AgentSummary[]
  currentAgentId: string
  sessions: ChatSession[]
  currentSessionId: string
  messagesBySession: Record<string, Message[]>
  setAgents: (agents: AgentSummary[], preferredAgentId?: string) => void
  setCurrentAgentId: (id: string) => void
  setSessions: (sessions: ChatSession[]) => void
  upsertSession: (session: ChatSession) => void
  setSessionId: (id: string) => void
  addUserMessage: (sessionId: string, text: string) => void
  addAgentMessage: (sessionId: string, text: string) => void
}

const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const messageId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const useChatStore = create<State>((set) => {
  const appendMessage = (state: State, sessionId: string, author: Message['author'], text: string) => {
    const message: Message = { id: messageId(), sessionId, author, text, timestamp: now() }
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
    agents: [],
    currentAgentId: '',
    sessions: [],
    currentSessionId: '',
    messagesBySession: {},
    setAgents: (agents, preferredAgentId) => set((state) => {
      const preferred = preferredAgentId && agents.some((agent) => agent.id === preferredAgentId)
        ? preferredAgentId
        : state.currentAgentId && agents.some((agent) => agent.id === state.currentAgentId)
          ? state.currentAgentId
          : agents[0]?.id || ''

      return {
        ...state,
        agents,
        currentAgentId: preferred,
      }
    }),
    setCurrentAgentId: (id) => set((state) => ({
      ...state,
      currentAgentId: id,
      sessions: [],
      currentSessionId: '',
    })),
    setSessions: (sessions) => set((state) => ({
      ...state,
      sessions,
      currentSessionId: sessions.some((session) => session.id === state.currentSessionId)
        ? state.currentSessionId
        : sessions[0]?.id || '',
    })),
    upsertSession: (session) => set((state) => {
      const existingIndex = state.sessions.findIndex((item) => item.id === session.id)
      const sessions = existingIndex >= 0
        ? state.sessions.map((item) => item.id === session.id ? session : item)
        : [session, ...state.sessions]

      return {
        ...state,
        sessions,
        currentSessionId: session.id,
      }
    }),
    setSessionId: (id: string) => set((s) => ({ ...s, currentSessionId: id })),
    addUserMessage: (sessionId: string, text: string) => set((state) => appendMessage(state, sessionId, 'user', text)),
    addAgentMessage: (sessionId: string, text: string) => set((state) => appendMessage(state, sessionId, 'agent', text)),
  }
})
