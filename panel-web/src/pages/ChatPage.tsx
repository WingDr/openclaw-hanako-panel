import React, { useMemo, useState } from 'react'
import { mapProxySession, type ChatSession } from '../api/client'
import { ChatFlowModule } from '../features/chat-flow/ChatFlowModule'
import { panelRealtime } from '../realtime/ws'
import { useChatStore, type PendingComposerMessage } from '../store'

type CreatedSession = {
  accepted?: boolean
  created?: boolean
  sessionKey: string
  agentId: string
  preview?: string
  updatedAt?: string
  status?: 'pending' | 'opened' | 'closed'
}

const statusColor: Record<string, string> = {
  online: '#4ade80',
  idle: '#fbbf24',
  offline: '#888',
  unknown: '#94a3b8',
  pending: '#fbbf24',
  opened: '#60a5fa',
  closed: '#a1a1aa',
}

const emptySessions: ChatSession[] = []
const emptyPendingMessages: PendingComposerMessage[] = []

export default function ChatPage() {
  const agents = useChatStore((state) => state.agents)
  const currentAgentId = useChatStore((state) => state.currentAgentId)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const sessionsByAgent = useChatStore((state) => state.sessionsByAgent)
  const liveChatBySession = useChatStore((state) => state.liveChatBySession)
  const pendingComposerBySession = useChatStore((state) => state.pendingComposerBySession)
  const upsertAgentSession = useChatStore((state) => state.upsertAgentSession)

  const [createPending, setCreatePending] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const sessions = sessionsByAgent[currentAgentId] ?? emptySessions
  const currentAgent = useMemo(
    () => agents.find((agent) => agent.id === currentAgentId),
    [agents, currentAgentId],
  )
  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId),
    [currentSessionId, sessions],
  )

  const currentPendingMessages = pendingComposerBySession[currentSessionId] ?? emptyPendingMessages
  const currentLiveSegments = liveChatBySession[currentSessionId] ?? []
  const currentLiveChat = currentLiveSegments[currentLiveSegments.length - 1]
  const hasAcceptedPending = currentPendingMessages.some((message) => message.status === 'accepted')
  const currentAgentOffline = currentAgent?.status === 'offline'

  const onCreateSession = async () => {
    if (!currentAgentId) {
      return
    }

    if (currentAgentOffline) {
      setCreateError(`Agent ${currentAgent?.name || currentAgentId} is offline`)
      return
    }

    setCreatePending(true)
    setCreateError(null)

    try {
      const response = await panelRealtime.sendCommand<{ accepted?: boolean; session?: CreatedSession }>('session.create', {
        agentId: currentAgentId,
      })
      const created = response.result?.session
      if (created) {
        upsertAgentSession(mapProxySession(created))
      }
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Failed to create session')
    } finally {
      setCreatePending(false)
    }
  }

  const presenceText = currentLiveChat
    ? `${currentAgent?.name || 'Agent'} · streaming`
    : hasAcceptedPending
      ? `${currentAgent?.name || 'Agent'} · awaiting stream`
      : currentAgent
        ? `${currentAgent.name} · ${currentAgent.status}`
        : 'Waiting for agent'

  return (
    <div className="pw-chat-page">
      <header className="pw-chat-hero pw-chat-hero-compact">
        <div className="pw-chat-actions">
          <div className="pw-chat-presence">
            <span className="pw-presence-dot" style={{ backgroundColor: statusColor[currentAgent?.status || 'unknown'] }} />
            <span>{presenceText}</span>
          </div>
          <button
            className="pw-primary-button"
            onClick={() => void onCreateSession()}
            disabled={!currentAgentId || createPending || currentAgentOffline}
          >
            {createPending ? 'Creating session...' : 'New session'}
          </button>
        </div>
      </header>
      {createError && <div className="pw-inline-note">{createError}</div>}

      <ChatFlowModule
        currentAgent={currentAgent}
        currentAgentId={currentAgentId}
        currentSession={currentSession}
        currentSessionId={currentSessionId}
      />
    </div>
  )
}
