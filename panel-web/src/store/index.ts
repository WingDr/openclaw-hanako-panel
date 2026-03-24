import { create } from 'zustand'
import {
  formatClockTime,
  type AgentSummary,
  type ChatSession,
  type ToolInvocation,
  type TranscriptItem,
} from '../api/client'

export type LiveChatState = {
  sessionId: string
  runId?: string
  text: string
  status: 'streaming'
  startedAt: string
  updatedAt: string
}

export type ToolInvocationCard = ToolInvocation & {
  id: string
  sessionId: string
  runId?: string
  createdAt: string
  updatedAt: string
  timestamp: string
}

export type PendingComposerMessage = {
  id: string
  sessionId: string
  text: string
  status: 'pending' | 'accepted' | 'failed'
  createdAt: string
  timestamp: string
  runId?: string
  error?: string
}

type State = {
  agents: AgentSummary[]
  currentAgentId: string
  sessionsByAgent: Record<string, ChatSession[]>
  currentSessionId: string
  historyBySession: Record<string, TranscriptItem[]>
  liveChatBySession: Record<string, LiveChatState | undefined>
  toolStreamBySession: Record<string, ToolInvocationCard[]>
  pendingComposerBySession: Record<string, PendingComposerMessage[]>
  setAgents: (agents: AgentSummary[], preferredAgentId?: string) => void
  setCurrentAgentId: (id: string) => void
  replaceAgentSessions: (agentId: string, sessions: ChatSession[]) => void
  upsertAgentSession: (session: ChatSession) => void
  touchAgentSession: (session: ChatSession) => void
  markSessionOpened: (sessionId: string, updatedAt?: string) => void
  setSessionId: (id: string) => void
  setSessionHistory: (sessionId: string, items: TranscriptItem[]) => void
  clearSessionTransientState: (sessionId: string) => void
  enqueuePendingComposerMessage: (sessionId: string, text: string) => string
  markPendingComposerAccepted: (sessionId: string, messageId: string, runId?: string) => void
  markPendingComposerFailed: (sessionId: string, messageId: string, error?: string) => void
  setLiveChat: (sessionId: string, params: { runId?: string; text: string; updatedAt?: string; startedAt?: string }) => void
  commitLiveChat: (sessionId: string, params?: { runId?: string; text?: string; updatedAt?: string; messageId?: string }) => void
  failLiveChat: (sessionId: string, params: { runId?: string; error: string; aborted?: boolean; updatedAt?: string }) => void
  upsertToolInvocation: (sessionId: string, tool: Omit<ToolInvocationCard, 'sessionId' | 'timestamp'> & { timestamp?: string }) => void
  clearLiveState: (sessionId: string) => void
  failAllLiveChats: (error: string) => void
}

const isoNow = () => new Date().toISOString()

const timestampFor = (value: string) => formatClockTime(value)

const messageId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const normalizeTranscriptItem = (item: TranscriptItem): TranscriptItem => {
  const createdAt = item.createdAt || isoNow()
  return {
    ...item,
    createdAt,
    timestamp: item.timestamp || timestampFor(createdAt),
    status: item.status,
  }
}

const sortTranscriptItems = (items: TranscriptItem[]): TranscriptItem[] => items
  .slice()
  .map(normalizeTranscriptItem)
  .sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return left.messageId.localeCompare(right.messageId)
    }

    return left.createdAt < right.createdAt ? -1 : 1
  })

const sortPendingComposerMessages = (items: PendingComposerMessage[]): PendingComposerMessage[] => items
  .slice()
  .sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return left.id.localeCompare(right.id)
    }

    return left.createdAt < right.createdAt ? -1 : 1
  })

const sortToolCards = (items: ToolInvocationCard[]): ToolInvocationCard[] => items
  .slice()
  .sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return left.id.localeCompare(right.id)
    }

    return left.createdAt < right.createdAt ? -1 : 1
  })

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

