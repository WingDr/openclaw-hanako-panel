import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fetchChatHistory, fetchSessions, formatRelativeTime, mapProxySession, type ChatSession, type TranscriptItem, type ToolInvocation } from '../api/client'
import { handleChatRealtimeEvent } from '../realtime/chatEventBridge'
import { panelRealtime } from '../realtime/ws'
import { useChatStore, type LiveChatState, type PendingComposerMessage, type ToolInvocationCard } from '../store'

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
const emptyTranscript: TranscriptItem[] = []
const emptyPendingMessages: PendingComposerMessage[] = []
const emptyToolCards: ToolInvocationCard[] = []

function renderToolCard(
  tool: ToolInvocation | ToolInvocationCard,
  meta: { key: string; timestamp?: string; defaultOpen?: boolean; tone?: 'history' | 'live' },
) {
  const headerTimestamp = meta.timestamp || 'tool'
  const result = tool.result?.trim()
  const argumentsText = tool.arguments?.trim()
  const command = tool.command?.trim()
  const hasBody = Boolean(command || argumentsText || result || tool.error)

  return (
    <div key={meta.key} className="pw-message-row is-agent">
      <div className={`pw-message-bubble is-agent pw-tool-card ${meta.tone === 'live' ? 'is-live' : ''}`}>
        <details open={meta.defaultOpen} className="pw-tool-details">
          <summary className="pw-message-meta pw-tool-summary">
            <span>{tool.toolName}</span>
            <span>{tool.status === 'running' ? 'running' : headerTimestamp}</span>
          </summary>
          <div className="pw-tool-chip-row">
            {command && <div className="pw-tool-chip"><span>Command</span><code>{command}</code></div>}
            {argumentsText && <div className="pw-tool-chip"><span>Args</span><code>{argumentsText}</code></div>}
          </div>
          {hasBody && (
            <div className="pw-tool-body">
              {result && (
                <div className="pw-tool-block">
                  <div className="pw-tool-block-label">Result</div>
                  <pre className="pw-message-text">{result}</pre>
                </div>
              )}
              {tool.error && (
                <div className="pw-tool-block">
                  <div className="pw-tool-block-label">Error</div>
                  <pre className="pw-message-text">{tool.error}</pre>
                </div>
              )}
            </div>
          )}
        </details>
      </div>
    </div>
  )
}

