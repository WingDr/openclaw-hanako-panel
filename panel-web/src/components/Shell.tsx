import React, { useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { fetchAgents, fetchBootstrap, fetchSessions, formatRelativeTime } from '../api/client'
import { panelRealtime } from '../realtime/ws'
import { useChatStore } from '../store'

const statusLabelTone: Record<string, string> = {
  online: 'tone-good',
  idle: 'tone-warn',
  offline: 'tone-bad',
  unknown: 'tone-muted',
  pending: 'tone-warn',
  opened: 'tone-accent',
  closed: 'tone-muted',
}

function isConversationSession(sessionId: string, sessionName: string): boolean {
  const value = `${sessionId} ${sessionName}`.toLowerCase()
  return ![
    'channel:',
    ':channel:',
    'channel session',
    'channel-session',
    '/channels/',
  ].some((pattern) => value.includes(pattern))
}

export default function Shell({ children }: { children?: React.ReactNode }) {
  const location = useLocation()
  const agents = useChatStore((state) => state.agents)
  const currentAgentId = useChatStore((state) => state.currentAgentId)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const sessions = useChatStore((state) => state.sessions)
  const setAgents = useChatStore((state) => state.setAgents)
  const setCurrentAgentId = useChatStore((state) => state.setCurrentAgentId)
  const setSessions = useChatStore((state) => state.setSessions)
  const setSessionId = useChatStore((state) => state.setSessionId)
  const [loadingAgents, setLoadingAgents] = React.useState(true)
  const [loadingSessions, setLoadingSessions] = React.useState(false)
  const [sidebarError, setSidebarError] = React.useState<string | null>(null)
  const [proxyVersion, setProxyVersion] = React.useState<string>('unknown')
  const [gatewayConnected, setGatewayConnected] = React.useState(false)
  const isManageRoute = location.pathname.startsWith('/manage')

  useEffect(() => {
    let cancelled = false

    const loadAgents = async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setLoadingAgents(true)
      }

      try {
        const [bootstrap, nextAgents] = await Promise.all([fetchBootstrap(), fetchAgents()])
        if (cancelled) {
          return
        }

        setProxyVersion(bootstrap.proxyVersion)
        setGatewayConnected(bootstrap.gateway.connected)
        setAgents(nextAgents, bootstrap.defaultAgentId)
        setSidebarError(null)
      } catch (error) {
        if (!cancelled) {
          setSidebarError(error instanceof Error ? error.message : 'Failed to load agents')
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
      setSessions([])
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
          setSessions(nextSessions.filter((session) => isConversationSession(session.id, session.name)))
          setSidebarError(null)
        }
      } catch (error) {
        if (!cancelled) {
          setSidebarError(error instanceof Error ? error.message : 'Failed to load sessions')
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

  const handleSelectSession = (sessionId: string) => {
    setSessionId(sessionId)
    void panelRealtime.sendCommand('session.open', { sessionKey: sessionId }).catch((error) => {
      setSidebarError(error instanceof Error ? error.message : 'Failed to open session')
    })
  }

  return (
    <div className={`pw-app-shell ${isManageRoute ? 'is-manage' : 'is-chat'}`}>
      {!isManageRoute && (
        <aside className="pw-sidebar" aria-label="Agent workspace">
          <div className="pw-sidebar-header">
            <div>
              <p className="pw-brand-kicker">OpenClaw Panel</p>
              <h1 className="pw-brand-title">Hanako Workspace</h1>
            </div>
            <div className={`pw-pill ${gatewayConnected ? 'tone-good' : 'tone-bad'}`}>
              {gatewayConnected ? 'Gateway live' : 'Gateway down'}
            </div>
          </div>

          <div className="pw-sidebar-meta">
            <span>Agent sessions</span>
            <span>Proxy {proxyVersion}</span>
          </div>

          <div className="pw-agent-list">
            {loadingAgents && <div className="pw-empty-state">Loading agents...</div>}
            {!loadingAgents && agents.length === 0 && (
              <div className="pw-empty-state">No agents returned by panel-proxy.</div>
            )}
            {agents.map((agent) => {
              const active = agent.id === currentAgentId

              return (
                <section
                  key={agent.id}
                  className={`pw-agent-card ${active ? 'is-active' : ''}`}
                >
                  <button
                    className="pw-agent-button"
                    onClick={() => {
                      if (agent.id !== currentAgentId) {
                        setCurrentAgentId(agent.id)
                      }
                    }}
                  >
                    <div className="pw-agent-avatar">{agent.name.slice(0, 1)}</div>
                    <div className="pw-agent-copy">
                      <div className="pw-agent-topline">
                        <span className="pw-agent-name">{agent.name}</span>
                        <span className={`pw-badge ${statusLabelTone[agent.status] || 'tone-muted'}`}>
                          {agent.status}
                        </span>
                      </div>
                      <div className="pw-agent-subline">
                        {agent.capabilities.join(' · ') || 'No capability metadata'}
                      </div>
                    </div>
                  </button>

                  {active && (
                    <div className="pw-session-tree">
                      <div className="pw-session-tree-label">Conversation sessions</div>
                      {loadingSessions && <div className="pw-empty-state small">Loading sessions...</div>}
                      {!loadingSessions && sessions.length === 0 && (
                        <div className="pw-empty-state small">No conversation sessions for this agent.</div>
                      )}
                      {sessions.map((session) => (
                        <button
                          key={session.id}
                          className={`pw-session-button ${session.id === currentSessionId ? 'is-active' : ''}`}
                          onClick={() => handleSelectSession(session.id)}
                        >
                          <div className="pw-session-title-row">
                            <span className="pw-session-title">{session.name}</span>
                            <span className="pw-session-time">
                              {session.updated || formatRelativeTime(session.updatedAt) || '--'}
                            </span>
                          </div>
                          <div className="pw-session-meta-row">
                            <span className="pw-session-key">{session.id}</span>
                            <span className={`pw-badge ${statusLabelTone[session.status || 'pending'] || 'tone-muted'}`}>
                              {session.status || 'pending'}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
          </div>

          {sidebarError && <div className="pw-sidebar-alert">{sidebarError}</div>}
        </aside>
      )}

      <section className={`pw-main-column ${isManageRoute ? 'is-manage' : 'is-chat'}`}>
        <header className={`pw-main-header ${isManageRoute ? 'is-manage' : 'is-chat'}`}>
          <div className="pw-header-side" aria-hidden="true" />
          <div className="pw-header-center">
            <div className="pw-tab-strip" aria-label="Workspace sections">
              <NavLink to="/chat" className={({ isActive }) => `pw-tab-link ${isActive ? 'is-active' : ''}`}>
                Chat
              </NavLink>
              <NavLink to="/manage" className={({ isActive }) => `pw-tab-link ${isActive ? 'is-active' : ''}`}>
                Manage panel
              </NavLink>
            </div>
          </div>
          <div className="pw-header-side is-context">
            {!isManageRoute && (
              <div className="pw-header-context">
                <span className="pw-header-label">{agents.find((agent) => agent.id === currentAgentId)?.name || 'No agent selected'}</span>
                <span className="pw-header-secondary">{currentSessionId || 'Choose a session to begin'}</span>
              </div>
            )}
          </div>
        </header>

        <main className={`pw-main-surface ${isManageRoute ? 'is-manage' : 'is-chat'}`}>
          {children ?? <Outlet />}
        </main>
      </section>

      {!isManageRoute && (
        <aside className="pw-right-rail" aria-label="Reserved side panel">
          <div className="pw-right-rail-card">
            <p className="pw-section-kicker">Right Rail</p>
            <h2>Reserved space</h2>
            <p className="pw-muted-copy">
              This column stays empty for now, so later we can embed preview, artifacts, or agent-side inspector tools
              without disturbing chat and management flows.
            </p>
          </div>
        </aside>
      )}
    </div>
  )
}