const areSessionsEqual = (left: ChatSession[], right: ChatSession[]): boolean => {
  if (left.length !== right.length) {
    return false
  }

  return left.every((session, index) => {
    const next = right[index]
    return (
      session.id === next?.id
      && session.agentId === next.agentId
      && session.name === next.name
      && session.updatedAt === next.updatedAt
      && session.updated === next.updated
      && session.status === next.status
    )
  })
}

const appendTranscriptItems = (
  existing: TranscriptItem[],
  nextItems: TranscriptItem[],
): TranscriptItem[] => {
  const byId = new Map<string, TranscriptItem>()

  for (const item of existing) {
    byId.set(item.messageId, normalizeTranscriptItem(item))
  }

  for (const item of nextItems) {
    byId.set(item.messageId, normalizeTranscriptItem(item))
  }

  return sortTranscriptItems([...byId.values()])
}

const consumePendingComposerMessages = (
  state: State,
  sessionId: string,
): {
  nextPendingBySession: Record<string, PendingComposerMessage[]>
  transcriptItems: TranscriptItem[]
} => {
  const currentPending = state.pendingComposerBySession[sessionId] ?? []
  const readyMessages = currentPending.filter((message) => message.status !== 'failed')
  const remainingMessages = currentPending.filter((message) => message.status === 'failed')

  return {
    nextPendingBySession: {
      ...state.pendingComposerBySession,
      [sessionId]: remainingMessages,
    },
    transcriptItems: readyMessages.map((message) => ({
      messageId: message.id,
      sessionKey: sessionId,
      kind: 'user',
      text: message.text,
      createdAt: message.createdAt,
      timestamp: message.timestamp,
      status: 'complete',
    })),
  }
}

const buildAssistantTranscriptItem = (
  sessionId: string,
  text: string,
  createdAt: string,
  options?: { messageId?: string; status?: TranscriptItem['status'] },
): TranscriptItem => ({
  messageId: options?.messageId || messageId(),
  sessionKey: sessionId,
  kind: options?.status === 'error' || options?.status === 'aborted' ? 'error' : 'assistant',
  text,
  createdAt,
  timestamp: timestampFor(createdAt),
  status: options?.status || 'complete',
})

const buildErrorTranscriptItem = (
  sessionId: string,
  error: string,
  createdAt: string,
  aborted?: boolean,
): TranscriptItem => ({
  messageId: messageId(),
  sessionKey: sessionId,
  kind: 'error',
  text: error,
  createdAt,
  timestamp: timestampFor(createdAt),
  status: aborted ? 'aborted' : 'error',
})

