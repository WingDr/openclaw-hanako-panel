import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MessageSquarePlus, Paperclip, SendHorizontal, Square, Wrench } from 'lucide-react'
import {
  mapProxyChatHistoryMessage,
  type AgentSummary,
  type ChatSession,
  type TranscriptItem,
} from '../../api/client'
import { panelRealtime } from '../../realtime/ws'
import {
  renderLiveChat,
  renderPendingComposerMessage,
  renderToolCard,
  renderTranscriptItem,
} from './ChatFlowMessageParts'
import { ChatFlowConnectionLayer, type SyncBootstrapResult } from './runtime/ChatFlowConnectionLayer'
import { applyChatFlowEvent } from './runtime/applyChatFlowEvent'
import { IconButton } from '../../components/IconButton'
import { useChatStore, type PendingComposerMessage, type ToolInvocationCard } from '../../store'

type ChatFlowModuleProps = {
  currentAgent?: AgentSummary
  currentAgentId: string
  currentSession?: ChatSession
  currentSessionId: string
}

const emptyTranscript: TranscriptItem[] = []
const emptyPendingMessages: PendingComposerMessage[] = []
const emptyToolCards: ToolInvocationCard[] = []

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
  const [historyPending, setHistoryPending] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const connectionLayerRef = useRef<ChatFlowConnectionLayer | null>(null)
  const currentSessionIdRef = useRef<string>(currentSessionId)
  const messageStreamRef = useRef<HTMLDivElement | null>(null)
  const messageStreamEndRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

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

    let secondFrameId: number | null = null
    const firstFrameId = window.requestAnimationFrame(() => {
      secondFrameId = window.requestAnimationFrame(() => {
        scrollMessagesToBottom()
      })
    })

    return () => {
      if (typeof secondFrameId === 'number') {
        window.cancelAnimationFrame(secondFrameId)
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

  useLayoutEffect(() => {
    const textarea = composerRef.current
    if (!textarea) {
      return
    }

    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`
  }, [text])

  const insertComposerNewline = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
      return
    }

    event.preventDefault()

    const textarea = event.currentTarget
    const selectionStart = textarea.selectionStart ?? text.length
    const selectionEnd = textarea.selectionEnd ?? text.length
    const nextValue = `${text.slice(0, selectionStart)}\n${text.slice(selectionEnd)}`
    const nextCaret = selectionStart + 1

    setText(nextValue)

    window.requestAnimationFrame(() => {
      const nextTextarea = composerRef.current
      if (!nextTextarea) {
        return
      }

      nextTextarea.selectionStart = nextCaret
      nextTextarea.selectionEnd = nextCaret
    })
  }

  const onSend = async () => {
    const trimmed = text.trim()
    if (!trimmed || !currentSessionId) {
      return
    }

    if (currentAgentOffline) {
      setActionError(`Agent ${currentAgent?.name || currentAgentId} is offline`)
      return
    }

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

    try {
      await panelRealtime.sendCommand('chat.abort', {
        ...(activeRunId ? { runId: activeRunId } : {}),
        sessionKey: currentSessionId,
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to stop current run')
    }
  }

  
  if (!currentSessionId) {
    return (
      <section className="pw-chat-surface" aria-label="Chat workspace" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: 'transparent', border: 'none', boxShadow: 'none' }}>
        <div style={{ textAlign: 'center', opacity: 0.5, maxWidth: 600, width: '100%' }}>
          <h2 style={{ fontSize: '2em', marginBottom: '20px', fontWeight: 'normal' }}>OpenClaw Hanako</h2>
          <div className="pw-input-shell" style={{ margin: '0 auto' }}>
            <div className="pw-input-textarea-shell">
              <textarea
                rows={1}
                disabled
                placeholder="Select or create a (+ New) session from the left panel..."
                className="pw-chat-input"
                style={{ textAlign: 'center', minHeight: '50px', fontSize: '1.1em', padding: '10px 15px', background: 'transparent' }}
              />
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="pw-chat-surface" aria-label="Chat workspace">
      <div ref={messageStreamRef} className="pw-message-stream">

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
        <div className="pw-input-textarea-shell">
          <textarea
            ref={composerRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={insertComposerNewline}
            placeholder="Type a message to the selected agent..."
            disabled={!currentSessionId || sendPending || currentAgentOffline || currentBusy}
            className="pw-chat-input"
          />
        </div>
        <div className="pw-input-toolbar">
          <div className="pw-input-toolset">
            <IconButton
              className="pw-tool-toggle-button"
              icon={MessageSquarePlus}
              label="Insert attachment"
              onClick={() => undefined}
            />
            <IconButton
              className="pw-tool-toggle-button"
              icon={Paperclip}
              label="Attach"
              onClick={() => undefined}
            />
            <IconButton
              className="pw-tool-toggle-button"
              icon={Wrench}
              label="Tools"
              onClick={() => undefined}
            />
          </div>
          <div className="pw-input-actions">
            {canAbort ? (
              <IconButton
                className="pw-primary-button"
                icon={Square}
                label="Stop"
                onClick={() => void onAbort()}
                disabled={sendPending}
              />
            ) : null}
            {!canAbort ? (
              <IconButton
                className="pw-primary-button"
                icon={SendHorizontal}
                label="Send"
                onClick={() => void onSend()}
                disabled={!currentSessionId || sendPending || currentAgentOffline || currentBusy}
              />
            ) : null}
          </div>
        </div>
        {actionError && (
          <div className="pw-inline-note">
            {actionError}
          </div>
        )}
      </div>
    </section>
  )
}
