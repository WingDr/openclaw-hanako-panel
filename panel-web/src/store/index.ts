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
  sessionsByAgent: Record<string, ChatSession[]>
  currentSessionId: string
  messagesBySession: Record<string, Message[]>
  setAgents: (agents: AgentSummary[], preferredAgentId?: string) => void
  setCurrentAgentId: (id: string) => void
  replaceAgentSessions: (agentId: string, sessions: ChatSession[]) => void
  upsertAgentSession: (session: ChatSession) => void
  markSessionOpened: (sessionId: string, updatedAt?: string) => void
  setSessionId: (id: string) => void
  setSessionMessages: (sessionId: string, messages: Message[]) => void
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

const mergeSessionMessages = (history: Message[], existing: Message[]): Message[] => {
  const seen = new Set<string>()
  const merged: Message[] = []

  for (const message of [...history, ...existing]) {
    const signature = `${message.author}\u001f${message.timestamp}\u001f${message.text}`
    if (seen.has(signature)) {
      continue
    }

    seen.add(signature)
    merged.push(message)
  }

  return merged
}

const resolveCurrentSessionId = (currentSessionId: string, sessions: ChatSession[]): string => (
  sessions.some((session) => session.id === currentSessionId)
    ? currentSessionId
    : sessions[0]?.id || ''
)

const sortSessions = (sessions: ChatSession[]): ChatSession[] => sessions
  .slice()
  .sort((left, right) => {
    const leftUpdatedAt = left.updatedAt || ''
    const rightUpdatedAt = right.updatedAt || ''

    if (leftUpdatedAt === rightUpdatedAt) {
      return left.id.localeCompare(right.id)
    }

    return leftUpdatedAt > rightUpdatedAt ? -1 : 1
  })

const isHanakoPanelSession = (session: ChatSession, agentId: string): boolean => (
  session.agentId === agentId && session.id.startsWith(`agent:${agentId}:hanako-panel:`)
)

const mergeAgentSessions = (agentId: string, remoteSessions: ChatSession[], localSessions: ChatSession[]): ChatSession[] => {
  const mergedById = new Map<string, ChatSession>()

  for (const session of remoteSessions) {
    mergedById.set(session.id, session)
  }

  for (const session of localSessions) {
    if (!mergedById.has(session.id) && isHanakoPanelSession(session, agentId)) {
      mergedById.set(session.id, session)
    }
  }

  return sortSessions([...mergedById.values()])
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
    sessionsByAgent: {},
    currentSessionId: '',
    messagesBySession: {},
    setAgents: (agents, preferredAgentId) => set((state) => {
      const preferred = state.currentAgentId && agents.some((agent) => agent.id === state.currentAgentId)
        ? state.currentAgentId
        : preferredAgentId && agents.some((agent) => agent.id === preferredAgentId)
          ? preferredAgentId
          : agents[0]?.id || ''
      const nextSessions = state.sessionsByAgent[preferred] ?? []

      return {
        ...state,
        agents,
        currentAgentId: preferred,
        currentSessionId: resolveCurrentSessionId(state.currentSessionId, nextSessions),
      }
    }),
    setCurrentAgentId: (id) => set((state) => ({
      ...state,
      currentAgentId: id,
      currentSessionId: resolveCurrentSessionId(state.currentSessionId, state.sessionsByAgent[id] ?? []),
    })),
    replaceAgentSessions: (agentId, sessions) => set((state) => {
      const nextSessions = mergeAgentSessions(agentId, sessions, state.sessionsByAgent[agentId] ?? [])

      return {
        ...state,
        sessionsByAgent: {
          ...state.sessionsByAgent,
          [agentId]: nextSessions,
        },
        currentSessionId: state.currentAgentId === agentId
          ? resolveCurrentSessionId(state.currentSessionId, nextSessions)
          : state.currentSessionId,
      }
    }),
    upsertAgentSession: (session) => set((state) => {
      const currentSessions = state.sessionsByAgent[session.agentId] ?? []
      const nextSessions = sortSessions([
        session,
        ...currentSessions.filter((item) => item.id !== session.id),
      ])

      return {
        ...state,
        currentAgentId: session.agentId,
        sessionsByAgent: {
          ...state.sessionsByAgent,
          [session.agentId]: nextSessions,
        },
        currentSessionId: session.id,
      }
    }),
    markSessionOpened: (sessionId, updatedAt) => set((state) => {
      const nextUpdatedAt = updatedAt || new Date().toISOString()
      const nextSessionsByAgent = Object.fromEntries(
        Object.entries(state.sessionsByAgent).map(([agentId, sessions]) => [
          agentId,
          sortSessions(sessions.map((session) => (
            session.id === sessionId
              ? {
                  ...session,
                  status: 'opened',
                  updatedAt: nextUpdatedAt,
                }
              : session
          ))),
        ]),
      )

      return {
        ...state,
        sessionsByAgent: nextSessionsByAgent,
      }
    }),
    setSessionId: (id: string) => set((s) => ({ ...s, currentSessionId: id })),
    setSessionMessages: (sessionId: string, messages: Message[]) => set((state) => ({
      ...state,
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: mergeSessionMessages(messages, state.messagesBySession[sessionId] ?? []),
      },
    })),
    addUserMessage: (sessionId: string, text: string) => set((state) => appendMessage(state, sessionId, 'user', text)),
    addAgentMessage: (sessionId: string, text: string) => set((state) => appendMessage(state, sessionId, 'agent', text)),
  }
})
