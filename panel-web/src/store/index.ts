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
  nodeId?: string
  nodeOrder?: number
  runId?: string
  text: string
  status: 'streaming'
  startedAt: string
  updatedAt: string
  seq?: number
}

export type ToolInvocationCard = ToolInvocation & {
  id: string
  sessionId: string
  nodeId?: string
  nodeOrder?: number
  runId?: string
  createdAt: string
  updatedAt: string
  timestamp: string
  seq?: number
  anchorTextLength?: number
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
  liveChatBySession: Record<string, LiveChatState[]>
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
  setLiveChat: (sessionId: string, params: {
    nodeId?: string
    nodeOrder?: number
    runId?: string
    text: string
    updatedAt?: string
    startedAt?: string
    seq?: number
  }) => void
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

const areStringListsEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) {
    return false
  }

  return left.every((value, index) => value === right[index])
}

const areAgentsEqual = (left: AgentSummary[], right: AgentSummary[]): boolean => {
  if (left.length !== right.length) {
    return false
  }

  return left.every((agent, index) => {
    const next = right[index]
    if (!next) {
      return false
    }

    return (
      agent.id === next.id
      && agent.name === next.name
      && agent.status === next.status
      && areStringListsEqual(agent.capabilities, next.capabilities)
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

const buildToolTranscriptItems = (
  sessionId: string,
  tools: ToolInvocationCard[],
  outcome: 'success' | 'error' | 'aborted',
): TranscriptItem[] => tools
  .map((tool) => {
    const createdAt = tool.createdAt || tool.updatedAt || isoNow()
    const normalizedStatus = tool.status === 'error'
      ? 'error'
      : outcome === 'success'
        ? 'done'
        : 'error'
    const transcriptStatus: TranscriptItem['status'] = tool.status === 'error'
      ? 'error'
      : outcome === 'aborted'
        ? 'aborted'
        : outcome === 'error'
          ? 'error'
          : 'complete'

    return {
      messageId: tool.id,
      sessionKey: sessionId,
      kind: 'tool',
      text: tool.result || tool.error || undefined,
      createdAt,
      timestamp: timestampFor(createdAt),
      status: transcriptStatus,
      toolInvocation: {
        toolName: tool.toolName,
        toolCallId: tool.toolCallId,
        command: tool.command,
        arguments: tool.arguments,
        result: tool.result,
        status: normalizedStatus,
        error: tool.error,
      },
    } satisfies TranscriptItem
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
    const nextCurrentSessionId = resolveCurrentSessionId(state.currentSessionId, nextSessions)

    if (
      areAgentsEqual(state.agents, agents)
      && state.currentAgentId === preferred
      && state.currentSessionId === nextCurrentSessionId
    ) {
      return state
    }

    return {
      ...state,
      agents,
      currentAgentId: preferred,
      currentSessionId: nextCurrentSessionId,
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
      [sessionId]: [],
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
    const currentSegments = state.liveChatBySession[sessionId] ?? []
    const segmentIdentity = params.nodeId || (params.runId ? `run:${params.runId}` : undefined)
    const existingIndex = segmentIdentity
      ? currentSegments.findIndex((segment) => (
          (segment.nodeId && segment.nodeId === segmentIdentity)
          || (!segment.nodeId && segment.runId && `run:${segment.runId}` === segmentIdentity)
        ))
      : currentSegments.length - 1

    if (existingIndex >= 0) {
      const existing = currentSegments[existingIndex]
      if (
        existing
        && existing.seq !== undefined
        && params.seq !== undefined
        && params.seq <= existing.seq
      ) {
        return state
      }

      const updatedAt = params.updatedAt || isoNow()
      const startedAt = params.startedAt || existing.startedAt || updatedAt
      const updatedSegment: LiveChatState = {
        ...existing,
        sessionId,
        nodeId: params.nodeId ?? existing.nodeId,
        nodeOrder: params.nodeOrder ?? existing.nodeOrder,
        runId: params.runId ?? existing.runId,
        text: params.text,
        status: 'streaming',
        startedAt,
        updatedAt,
        seq: params.seq ?? existing.seq,
      }

      const nextSegments = currentSegments.slice()
      nextSegments[existingIndex] = updatedSegment
      nextSegments.sort((left, right) => {
        const leftOrder = left.nodeOrder ?? Number.MAX_SAFE_INTEGER
        const rightOrder = right.nodeOrder ?? Number.MAX_SAFE_INTEGER
        if (leftOrder === rightOrder) {
          return left.startedAt < right.startedAt ? -1 : left.startedAt > right.startedAt ? 1 : 0
        }

        return leftOrder - rightOrder
      })

      return {
        ...state,
        liveChatBySession: {
          ...state.liveChatBySession,
          [sessionId]: nextSegments,
        },
      }
    }

    const createdAt = params.updatedAt || isoNow()
    const created: LiveChatState = {
      sessionId,
      nodeId: params.nodeId,
      nodeOrder: params.nodeOrder,
      runId: params.runId,
      text: params.text,
      status: 'streaming',
      startedAt: params.startedAt || createdAt,
      updatedAt: createdAt,
      seq: params.seq,
    }

    const nextSegments = [...currentSegments, created]
    nextSegments.sort((left, right) => {
      const leftOrder = left.nodeOrder ?? Number.MAX_SAFE_INTEGER
      const rightOrder = right.nodeOrder ?? Number.MAX_SAFE_INTEGER
      if (leftOrder === rightOrder) {
        return left.startedAt < right.startedAt ? -1 : left.startedAt > right.startedAt ? 1 : 0
      }

      return leftOrder - rightOrder
    })

    return {
      ...state,
      liveChatBySession: {
        ...state.liveChatBySession,
        [sessionId]: nextSegments,
      },
    }
  }),
  commitLiveChat: (sessionId, params) => set((state) => {
    const liveSegments = state.liveChatBySession[sessionId] ?? []
    const latestSegment = liveSegments[liveSegments.length - 1]
    const finalizedAt = params?.updatedAt || latestSegment?.updatedAt || isoNow()
    const fallbackLiveText = liveSegments.map((segment) => segment.text || '').join('')
    const finalText = params?.text ?? fallbackLiveText
    const { nextPendingBySession, transcriptItems: consumedPendingItems } = consumePendingComposerMessages(state, sessionId)
    const streamedTools = state.toolStreamBySession[sessionId] ?? []
    const nextItems = [
      ...consumedPendingItems,
      ...buildToolTranscriptItems(sessionId, streamedTools, 'success'),
    ]

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
        [sessionId]: [],
      },
      toolStreamBySession: {
        ...state.toolStreamBySession,
        [sessionId]: [],
      },
    }
  }),
  failLiveChat: (sessionId, params) => set((state) => {
    const liveSegments = state.liveChatBySession[sessionId] ?? []
    const latestSegment = liveSegments[liveSegments.length - 1]
    const failedAt = params.updatedAt || latestSegment?.updatedAt || isoNow()
    const fallbackLiveText = liveSegments.map((segment) => segment.text || '').join('')
    const { nextPendingBySession, transcriptItems: consumedPendingItems } = consumePendingComposerMessages(state, sessionId)
    const streamedTools = state.toolStreamBySession[sessionId] ?? []
    const nextItems = [
      ...consumedPendingItems,
      ...buildToolTranscriptItems(sessionId, streamedTools, params.aborted ? 'aborted' : 'error'),
    ]

    if (fallbackLiveText.trim()) {
      nextItems.push(buildAssistantTranscriptItem(sessionId, fallbackLiveText, failedAt, {
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
        [sessionId]: [],
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
    const incomingTool: ToolInvocationCard = {
      ...tool,
      id: toolId,
      sessionId,
      createdAt,
      updatedAt,
      timestamp: tool.timestamp || timestampFor(updatedAt),
      seq: tool.seq,
    }

    const currentTools = state.toolStreamBySession[sessionId] ?? []
    const nextTools = currentTools.some((item) => item.id === toolId || (item.toolCallId && item.toolCallId === incomingTool.toolCallId))
      ? currentTools.map((item) => {
          if (!(item.id === toolId || (item.toolCallId && item.toolCallId === incomingTool.toolCallId))) {
            return item
          }

          if (
            item.seq !== undefined
            && incomingTool.seq !== undefined
            && incomingTool.seq <= item.seq
          ) {
            return item
          }

          return {
            ...item,
            ...incomingTool,
            command: incomingTool.command ?? item.command,
            arguments: incomingTool.arguments ?? item.arguments,
            result: incomingTool.result ?? item.result,
            error: incomingTool.error ?? item.error,
            createdAt: item.createdAt || incomingTool.createdAt,
            updatedAt: incomingTool.updatedAt,
            timestamp: incomingTool.timestamp || item.timestamp,
            seq: incomingTool.seq ?? item.seq,
            anchorTextLength: item.anchorTextLength ?? incomingTool.anchorTextLength,
          }
        })
      : [...currentTools, incomingTool]

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
      [sessionId]: [],
    },
    toolStreamBySession: {
      ...state.toolStreamBySession,
      [sessionId]: [],
    },
  })),
  failAllLiveChats: (error) => set((state) => {
    const nextHistoryBySession = { ...state.historyBySession }
    const nextPendingBySession = { ...state.pendingComposerBySession }

    for (const [sessionId, liveSegments] of Object.entries(state.liveChatBySession)) {
      if (!liveSegments || liveSegments.length === 0) {
        continue
      }

      const { nextPendingBySession: consumedPending, transcriptItems: consumedPendingItems } = consumePendingComposerMessages(
        { ...state, pendingComposerBySession: nextPendingBySession } as State,
        sessionId,
      )
      Object.assign(nextPendingBySession, consumedPending)
      const streamedTools = state.toolStreamBySession[sessionId] ?? []
      const liveText = liveSegments.map((segment) => segment.text || '').join('')
      const latestSegment = liveSegments[liveSegments.length - 1]
      const updatedAt = latestSegment?.updatedAt || isoNow()

      const nextItems = liveText.trim()
        ? [
            ...consumedPendingItems,
            ...buildToolTranscriptItems(sessionId, streamedTools, 'error'),
            buildAssistantTranscriptItem(sessionId, liveText, updatedAt, { status: 'error' }),
          ]
        : [
            ...consumedPendingItems,
            ...buildToolTranscriptItems(sessionId, streamedTools, 'error'),
            buildErrorTranscriptItem(sessionId, error, updatedAt),
          ]

      nextHistoryBySession[sessionId] = appendTranscriptItems(nextHistoryBySession[sessionId] ?? [], nextItems)
    }

    return {
      ...state,
      historyBySession: nextHistoryBySession,
      pendingComposerBySession: nextPendingBySession,
      liveChatBySession: Object.fromEntries(
        Object.keys(state.liveChatBySession).map((sessionId) => [sessionId, []]),
      ),
      toolStreamBySession: Object.fromEntries(
        Object.keys(state.toolStreamBySession).map((sessionId) => [sessionId, []]),
      ),
    }
  }),
}))
