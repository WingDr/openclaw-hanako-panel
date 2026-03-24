import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  formatRelativeTime,
  mapProxyChatHistoryMessage,
  type AgentSummary,
  type ChatSession,
  type TranscriptItem,
  type ToolInvocation,
} from '../api/client'
import { panelRealtime } from '../realtime/ws'
import { ChatFlowConnectionLayer, type SyncBootstrapResult } from './runtime/ChatFlowConnectionLayer'
import { applyChatFlowEvent } from './runtime/applyChatFlowEvent'
import { useChatStore, type LiveChatState, type PendingComposerMessage, type ToolInvocationCard } from '../store'

type ChatFlowModuleProps = {
  currentAgent?: AgentSummary
  currentAgentId: string
  currentSession?: ChatSession
  currentSessionId: string
}

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

function renderLiveChat(
  liveChat: LiveChatState,
  agentName?: string,
  options?: { key?: string; text?: string; allowEmpty?: boolean },
) {
  const text = options?.text ?? liveChat.text
  if (!options?.allowEmpty && !text.trim()) {
    return null
  }

  return (
    <div key={options?.key ?? `live:${liveChat.sessionId}`} className="pw-message-row is-agent">
      <div className="pw-message-bubble is-agent">
        <div className="pw-message-meta">
          <span>{agentName || 'Agent'}</span>
          <span>{new Date(liveChat.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div className="pw-message-text">{text || '...'}</div>
        <div className="pw-message-meta">
          <span>streaming</span>
        </div>
      </div>
    </div>
  )
}

export function ChatFlowModule(props: ChatFlowModuleProps) {
  const { currentAgent, currentAgentId, currentSession, currentSessionId } = props
  const historyBySession = useChatStore((state) => state.historyBySession)
  const liveChatBySession = useChatStore((state) => state.liveChatBySession)
  const toolStreamBySession = useChatStore((state) => state.toolStreamBySession)
  const pendingComposerBySession = useChatStore((state) => state.pendingComposerBySession)
  const markSessionOpened = useChatStore((state) => state.markSessionOpened)
  const setSessionHistory = useChatStore((state) => state.setSessionHistory)
  const clearSessionTransientState = useChatStore((state) => state.clearSessionTransientState)
  const enqueuePendingComposerMessage = useChatStore((state) => state.enqueuePendingComposerMessage)
  const markPendingComposerAccepted = useChatStore((state) => state.markPendingComposerAccepted)
  const markPendingComposerFailed = useChatStore((state) => state.markPendingComposerFailed)

  const [text, setText] = useState('')
  const [sendPending, setSendPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lastAck, setLastAck] = useState<string | null>(null)
  const [historyPending, setHistoryPending] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const connectionLayerRef = useRef<ChatFlowConnectionLayer | null>(null)
  const currentSessionIdRef = useRef<string>(currentSessionId)
  const messageStreamRef = useRef<HTMLDivElement | null>(null)
  const messageStreamEndRef = useRef<HTMLDivElement | null>(null)

  const currentHistory = historyBySession[currentSessionId] ?? emptyTranscript
  const currentLiveSegments = liveChatBySession[currentSessionId] ?? []
  const currentLiveChat = currentLiveSegments[currentLiveSegments.length - 1]
  const currentToolCards = toolStreamBySession[currentSessionId] ?? emptyToolCards
  const currentPendingMessages = pendingComposerBySession[currentSessionId] ?? emptyPendingMessages
  const currentAgentOffline = currentAgent?.status === 'offline'
  const hasAcceptedPending = currentPendingMessages.some((message) => message.status === 'accepted')
  const hasRuntimeActivity = currentLiveSegments.length > 0
    || currentToolCards.length > 0
    || currentPendingMessages.some((message) => message.status !== 'failed')
  const activeRunId = currentLiveChat?.runId ?? currentPendingMessages.find((message) => message.status === 'accepted' && message.runId)?.runId
  const runtimeTimelineItems = useMemo(() => {
    const toTime = (value?: string): number => {
      if (!value) {
        return 0
      }

      const parsed = Date.parse(value)
      return Number.isNaN(parsed) ? 0 : parsed
    }

    const sortedTools = currentToolCards
      .slice()
      .sort((left, right) => {
        const leftOrder = left.seq ?? Number.MAX_SAFE_INTEGER - 1
        const rightOrder = right.seq ?? Number.MAX_SAFE_INTEGER - 1
        if (leftOrder === rightOrder) {
          return toTime(left.updatedAt || left.createdAt) - toTime(right.updatedAt || right.createdAt)
        }

        return leftOrder - rightOrder
      })

    const nodes: React.ReactNode[] = []
    const liveEntries = currentLiveSegments.map((segment) => ({
      order: segment.nodeOrder ?? segment.seq ?? Number.MAX_SAFE_INTEGER,
      time: toTime(segment.updatedAt || segment.startedAt),
      node: renderLiveChat(segment, currentAgent?.name, {
        key: segment.nodeId
          ? `live:${currentSessionId}:${segment.nodeId}`
          : `live:${currentSessionId}:${segment.runId ?? segment.updatedAt}`,
        text: segment.text,
        allowEmpty: false,
      }),
    })).filter((entry) => Boolean(entry.node))

    const toolEntries = sortedTools.map((tool) => ({
      order: tool.nodeOrder ?? tool.seq ?? Number.MAX_SAFE_INTEGER,
      time: toTime(tool.updatedAt || tool.createdAt),
      node: renderToolCard(tool, {
        key: tool.id,
        timestamp: tool.timestamp,
        defaultOpen: tool.status === 'running' || tool.status === 'error',
        tone: 'live',
      }),
    }))

    return [...liveEntries, ...toolEntries]
      .sort((left, right) => {
        if (left.order === right.order) {
          return left.time - right.time
        }

        return left.order - right.order
      })
      .map((entry) => entry.node)
  }, [currentAgent?.name, currentLiveSegments, currentSessionId, currentToolCards])
  const hasVisibleContent = currentHistory.length > 0 || currentPendingMessages.length > 0 || runtimeTimelineItems.length > 0
  const canAbort = hasAcceptedPending || Boolean(currentLiveChat)
  const currentBusy = sendPending || canAbort
  const visibleMessageCount = currentHistory.length + currentPendingMessages.length + runtimeTimelineItems.length

  const scrollMessagesToBottom = () => {
    const container = messageStreamRef.current
    const anchor = messageStreamEndRef.current
    if (!container || !anchor) {
      return
    }

    anchor.scrollIntoView({ block: 'end' })
  }

  const applySessionSnapshots = (
    sessionSnapshots: SyncBootstrapResult['sessionSnapshots'] | undefined,
  ) => {
    if (!Array.isArray(sessionSnapshots)) {
      return
    }

    for (const snapshot of sessionSnapshots) {
      const sessionKey = typeof snapshot?.sessionKey === 'string' ? snapshot.sessionKey.trim() : ''
      if (!sessionKey) {
        continue
      }

      const transcript = Array.isArray(snapshot?.transcript)
        ? snapshot.transcript.map((item) => mapProxyChatHistoryMessage(item))
        : emptyTranscript

      clearSessionTransientState(sessionKey)
      setSessionHistory(sessionKey, transcript)
    }
  }

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId
  }, [currentSessionId])

  useEffect(() => {
    const layer = new ChatFlowConnectionLayer({
      realtime: panelRealtime,
      getCurrentSessionKey: () => currentSessionIdRef.current,
      applyEvent: applyChatFlowEvent,
      applySessionSnapshots,
      onSyncStateChange: (change) => {
        if (change.sessionKey !== currentSessionIdRef.current || change.silent) {
          return
        }

        if (change.phase === 'start') {
          setHistoryPending(true)
          setHistoryError(null)
          return
        }

        if (change.phase === 'error') {
          setHistoryError(change.error ?? 'Failed to bootstrap session sync')
          return
        }

        setHistoryPending(false)
      },
    })

    connectionLayerRef.current = layer
    layer.start()

    return () => {
      layer.stop()
      if (connectionLayerRef.current === layer) {
        connectionLayerRef.current = null
      }
    }
  }, [clearSessionTransientState, setSessionHistory])

  useEffect(() => {
    if (!currentSessionId) {
      setHistoryPending(false)
      setHistoryError(null)
      return
    }

    const layer = connectionLayerRef.current
    if (!layer) {
      return
    }

    void layer.openSession(currentSessionId).catch((error) => {
      setActionError(error instanceof Error ? error.message : 'Failed to subscribe current session')
    })

    if (currentSession?.status === 'pending') {
      setHistoryPending(false)
      setHistoryError(null)
      return
    }

    if (hasRuntimeActivity) {
      setHistoryPending(false)
      setHistoryError(null)
      return
    }

    void layer.syncSessions([currentSessionId], { reason: 'session-open' })
  }, [currentSession?.status, currentSessionId, hasRuntimeActivity])

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
      markSessionOpened(currentSessionId, new Date().toISOString())
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

  const statusText = useMemo(() => {
    if (currentLiveChat) {
      return `Streaming reply${currentToolCards.length > 0 ? ` · ${currentToolCards.length} tool updates` : ''}`
    }

    if (hasAcceptedPending) {
      return 'Waiting for stream to start'
    }

    if (currentAgent) {
      return `${currentAgent.name} is ready`
    }

    return 'Select an agent to continue'
  }, [currentAgent, currentLiveChat, currentToolCards.length, hasAcceptedPending])

  return (
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
        {runtimeTimelineItems}
        <div ref={messageStreamEndRef} className="pw-message-stream-end" aria-hidden="true" />
      </div>

      <div className="pw-input-shell">
        <div className="pw-input-meta">
          <span>{statusText}</span>
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
  )
}
