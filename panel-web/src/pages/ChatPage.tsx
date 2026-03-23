import React, { useEffect, useMemo, useState } from 'react'
import { fetchAgents, fetchBootstrap, fetchSessions, formatRelativeTime, mapProxySession } from '../api/client'
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
  const setAgents = useChatStore((state) => state.setAgents)
  const setCurrentAgentId = useChatStore((state) => state.setCurrentAgentId)
  const setSessions = useChatStore((state) => state.setSessions)
  const upsertSession = useChatStore((state) => state.upsertSession)
  const addUserMessage = useChatStore((state) => state.addUserMessage)
  const setSessionId = useChatStore((state) => state.setSessionId)
  const [text, setText] = useState('')
  const [loadingAgents, setLoadingAgents] = useState(true)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [createPending, setCreatePending] = useState(false)
  const [sendPending, setSendPending] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
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

  useEffect(() => {
    let cancelled = false

    const loadAgents = async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setLoadingAgents(true)
      }

      try {
        const [bootstrap, agents] = await Promise.all([fetchBootstrap(), fetchAgents()])
        if (cancelled) {
          return
        }

        setAgents(agents, bootstrap.defaultAgentId)
        setPageError(null)
      } catch (error) {
        if (!cancelled) {
          setPageError(error instanceof Error ? error.message : 'Failed to load agents')
        }
      } finally {
        if (!cancelled) {
          setLoadingAgents(false)
        }
      }
    }

    void loadAgents()
    const intervalId = window.setInterval(() => {
      void loadAgents({ silent: true })
    }, 10_000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [setAgents])

  useEffect(() => {
    if (!currentAgentId) {
      return
    }

    let cancelled = false

    const loadSessions = async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setLoadingSessions(true)
        setSessions([])
      }

      try {
        const nextSessions = await fetchSessions(currentAgentId)
        if (!cancelled) {
          setSessions(nextSessions)
          setPageError(null)
        }
      } catch (error) {
        if (!cancelled) {
          setPageError(error instanceof Error ? error.message : 'Failed to load sessions')
        }
      } finally {
        if (!cancelled) {
          setLoadingSessions(false)
        }
      }
    }

    void loadSessions()
    const intervalId = window.setInterval(() => {
      void loadSessions({ silent: true })
    }, 10_000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [currentAgentId, setSessions])

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

  const onSelectSession = (sessionId: string) => {
    setSessionId(sessionId)
    setActionError(null)
    void panelRealtime.sendCommand('session.open', { sessionKey: sessionId }).catch((error) => {
      setActionError(error instanceof Error ? error.message : 'Failed to open session')
    })
  }

  return (
    <div className="pw-chat-layout" style={{ display: 'grid', gridTemplateColumns: '260px 1fr 320px', gap: '16px', height: '100%', paddingRight: 8 }}>
      <section className="pw-panel pw-agent-panel" aria-label="Agents list" style={{ background: 'var(--surface)', borderRadius: '8px', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="pw-panel-title">Agents</div>
        {loadingAgents && <div className="pw-empty" style={{ color: '#888', padding: 8 }}>Loading agents...</div>}
        {!loadingAgents && agents.length === 0 && (
          <div className="pw-empty" style={{ color: '#888', padding: 8 }}>No agents returned by panel-proxy.</div>
        )}
        {agents.map((agent) => (
          <button
            key={agent.id}
            className="pw-agent-item"
            onClick={() => setCurrentAgentId(agent.id)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid transparent',
              background: agent.id === currentAgentId ? 'rgba(124, 58, 237, 0.18)' : 'rgba(255,255,255,0.02)',
              color: 'inherit',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontFamily: 'system-ui, sans-serif' }}>{agent.name}</span>
              <span style={{ color: statusColor[agent.status] }}>{agent.status}</span>
            </div>
            <div style={{ color: '#93a1c6', fontSize: 12 }}>
              {agent.capabilities.join(' / ') || (agent.status === 'unknown' ? 'Presence not exposed by Gateway' : 'No capabilities')}
            </div>
          </button>
        ))}
      </section>

      <section className="pw-workspace" aria-label="Chat workspace" style={{ background: 'var(--surface)', borderRadius: '8px', padding: 12, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="pw-workspace-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <strong>{currentSession?.name || 'No session selected'}</strong>
            <span className="pw-muted" style={{ color: '#a5a8c7', fontSize: 12 }}>
              {currentSessionId || 'Select or create a session to start chatting'}
            </span>
          </div>
          <span className="pw-muted" style={{ color: '#a5a8c7' }}>
            {sendPending ? 'Sending...' : currentAgent ? `${currentAgent.name} · ${currentAgent.status}` : 'Live'}
          </span>
        </div>
        {(pageError || actionError || lastAck) && (
          <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', color: pageError || actionError ? '#fca5a5' : '#93c5fd' }}>
            {pageError || actionError || lastAck}
          </div>
        )}
        <div className="pw-messages" style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
          {!currentSessionId && (
            <div className="pw-empty" style={{ color: '#888', padding: 8 }}>
              No session available for the selected agent yet.
            </div>
          )}
          {currentSessionId && currentMessages.length === 0 && (
            <div className="pw-empty" style={{ color: '#888', padding: 8 }}>
              This session is connected to panel-proxy. Sends now go through the real proxy/Gateway path, while transcript history is still local until the proxy exposes message read APIs.
            </div>
          )}
          {currentMessages.map((m: Message) => (
            <div key={m.id} className="pw-message" style={{ display: 'flex', margin: '6px 0', justifyContent: m.author === 'agent' ? 'flex-start' : 'flex-end' }}>
              <div style={{ maxWidth: '80%', padding: '8px 12px', borderRadius: 10, background: m.author === 'agent' ? '#1f2a44' : '#1a2b4a', color: '#e8eaff' }}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{m.timestamp}</div>
                <div style={{ fontFamily: 'system-ui, sans-serif' }}>{m.text}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="pw-input" style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 8 }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void onSend()
              }
            }}
            placeholder="Type a message..."
            disabled={!currentSessionId || sendPending || currentAgentOffline}
            style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: '#0e1220', color: 'white' }}
          />
          <button
            onClick={() => void onSend()}
            disabled={!currentSessionId || sendPending || currentAgentOffline}
            style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--primary)', color: 'white', border: 'none', opacity: !currentSessionId || sendPending || currentAgentOffline ? 0.6 : 1 }}
          >
            Send
          </button>
        </div>
      </section>

      <section className="pw-panel pw-chair-panel" aria-label="Sessions" style={{ background: 'var(--surface)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <div className="pw-panel-title" style={{ marginBottom: 0 }}>Sessions</div>
          <button
            onClick={() => void onCreateSession()}
            disabled={!currentAgentId || createPending || currentAgentOffline}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.03)', color: 'white', opacity: !currentAgentId || createPending || currentAgentOffline ? 0.6 : 1 }}
          >
            {createPending ? 'Creating...' : 'New'}
          </button>
        </div>
        {loadingSessions && <div className="pw-empty" style={{ color: '#888', padding: 8 }}>Loading sessions...</div>}
        {!loadingSessions && sessions.length === 0 && currentAgentId && (
          <div className="pw-empty" style={{ color: '#888', padding: 8 }}>No sessions for this agent yet.</div>
        )}
        {sessions.map((session) => (
          <button
            key={session.id}
            className="pw-session-item"
            onClick={() => onSelectSession(session.id)}
            style={{
              padding: '8px 10px',
              borderRadius: 6,
              cursor: 'pointer',
              border: '1px solid transparent',
              background: session.id === currentSessionId ? 'rgba(124, 58, 237, 0.18)' : 'rgba(255,255,255,0.02)',
              color: 'inherit',
              textAlign: 'left',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>{session.name}</span>
              <span style={{ color: '#9aa3ff', fontSize: 12 }}>{session.updated ?? formatRelativeTime(session.updatedAt) ?? ''}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
              <span style={{ color: '#7dd3fc', fontSize: 12 }}>{session.agentId}</span>
              <span style={{ color: statusColor[session.status || 'pending'], fontSize: 12 }}>{session.status || 'pending'}</span>
            </div>
          </button>
        ))}
      </section>
    </div>
  )
}