export const useChatStore = create<State>((set) => ({
  agents: [],
  currentAgentId: '',
  sessionsByAgent: {},
  currentSessionId: '',
  historyBySession: {},
  liveChatBySession: {},
  toolStreamBySession: {},
  pendingComposerBySession: {},
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
    const currentSessions = state.sessionsByAgent[agentId] ?? []
    const nextSessions = mergeAgentSessions(agentId, sessions, state.sessionsByAgent[agentId] ?? [])
    if (areSessionsEqual(currentSessions, nextSessions)) {
      return state
    }

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
    if (areSessionsEqual(currentSessions, nextSessions) && state.currentSessionId === session.id && state.currentAgentId === session.agentId) {
      return state
    }

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
  touchAgentSession: (session) => set((state) => {
    const currentSessions = state.sessionsByAgent[session.agentId] ?? []
    const nextSessions = sortSessions([
      session,
      ...currentSessions.filter((item) => item.id !== session.id),
    ])
    if (areSessionsEqual(currentSessions, nextSessions)) {
      return state
    }

    return {
      ...state,
      sessionsByAgent: {
        ...state.sessionsByAgent,
        [session.agentId]: nextSessions,
      },
    }
  }),
  markSessionOpened: (sessionId, updatedAt) => set((state) => {
    const nextUpdatedAt = updatedAt || isoNow()
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
    const unchanged = Object.entries(state.sessionsByAgent).every(([agentId, sessions]) => (
      areSessionsEqual(sessions, nextSessionsByAgent[agentId] ?? [])
    ))
    if (unchanged) {
      return state
    }

    return {
      ...state,
      sessionsByAgent: nextSessionsByAgent,
    }
  }),
  setSessionId: (id) => set((state) => ({
    ...state,
    currentSessionId: id,
  })),
  setSessionHistory: (sessionId, items) => set((state) => ({
    ...state,
    historyBySession: {
      ...state.historyBySession,
      [sessionId]: sortTranscriptItems(items),
    },
  })),
  clearSessionTransientState: (sessionId) => set((state) => ({
    ...state,
    liveChatBySession: {
      ...state.liveChatBySession,
      [sessionId]: undefined,
    },
    toolStreamBySession: {
      ...state.toolStreamBySession,
      [sessionId]: [],
    },
    pendingComposerBySession: {
      ...state.pendingComposerBySession,
      [sessionId]: [],
    },
  })),
  enqueuePendingComposerMessage: (sessionId, text) => {
    const createdAt = isoNow()
    const id = messageId()

    set((state) => {
      const nextMessage: PendingComposerMessage = {
        id,
        sessionId,
        text,
        status: 'pending',
        createdAt,
        timestamp: timestampFor(createdAt),
      }

      return {
        ...state,
        pendingComposerBySession: {
          ...state.pendingComposerBySession,
          [sessionId]: sortPendingComposerMessages([
            ...(state.pendingComposerBySession[sessionId] ?? []),
            nextMessage,
          ]),
        },
      }
    })

    return id
  },
  markPendingComposerAccepted: (sessionId, messageIdToUpdate, runId) => set((state) => ({
    ...state,
    pendingComposerBySession: {
      ...state.pendingComposerBySession,
      [sessionId]: sortPendingComposerMessages((state.pendingComposerBySession[sessionId] ?? []).map((message) => (
        message.id === messageIdToUpdate
          ? {
              ...message,
              status: 'accepted',
              runId: runId ?? message.runId,
              error: undefined,
            }
          : message
      ))),
    },
  })),
  markPendingComposerFailed: (sessionId, messageIdToUpdate, error) => set((state) => ({
    ...state,
    pendingComposerBySession: {
      ...state.pendingComposerBySession,
      [sessionId]: sortPendingComposerMessages((state.pendingComposerBySession[sessionId] ?? []).map((message) => (
        message.id === messageIdToUpdate
          ? {
              ...message,
              status: 'failed',
              error,
            }
          : message
      ))),
    },
  })),
  setLiveChat: (sessionId, params) => set((state) => {
    const existing = state.liveChatBySession[sessionId]
    const startedAt = params.startedAt || existing?.startedAt || params.updatedAt || isoNow()
    const updatedAt = params.updatedAt || isoNow()

    return {
      ...state,
      liveChatBySession: {
        ...state.liveChatBySession,
        [sessionId]: {
          sessionId,
          runId: params.runId ?? existing?.runId,
          text: params.text,
          status: 'streaming',
          startedAt,
          updatedAt,
        },
      },
    }
  }),
  commitLiveChat: (sessionId, params) => set((state) => {
    const existingLive = state.liveChatBySession[sessionId]
    const finalizedAt = params?.updatedAt || existingLive?.updatedAt || isoNow()
    const finalText = params?.text ?? existingLive?.text ?? ''
    const { nextPendingBySession, transcriptItems: consumedPendingItems } = consumePendingComposerMessages(state, sessionId)
    const nextItems = [...consumedPendingItems]

    if (finalText.trim()) {
      nextItems.push(buildAssistantTranscriptItem(sessionId, finalText, finalizedAt, {
        messageId: params?.messageId,
      }))
    }

    return {
      ...state,
      historyBySession: {
        ...state.historyBySession,
        [sessionId]: appendTranscriptItems(state.historyBySession[sessionId] ?? [], nextItems),
      },
      pendingComposerBySession: nextPendingBySession,
      liveChatBySession: {
        ...state.liveChatBySession,
        [sessionId]: undefined,
      },
      toolStreamBySession: {
        ...state.toolStreamBySession,
        [sessionId]: [],
      },
    }
  }),
  failLiveChat: (sessionId, params) => set((state) => {
    const existingLive = state.liveChatBySession[sessionId]
    const failedAt = params.updatedAt || existingLive?.updatedAt || isoNow()
    const { nextPendingBySession, transcriptItems: consumedPendingItems } = consumePendingComposerMessages(state, sessionId)
    const nextItems = [...consumedPendingItems]

    if (existingLive?.text?.trim()) {
      nextItems.push(buildAssistantTranscriptItem(sessionId, existingLive.text, failedAt, {
        status: params.aborted ? 'aborted' : 'error',
      }))
    } else {
      nextItems.push(buildErrorTranscriptItem(sessionId, params.error, failedAt, params.aborted))
    }

    return {
      ...state,
      historyBySession: {
        ...state.historyBySession,
        [sessionId]: appendTranscriptItems(state.historyBySession[sessionId] ?? [], nextItems),
      },
      pendingComposerBySession: nextPendingBySession,
      liveChatBySession: {
        ...state.liveChatBySession,
        [sessionId]: undefined,
      },
      toolStreamBySession: {
        ...state.toolStreamBySession,
        [sessionId]: [],
      },
    }
  }),
  upsertToolInvocation: (sessionId, tool) => set((state) => {
    const toolId = tool.id || tool.toolCallId || `tool:${tool.runId || sessionId}:${tool.toolName}:${tool.createdAt}`
    const updatedAt = tool.updatedAt || isoNow()
    const createdAt = tool.createdAt || updatedAt
    const nextTool: ToolInvocationCard = {
      ...tool,
      id: toolId,
      sessionId,
      createdAt,
      updatedAt,
      timestamp: tool.timestamp || timestampFor(updatedAt),
    }

    const currentTools = state.toolStreamBySession[sessionId] ?? []
    const nextTools = currentTools.some((item) => item.id === toolId || (item.toolCallId && item.toolCallId === nextTool.toolCallId))
      ? currentTools.map((item) => (
          item.id === toolId || (item.toolCallId && item.toolCallId === nextTool.toolCallId)
            ? nextTool
            : item
        ))
      : [...currentTools, nextTool]

    return {
      ...state,
      toolStreamBySession: {
        ...state.toolStreamBySession,
        [sessionId]: sortToolCards(nextTools),
      },
    }
  }),
  clearLiveState: (sessionId) => set((state) => ({
    ...state,
    liveChatBySession: {
      ...state.liveChatBySession,
      [sessionId]: undefined,
    },
    toolStreamBySession: {
      ...state.toolStreamBySession,
      [sessionId]: [],
    },
  })),
  failAllLiveChats: (error) => set((state) => {
    const nextHistoryBySession = { ...state.historyBySession }
    const nextPendingBySession = { ...state.pendingComposerBySession }

    for (const [sessionId, liveChat] of Object.entries(state.liveChatBySession)) {
      if (!liveChat) {
        continue
      }

      const { nextPendingBySession: consumedPending, transcriptItems: consumedPendingItems } = consumePendingComposerMessages(
        { ...state, pendingComposerBySession: nextPendingBySession } as State,
        sessionId,
      )
      Object.assign(nextPendingBySession, consumedPending)

      const nextItems = liveChat.text.trim()
        ? [
            ...consumedPendingItems,
            buildAssistantTranscriptItem(sessionId, liveChat.text, liveChat.updatedAt, { status: 'error' }),
          ]
        : [
            ...consumedPendingItems,
            buildErrorTranscriptItem(sessionId, error, liveChat.updatedAt),
          ]

      nextHistoryBySession[sessionId] = appendTranscriptItems(nextHistoryBySession[sessionId] ?? [], nextItems)
    }

    return {
      ...state,
      historyBySession: nextHistoryBySession,
      pendingComposerBySession: nextPendingBySession,
      liveChatBySession: Object.fromEntries(
        Object.keys(state.liveChatBySession).map((sessionId) => [sessionId, undefined]),
      ),
      toolStreamBySession: Object.fromEntries(
        Object.keys(state.toolStreamBySession).map((sessionId) => [sessionId, []]),
      ),
    }
  }),
}))
