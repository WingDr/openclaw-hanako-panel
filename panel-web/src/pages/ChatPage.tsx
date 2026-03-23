import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fetchChatHistory, fetchSessions, formatRelativeTime, mapProxySession, type ChatSession } from '../api/client'
import { panelRealtime } from '../realtime/ws'
import { useChatStore } from '../store'
import type { Message } from '../store'

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

export default function ChatPage() {
  const agents = useChatStore((state) => state.agents)
  const currentAgentId = useChatStore((state) => state.currentAgentId)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const sessionsByAgent = useChatStore((state) => state.sessionsByAgent)
  const messagesBySession = useChatStore((state) => state.messagesBySession)
  const upsertAgentSession = useChatStore((state) => state.upsertAgentSession)
  const replaceAgentSessions = useChatStore((state) => state.replaceAgentSessions)
  const markSessionOpened = useChatStore((state) => state.markSessionOpened)
  const setSessionMessages = useChatStore((state) => state.setSessionMessages)
  const addUserMessage = useChatStore((state) => state.addUserMessage)
  const [text, setText] = useState('')
  const [createPending, setCreatePending] = useState(false)
  const [sendPending, setSendPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lastAck, setLastAck] = useState<string | null>(null)
  const [historyPending, setHistoryPending] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const loadedHistorySessionIds = useRef<Set<string>>(new Set())
  const messageStreamRef = useRef<HTMLDivElement | null>(null)
  const messageStreamEndRef = useRef<HTMLDivElement | null>(null)
  const sessions = sessionsByAgent[currentAgentId] ?? emptySessions
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

  const scrollMessagesToBottom = () => {
    const container = messageStreamRef.current
    const anchor = messageStreamEndRef.current
    if (!container || !anchor) {
      return
    }

    anchor.scrollIntoView({ block: 'end' })
  }

  useEffect(() => {
    if (!currentSessionId) {
      setHistoryPending(false)
      setHistoryError(null)
      return
    }

    if (currentSession?.status === 'pending') {
      setHistoryPending(false)
      setHistoryError(null)
      return
    }

    const existingMessages = useChatStore.getState().messagesBySession[currentSessionId] ?? []
    if (loadedHistorySessionIds.current.has(currentSessionId) || existingMessages.length > 0) {
      setHistoryPending(false)
      setHistoryError(null)
      return
    }

    let cancelled = false
    setHistoryPending(true)
    setHistoryError(null)

    void fetchChatHistory(currentSessionId)
      .then((messages) => {
        if (cancelled) {
          return
        }

        setSessionMessages(currentSessionId, messages)
        loadedHistorySessionIds.current.add(currentSessionId)
      })
      .catch((error) => {
        if (!cancelled) {
          setHistoryError(error instanceof Error ? error.message : 'Failed to load session history')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHistoryPending(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [currentSession?.status, currentSessionId, setSessionMessages])

  useLayoutEffect(() => {
    if (!currentSessionId) {
      return
    }

    const firstFrameId = window.requestAnimationFrame(() => {
      const secondFrameId = window.requestAnimationFrame(() => {
        scrollMessagesToBottom()
      })

      ;(firstFrameId as unknown as { nestedFrameId?: number }).nestedFrameId = secondFrameId
    })

    return () => {
      const nestedFrameId = (firstFrameId as unknown as { nestedFrameId?: number }).nestedFrameId
      if (typeof nestedFrameId === 'number') {
        window.cancelAnimationFrame(nestedFrameId)
      }
      window.cancelAnimationFrame(firstFrameId)
    }
  }, [currentSessionId, currentMessages.length, historyPending])

  useEffect(() => {
    if (!currentSessionId || historyPending) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      scrollMessagesToBottom()
    }, 0)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [currentSessionId, currentMessages.length, historyPending])

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
      const updatedAt = new Date().toISOString()
      markSessionOpened(currentSessionId, updatedAt)
      try {
        const nextSessions = await fetchSessions(currentAgent?.id || currentAgentId)
        replaceAgentSessions(currentAgent?.id || currentAgentId, nextSessions)
      } catch {
      }
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

    setCreatePending(true)
    setActionError(null)
    setLastAck(null)

    try {
      const response = await panelRealtime.sendCommand<{ accepted?: boolean; session?: CreatedSession }>('session.create', {
        agentId: currentAgentId,
      })
      const created = response.result?.session
      if (created) {
        upsertAgentSession(mapProxySession(created))
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
        <div ref={messageStreamRef} className="pw-message-stream">
          {!currentSessionId && (
            <div className="pw-empty-state">
              No session available for the selected agent yet.
            </div>
          )}
          {currentSessionId && historyPending && currentMessages.length === 0 && (
            <div className="pw-empty-state">
              Loading conversation history...
            </div>
          )}
          {currentSessionId && !historyPending && historyError && currentMessages.length === 0 && (
            <div className="pw-empty-state">
              {historyError}
            </div>
          )}
          {currentSessionId && !historyPending && !historyError && currentMessages.length === 0 && (
            <div className="pw-empty-state">
              {currentSession?.status === 'pending' ? 'Send the first message to start this session.' : 'No messages in this session yet.'}
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
          <div ref={messageStreamEndRef} className="pw-message-stream-end" aria-hidden="true" />
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
    </div>
  )
}