function renderTranscriptItem(item: TranscriptItem, agentName?: string) {
  if (item.kind === 'tool' && item.toolInvocation) {
    return renderToolCard(item.toolInvocation, {
      key: item.messageId,
      timestamp: item.timestamp,
      defaultOpen: false,
      tone: 'history',
    })
  }

  const isUser = item.kind === 'user'
  const isSystem = item.kind === 'system' || item.kind === 'error'

  return (
    <div key={item.messageId} className={`pw-message-row ${isUser ? 'is-user' : 'is-agent'}`}>
      <div className={`pw-message-bubble ${isUser ? 'is-user' : 'is-agent'}`}>
        <div className="pw-message-meta">
          <span>{isUser ? 'You' : isSystem ? 'System' : agentName || 'Agent'}</span>
          <span>{item.timestamp}</span>
        </div>
        {item.text && <div className="pw-message-text">{item.text}</div>}
        {(item.status === 'error' || item.status === 'aborted') && (
          <div className="pw-message-meta">
            <span>{item.status}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function renderPendingComposerMessage(message: PendingComposerMessage) {
  return (
    <div key={message.id} className="pw-message-row is-user">
      <div className="pw-message-bubble is-user">
        <div className="pw-message-meta">
          <span>You</span>
          <span>{message.timestamp}</span>
        </div>
        <div className="pw-message-text">{message.text}</div>
        <div className="pw-message-meta">
          <span>{message.status}</span>
          {message.error && <span>{message.error}</span>}
        </div>
      </div>
    </div>
  )
}

function renderLiveChat(liveChat: LiveChatState, agentName?: string) {
  return (
    <div key={`live:${liveChat.sessionId}`} className="pw-message-row is-agent">
      <div className="pw-message-bubble is-agent">
        <div className="pw-message-meta">
          <span>{agentName || 'Agent'}</span>
          <span>{new Date(liveChat.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div className="pw-message-text">{liveChat.text || '...'}</div>
        <div className="pw-message-meta">
          <span>streaming</span>
        </div>
      </div>
    </div>
  )
}

export default function ChatPage() {
  const agents = useChatStore((state) => state.agents)
  const currentAgentId = useChatStore((state) => state.currentAgentId)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const sessionsByAgent = useChatStore((state) => state.sessionsByAgent)
  const historyBySession = useChatStore((state) => state.historyBySession)
  const liveChatBySession = useChatStore((state) => state.liveChatBySession)
  const toolStreamBySession = useChatStore((state) => state.toolStreamBySession)
  const pendingComposerBySession = useChatStore((state) => state.pendingComposerBySession)
  const upsertAgentSession = useChatStore((state) => state.upsertAgentSession)
  const replaceAgentSessions = useChatStore((state) => state.replaceAgentSessions)
  const markSessionOpened = useChatStore((state) => state.markSessionOpened)
  const setSessionHistory = useChatStore((state) => state.setSessionHistory)
  const clearSessionTransientState = useChatStore((state) => state.clearSessionTransientState)
  const enqueuePendingComposerMessage = useChatStore((state) => state.enqueuePendingComposerMessage)
  const markPendingComposerAccepted = useChatStore((state) => state.markPendingComposerAccepted)
  const markPendingComposerFailed = useChatStore((state) => state.markPendingComposerFailed)
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
  const currentHistory = historyBySession[currentSessionId] ?? emptyTranscript
  const currentLiveChat = liveChatBySession[currentSessionId]
  const currentToolCards = toolStreamBySession[currentSessionId] ?? emptyToolCards
  const currentPendingMessages = pendingComposerBySession[currentSessionId] ?? emptyPendingMessages
  const currentAgentOffline = currentAgent?.status === 'offline'
  const hasAcceptedPending = currentPendingMessages.some((message) => message.status === 'accepted')
  const activeRunId = currentLiveChat?.runId ?? currentPendingMessages.find((message) => message.status === 'accepted' && message.runId)?.runId
  const hasVisibleContent = currentHistory.length > 0 || currentPendingMessages.length > 0 || Boolean(currentLiveChat) || currentToolCards.length > 0
  const canAbort = hasAcceptedPending || Boolean(currentLiveChat)
  const currentBusy = sendPending || canAbort
  const visibleMessageCount = currentHistory.length + currentPendingMessages.length + currentToolCards.length + (currentLiveChat ? 1 : 0)

  const scrollMessagesToBottom = () => {
    const container = messageStreamRef.current
    const anchor = messageStreamEndRef.current
    if (!container || !anchor) {
      return
    }

    anchor.scrollIntoView({ block: 'end' })
  }

  useEffect(() => {
    const unsubscribe = panelRealtime.subscribe(handleChatRealtimeEvent)
    return () => {
      unsubscribe()
    }
  }, [])

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

    const existingHistory = useChatStore.getState().historyBySession[currentSessionId] ?? []
    if (loadedHistorySessionIds.current.has(currentSessionId) || existingHistory.length > 0) {
      setHistoryPending(false)
      setHistoryError(null)
      return
    }

    let cancelled = false
    setHistoryPending(true)
    setHistoryError(null)
    clearSessionTransientState(currentSessionId)

    void fetchChatHistory(currentSessionId)
      .then((items) => {
        if (cancelled) {
          return
        }

        setSessionHistory(currentSessionId, items)
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
  }, [clearSessionTransientState, currentSession?.status, currentSessionId, setSessionHistory])

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
  }, [currentSessionId, historyPending, visibleMessageCount])

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
  }, [currentSessionId, historyPending, visibleMessageCount])

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
    const pendingMessageId = enqueuePendingComposerMessage(currentSessionId, trimmed)
    setSendPending(true)

    try {
      const response = await panelRealtime.sendCommand<{ accepted?: boolean; runId?: string; sessionKey?: string }>('chat.send', {
        sessionKey: currentSessionId,
        text: trimmed,
      })
      const acknowledgedRunId = typeof response.result?.runId === 'string' ? response.result.runId : undefined
      markPendingComposerAccepted(currentSessionId, pendingMessageId, acknowledgedRunId)
      const updatedAt = new Date().toISOString()
      markSessionOpened(currentSessionId, updatedAt)
      try {
        const nextSessions = await fetchSessions(currentAgentId)
        replaceAgentSessions(currentAgentId, nextSessions)
      } catch {
      }
      setLastAck(`Message accepted${currentAgent ? ` for ${currentAgent.name}` : ''}`)
    } catch (error) {
      markPendingComposerFailed(
        currentSessionId,
        pendingMessageId,
        error instanceof Error ? error.message : 'Failed to send message',
      )
      setText(trimmed)
      setActionError(error instanceof Error ? error.message : 'Failed to send message')
    } finally {
      setSendPending(false)
    }
  }

  const onAbort = async () => {
    if (!currentSessionId || !canAbort) {
      return
    }

    setActionError(null)
    setLastAck(null)

    try {
      await panelRealtime.sendCommand('chat.abort', {
        ...(activeRunId ? { runId: activeRunId } : {}),
        sessionKey: currentSessionId,
      })
      setLastAck('Stop requested')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to stop current run')
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
            <span>
              {currentLiveChat
                ? `${currentAgent?.name || 'Agent'} · streaming`
                : hasAcceptedPending
                  ? `${currentAgent?.name || 'Agent'} · awaiting stream`
                  : sendPending
                    ? 'Sending...'
                    : currentAgent
                      ? `${currentAgent.name} · ${currentAgent.status}`
                      : 'Waiting for agent'}
            </span>
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
          {currentSessionId && historyPending && !hasVisibleContent && (
            <div className="pw-empty-state">
              Loading conversation history...
            </div>
          )}
          {currentSessionId && !historyPending && historyError && !hasVisibleContent && (
            <div className="pw-empty-state">
              {historyError}
            </div>
          )}
          {currentSessionId && !historyPending && !historyError && !hasVisibleContent && (
            <div className="pw-empty-state">
              {currentSession?.status === 'pending' ? 'Send the first message to start this session.' : 'No messages in this session yet.'}
            </div>
          )}
          {currentHistory.map((item) => renderTranscriptItem(item, currentAgent?.name))}
          {currentPendingMessages.map((message) => renderPendingComposerMessage(message))}
          {currentLiveChat && renderLiveChat(currentLiveChat, currentAgent?.name)}
          {currentToolCards.map((tool) => renderToolCard(tool, {
            key: tool.id,
            timestamp: tool.timestamp,
            defaultOpen: tool.status === 'running' || tool.status === 'error',
            tone: 'live',
          }))}
          <div ref={messageStreamEndRef} className="pw-message-stream-end" aria-hidden="true" />
        </div>

        <div className="pw-input-shell">
          <div className="pw-input-meta">
            <span>
              {currentLiveChat
                ? `Streaming reply${currentToolCards.length > 0 ? ` · ${currentToolCards.length} tool updates` : ''}`
                : hasAcceptedPending
                  ? 'Waiting for stream to start'
                  : currentAgent
                    ? `${currentAgent.name} is ready`
                    : 'Select an agent to continue'}
            </span>
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
              disabled={!currentSessionId || sendPending || currentAgentOffline || currentBusy}
              className="pw-chat-input"
            />
            {canAbort && (
              <button
                className="pw-secondary-button"
                onClick={() => void onAbort()}
                disabled={sendPending}
              >
                Stop
              </button>
            )}
            <button
              className="pw-primary-button"
              onClick={() => void onSend()}
              disabled={!currentSessionId || sendPending || currentAgentOffline || currentBusy}
            >
              Send
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
