import React, { useEffect, useMemo } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { fetchAgents, fetchBootstrap, fetchSessions, formatRelativeTime, type ChatSession } from '../api/client'
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

function isChannelSession(sessionId: string, sessionName: string): boolean {
  const value = `${sessionId} ${sessionName}`.toLowerCase()
  return [
    'channel:',
    ':channel:',
    'channel session',
    'channel-session',
    '/channels/',
  ].some((pattern) => value.includes(pattern))
}

function isHanakoPanelSession(agentId: string, sessionId: string): boolean {
  return sessionId.startsWith(`agent:${agentId}:hanako-panel:`)
}

function getSessionChannelName(agentId: string, sessionId: string, sessionName: string): string | undefined {
  if (isHanakoPanelSession(agentId, sessionId)) {
    return undefined
  }

  const colonParts = sessionId.split(':').map((part) => part.trim()).filter(Boolean)
  if (colonParts[0] === 'agent' && colonParts[2]) {
    return colonParts[2]
  }

  const channelIndex = colonParts.findIndex((part) => part.toLowerCase() === 'channel')
  if (channelIndex >= 0 && colonParts[channelIndex + 1]) {
    return colonParts[channelIndex + 1]
  }

  if (colonParts[0]) {
    return colonParts[0]
  }

  const slashParts = sessionId.split('/').map((part) => part.trim()).filter(Boolean)
  if (slashParts[0]) {
    return slashParts[0]
  }

  if (isChannelSession(sessionId, sessionName)) {
    return 'channel'
  }

  return sessionName.trim() || sessionId
}

