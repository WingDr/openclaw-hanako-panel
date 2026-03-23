import React, { useMemo, useState } from 'react'
import { formatRelativeTime, mapProxySession } from '../api/client'
import { panelRealtime } from '../realtime/ws'
import { useChatStore } from '../store'
import type { Message } from '../store'

type CreatedSession = {
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

export default function ChatPage() {
  const agents = useChatStore((state) => state.agents)
  const currentAgentId = useChatStore((state) => state.currentAgentId)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const sessions = useChatStore((state) => state.sessions)
  const messagesBySession = useChatStore((state) => state.messagesBySession)
  const upsertSession = useChatStore((state) => state.upsertSession)
  const addUserMessage = useChatStore((state) => state.addUserMessage)
  const [text, setText] = useState('')
  const [createPending, setCreatePending] = useState(false)
  const [sendPending, setSendPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lastAck, setLastAck] = useState<string | null>(null)
  const currentAgent = useMemo(
    () => agents.find((agent) => agent.id === currentAgentId),
    [agents, currentAgentId],
  )
  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId),
    [currentSessionId, sessions],
  )
  const currentMessages: Message[] = messagesBySession[currentSessionId] ?? []
  const currentAgentOffline = currentAgent?.status === 'offline'

  const onSend = async () => {
    const trimmed = text.trim()
    if (!trimmed || !currentSessionId) {
      return
    }

    if (currentAgentOffline) {
      setActionError(`Agent ${currentAgent?.name || currentAgentId} is offline`)
      return
    }

    setLastAck(null)
    setText('')
    setActionError(null)
    addUserMessage(currentSessionId, trimmed)
    setSendPending(true)

    try {
      await panelRealtime.sendCommand('chat.send', {
        agentId: currentAgent?.id || currentAgentId,
        sessionKey: currentSessionId,
        text: trimmed,
      })
      setLastAck(`Message accepted${currentAgent ? ` for ${currentAgent.name}` : ''}`)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to send message')
    } finally {
      setSendPending(false)
    }
  }

  const onCreateSession = async () => {
    if (!currentAgentId) {
      return
    }

    if (currentAgentOffline) {
      setActionError(`Agent ${currentAgent?.name || currentAgentId} is offline`)
      return
    }

    const slug = `panel-${Date.now().toString(36)}`
    setCreatePending(true)
    setActionError(null)
    setLastAck(null)

    try {
      const response = await panelRealtime.sendCommand<{ accepted?: boolean; session?: CreatedSession }>('session.create', {
        agentId: currentAgentId,
        slug,
      })
      const created = response.result?.session
      if (created) {
        upsertSession(mapProxySession(created))
        setLastAck(`Prepared session ${created.sessionKey}`)
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to create session')
    } finally {
      setCreatePending(false)
    }
  }

  return (
    <div className="pw-chat-page">
      <header className="pw-chat-hero">
        <div>
          <p className="pw-section-kicker">Chat workspace</p>
          <h1>{currentSession?.name || 'No session selected'}</h1>
          <p className="pw-muted-copy">
            {currentSessionId || 'Pick an agent session from the left rail to start chatting.'}
          </p>
        </div>
        <div className="pw-chat-actions">
          <div className="pw-chat-presence">
            <span className="pw-presence-dot" style={{ backgroundColor: statusColor[currentAgent?.status || 'unknown'] }} />
            <span>{sendPending ? 'Sending...' : currentAgent ? `${currentAgent.name} · ${currentAgent.status}` : 'Waiting for agent'}</span>
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

      {(actionError || lastAck) && (
        <div className={actionError ? 'pw-error-banner' : 'pw-info-banner'}>
          {actionError || lastAck}
        </div>
      )}

      <section className="pw-chat-surface" aria-label="Chat workspace">
        <div className="pw-message-stream">
          {!currentSessionId && (
            <div className="pw-empty-state">
              No session available for the selected agent yet.
            </div>
          )}
          {currentSessionId && currentMessages.length === 0 && (
            <div className="pw-empty-state">
              This session is connected to panel-proxy. Sends now go through the real proxy/Gateway path, while transcript history is still local until the proxy exposes message read APIs.
            </div>
          )}
          {currentMessages.map((m: Message) => (
            <div key={m.id} className={`pw-message-row ${m.author === 'agent' ? 'is-agent' : 'is-user'}`}>
              <div className={`pw-message-bubble ${m.author === 'agent' ? 'is-agent' : 'is-user'}`}>
                <div className="pw-message-meta">
                  <span>{m.author === 'agent' ? currentAgent?.name || 'Agent' : 'You'}</span>
                  <span>{m.timestamp}</span>
                </div>
                <div className="pw-message-text">{m.text}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="pw-input-shell">
          <div className="pw-input-meta">
            <span>{currentAgent ? `${currentAgent.name} is ready` : 'Select an agent to continue'}</span>
            <span>{currentSession?.updated || formatRelativeTime(currentSession?.updatedAt) || 'Fresh session'}</span>
          </div>
          <div className="pw-input-row">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void onSend()
                }
              }}
              placeholder="Type a message to the selected agent..."
              disabled={!currentSessionId || sendPending || currentAgentOffline}
              className="pw-chat-input"
            />
            <button
              className="pw-primary-button"
              onClick={() => void onSend()}
              disabled={!currentSessionId || sendPending || currentAgentOffline}
            >
              Send
            </button>
          </div>
        </div>
      </section>

      <section className="pw-session-summary">
        <div className="pw-card-heading">
          <div>
            <p className="pw-section-kicker">Session notes</p>
            <h2>Current conversation context</h2>
          </div>
        </div>
        <div className="pw-session-facts">
          <div className="pw-fact-row">
            <span>Agent</span>
            <strong>{currentAgent?.name || 'Not selected'}</strong>
          </div>
          <div className="pw-fact-row">
            <span>Status</span>
            <strong>{currentAgent?.status || 'unknown'}</strong>
          </div>
          <div className="pw-fact-row">
            <span>Session key</span>
            <strong>{currentSessionId || 'Not opened yet'}</strong>
          </div>
          <div className="pw-fact-row">
            <span>Messages</span>
            <strong>{currentMessages.length}</strong>
          </div>
          <div className="pw-fact-row">
            <span>Updated</span>
            <strong>{currentSession?.updated || formatRelativeTime(currentSession?.updatedAt) || '--'}</strong>
          </div>
        </div>
        <div className="pw-inline-note">
          Channel sessions are intentionally hidden from the left tree. This workspace focuses only on agent conversation sessions.
        </div>
      </section>
    </div>
  )
}