function formatChannelLabel(channelName: string): string {
  return channelName
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function splitSessionsByKind(agentId: string, agentSessions: ChatSession[]) {
  const regularSessions: ChatSession[] = []
  const channelSessionsByGroup = new Map<string, ChatSession[]>()

  for (const session of agentSessions) {
    const channelName = getSessionChannelName(agentId, session.id, session.name)
    if (!channelName) {
      regularSessions.push(session)
      continue
    }

    const currentGroup = channelSessionsByGroup.get(channelName) ?? []
    currentGroup.push(session)
    channelSessionsByGroup.set(channelName, currentGroup)
  }

  const channelGroups = Array.from(channelSessionsByGroup.entries())
    .map(([channelName, sessions]) => ({
      channelName,
      label: formatChannelLabel(channelName),
      sessions,
    }))
    .sort((left, right) => left.label.localeCompare(right.label))

  return { regularSessions, channelGroups }
}

export default function Shell({ children }: { children?: React.ReactNode }) {
  const location = useLocation()
  const agents = useChatStore((state) => state.agents)
  const currentAgentId = useChatStore((state) => state.currentAgentId)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const sessionsByAgent = useChatStore((state) => state.sessionsByAgent)
  const setAgents = useChatStore((state) => state.setAgents)
  const setCurrentAgentId = useChatStore((state) => state.setCurrentAgentId)
  const replaceAgentSessions = useChatStore((state) => state.replaceAgentSessions)
  const setSessionId = useChatStore((state) => state.setSessionId)
  const [loadingAgents, setLoadingAgents] = React.useState(true)
  const [loadingSessionAgentIds, setLoadingSessionAgentIds] = React.useState<string[]>([])
  const [expandedAgentIds, setExpandedAgentIds] = React.useState<string[]>([])
  const [expandedChannelAgentIds, setExpandedChannelAgentIds] = React.useState<string[]>([])
  const [expandedChannelGroupIds, setExpandedChannelGroupIds] = React.useState<string[]>([])
  const [sidebarError, setSidebarError] = React.useState<string | null>(null)
  const [proxyVersion, setProxyVersion] = React.useState<string>('unknown')
  const [gatewayConnected, setGatewayConnected] = React.useState(false)
  const isManageRoute = location.pathname.startsWith('/manage')
  const expandedAgentIdSet = useMemo(() => new Set(expandedAgentIds), [expandedAgentIds])
  const expandedChannelAgentIdSet = useMemo(() => new Set(expandedChannelAgentIds), [expandedChannelAgentIds])
  const expandedChannelGroupIdSet = useMemo(() => new Set(expandedChannelGroupIds), [expandedChannelGroupIds])
  const loadingSessionAgentIdSet = useMemo(() => new Set(loadingSessionAgentIds), [loadingSessionAgentIds])

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
    const validAgentIds = new Set(agents.map((agent) => agent.id))
    setExpandedAgentIds((currentIds) => currentIds.filter((id) => validAgentIds.has(id)))
    setExpandedChannelAgentIds((currentIds) => currentIds.filter((id) => validAgentIds.has(id)))
    setExpandedChannelGroupIds((currentIds) => currentIds.filter((id) => {
      const [agentId] = id.split('::')
      return validAgentIds.has(agentId)
    }))
  }, [agents])

  useEffect(() => {
    const targetAgentIds = Array.from(new Set([
      currentAgentId,
      ...expandedAgentIds,
    ].filter((value): value is string => Boolean(value))))

    if (targetAgentIds.length === 0) {
      return
    }

    let cancelled = false

    const markLoading = (agentId: string, loading: boolean) => {
      if (loading) {
        setLoadingSessionAgentIds((currentIds) => currentIds.includes(agentId) ? currentIds : [...currentIds, agentId])
        return
      }

      setLoadingSessionAgentIds((currentIds) => currentIds.filter((id) => id !== agentId))
    }

    const loadSessionsForAgent = async (agentId: string, options?: { silent?: boolean }) => {
      if (!options?.silent) {
        markLoading(agentId, true)
      }

      try {
        const nextSessions = await fetchSessions(agentId)
        if (!cancelled) {
          replaceAgentSessions(agentId, nextSessions)
          setSidebarError(null)
        }
      } catch (error) {
        if (!cancelled) {
          setSidebarError(error instanceof Error ? error.message : 'Failed to load sessions')
        }
      } finally {
        if (!cancelled) {
          markLoading(agentId, false)
        }
      }
    }

    void Promise.all(targetAgentIds.map((agentId) => loadSessionsForAgent(agentId)))
    const intervalId = window.setInterval(() => {
      void Promise.all(targetAgentIds.map((agentId) => loadSessionsForAgent(agentId, { silent: true })))
    }, 10_000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [currentAgentId, expandedAgentIds, replaceAgentSessions])

  const toggleAgentExpanded = (agentId: string) => {
    setExpandedAgentIds((currentIds) => (
      currentIds.includes(agentId)
        ? currentIds.filter((id) => id !== agentId)
        : [...currentIds, agentId]
    ))
  }

  const toggleChannelSessionsExpanded = (agentId: string) => {
    setExpandedChannelAgentIds((currentIds) => (
      currentIds.includes(agentId)
        ? currentIds.filter((id) => id !== agentId)
        : [...currentIds, agentId]
    ))
  }

  const toggleChannelGroupExpanded = (groupId: string) => {
    setExpandedChannelGroupIds((currentIds) => (
      currentIds.includes(groupId)
        ? currentIds.filter((id) => id !== groupId)
        : [...currentIds, groupId]
    ))
  }

  const handleSelectSession = (agentId: string, sessionId: string) => {
    if (agentId !== currentAgentId) {
      setCurrentAgentId(agentId)
    }

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
              const expanded = expandedAgentIdSet.has(agent.id)
              const agentSessions = sessionsByAgent[agent.id] ?? []
              const loadingSessions = loadingSessionAgentIdSet.has(agent.id)
              const { regularSessions, channelGroups } = splitSessionsByKind(agent.id, agentSessions)
              const hasActiveChannelSession = channelGroups.some((group) => group.sessions.some((session) => session.id === currentSessionId))
              const channelExpanded = expandedChannelAgentIdSet.has(agent.id) || hasActiveChannelSession

              return (
                <section
                  key={agent.id}
                  className={`pw-agent-card ${active ? 'is-active' : ''} ${expanded ? 'is-expanded' : ''}`}
                >
                  <button
                    className="pw-agent-button"
                    onClick={() => toggleAgentExpanded(agent.id)}
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
                    <span className={`pw-disclosure ${expanded ? 'is-open' : ''}`} aria-hidden="true">
                      ▾
                    </span>
                  </button>

                  {expanded && (
                    <div className="pw-session-tree">
                      <div className="pw-session-tree-label">Sessions</div>
                      {loadingSessions && <div className="pw-empty-state small">Loading sessions...</div>}
                      {!loadingSessions && regularSessions.length === 0 && channelGroups.length === 0 && (
                        <div className="pw-empty-state small">No sessions for this agent.</div>
                      )}
                      {regularSessions.map((session) => (
                        <button
                          key={session.id}
                          className={`pw-session-button ${session.id === currentSessionId ? 'is-active' : ''}`}
                          onClick={() => handleSelectSession(agent.id, session.id)}
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
                      {channelGroups.length > 0 && (
                        <div className="pw-session-group">
                          <button
                            className={`pw-session-group-toggle ${channelExpanded ? 'is-open' : ''}`}
                            onClick={() => toggleChannelSessionsExpanded(agent.id)}
                          >
                            <span>Channel sessions</span>
                            <span className="pw-session-group-meta">
                              {channelGroups.reduce((count, group) => count + group.sessions.length, 0)}
                            </span>
                          </button>
                          {channelExpanded && (
                            <div className="pw-session-group-list">
                              {channelGroups.map((group) => {
                                const groupId = `${agent.id}::${group.channelName}`
                                const groupHasActiveSession = group.sessions.some((session) => session.id === currentSessionId)
                                const groupExpanded = expandedChannelGroupIdSet.has(groupId) || groupHasActiveSession

                                return (
                                  <div key={groupId} className="pw-session-group is-nested">
                                    <button
                                      className={`pw-session-group-toggle ${groupExpanded ? 'is-open' : ''}`}
                                      onClick={() => toggleChannelGroupExpanded(groupId)}
                                    >
                                      <span>{group.label}</span>
                                      <span className="pw-session-group-meta">{group.sessions.length}</span>
                                    </button>
                                    {groupExpanded && (
                                      <div className="pw-session-group-list">
                                        {group.sessions.map((session) => (
                                          <button
                                            key={session.id}
                                            className={`pw-session-button ${session.id === currentSessionId ? 'is-active' : ''}`}
                                            onClick={() => handleSelectSession(agent.id, session.id)}
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
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )}
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
