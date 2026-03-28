import React, { useEffect, useMemo, useRef } from 'react'
import { GripVertical, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { fetchAgents, fetchBootstrap, fetchSessions, formatRelativeTime, type ChatSession } from '../api/client'
import { IconButton } from './IconButton'
import { RightRailModulesHost } from '../features/rail/RightRailModulesHost'
import { useChatStore } from '../store'
import { panelRealtime } from '../realtime/ws'
import { mapProxySession } from '../api/client'

const statusLabelTone: Record<string, string> = {
  online: 'tone-good',
  idle: 'tone-warn',
  offline: 'tone-bad',
  unknown: 'tone-muted',
  pending: 'tone-warn',
  opened: 'tone-accent',
  closed: 'tone-muted',
}

const LEFT_PANEL_DEFAULT_WIDTH = 240
const LEFT_PANEL_MIN_WIDTH = 200
const RIGHT_PANEL_DEFAULT_WIDTH = 240
const RIGHT_PANEL_MIN_WIDTH = 200
const MAIN_PANEL_MIN_WIDTH = 400
const PANEL_SPLITTER_WIDTH = 32

type PanelSide = 'left' | 'right'
type ActiveResizeState = {
  side: PanelSide
  startX: number
  startWidth: number
}

function clampPanelWidth(options: {
  side: PanelSide
  requestedWidth: number
  containerWidth: number
  opposingPanelWidth: number
}) {
  const { side, requestedWidth, containerWidth, opposingPanelWidth } = options
  const minWidth = side === 'left' ? LEFT_PANEL_MIN_WIDTH : RIGHT_PANEL_MIN_WIDTH
  const maxWidth = Math.max(
    0,
    containerWidth - (PANEL_SPLITTER_WIDTH * 2) - MAIN_PANEL_MIN_WIDTH - opposingPanelWidth,
  )

  if (maxWidth <= 0) {
    return 0
  }

  const effectiveMinWidth = Math.min(minWidth, maxWidth)
  return Math.min(Math.max(requestedWidth, effectiveMinWidth), maxWidth)
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

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  return left.every((value, index) => value === right[index])
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
  const upsertAgentSession = useChatStore((state) => state.upsertAgentSession)
  const [loadingAgents, setLoadingAgents] = React.useState(true)
  const [loadingSessionAgentIds, setLoadingSessionAgentIds] = React.useState<string[]>([])
  const [expandedAgentIds, setExpandedAgentIds] = React.useState<string[]>([])
  const [expandedChannelAgentIds, setExpandedChannelAgentIds] = React.useState<string[]>([])
  const [expandedChannelGroupIds, setExpandedChannelGroupIds] = React.useState<string[]>([])
  const [sidebarError, setSidebarError] = React.useState<string | null>(null)
  const [proxyVersion, setProxyVersion] = React.useState<string>('unknown')
  const [gatewayConnected, setGatewayConnected] = React.useState(false)
  const [leftPanelOpen, setLeftPanelOpen] = React.useState(true)
  const [rightPanelOpen, setRightPanelOpen] = React.useState(true)
  const [leftPanelWidth, setLeftPanelWidth] = React.useState(LEFT_PANEL_DEFAULT_WIDTH)
  const [rightPanelWidth, setRightPanelWidth] = React.useState(RIGHT_PANEL_DEFAULT_WIDTH)
  const isManageRoute = location.pathname.startsWith('/manage')
  const shellRef = useRef<HTMLDivElement | null>(null)
  const activeResizeRef = useRef<ActiveResizeState | null>(null)
  const leftPanelOpenRef = useRef(leftPanelOpen)
  const rightPanelOpenRef = useRef(rightPanelOpen)
  const leftPanelWidthRef = useRef(leftPanelWidth)
  const rightPanelWidthRef = useRef(rightPanelWidth)
  const expandedAgentIdSet = useMemo(() => new Set(expandedAgentIds), [expandedAgentIds])
  const expandedChannelAgentIdSet = useMemo(() => new Set(expandedChannelAgentIds), [expandedChannelAgentIds])
  const expandedChannelGroupIdSet = useMemo(() => new Set(expandedChannelGroupIds), [expandedChannelGroupIds])
  const loadingSessionAgentIdSet = useMemo(() => new Set(loadingSessionAgentIds), [loadingSessionAgentIds])

  leftPanelOpenRef.current = leftPanelOpen
  rightPanelOpenRef.current = rightPanelOpen
  leftPanelWidthRef.current = leftPanelWidth
  rightPanelWidthRef.current = rightPanelWidth

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
    setExpandedAgentIds((currentIds) => {
      const nextIds = currentIds.filter((id) => validAgentIds.has(id))
      return areStringArraysEqual(currentIds, nextIds) ? currentIds : nextIds
    })
    setExpandedChannelAgentIds((currentIds) => {
      const nextIds = currentIds.filter((id) => validAgentIds.has(id))
      return areStringArraysEqual(currentIds, nextIds) ? currentIds : nextIds
    })
    setExpandedChannelGroupIds((currentIds) => {
      const nextIds = currentIds.filter((id) => {
        const [agentId] = id.split('::')
        return validAgentIds.has(agentId)
      })
      return areStringArraysEqual(currentIds, nextIds) ? currentIds : nextIds
    })
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

    void Promise.all(targetAgentIds.map((agentId) => loadSessionsForAgent(agentId, {
      silent: (sessionsByAgent[agentId]?.length ?? 0) > 0,
    })))
    const intervalId = window.setInterval(() => {
      void Promise.all(targetAgentIds.map((agentId) => loadSessionsForAgent(agentId, { silent: true })))
    }, 10_000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [currentAgentId, expandedAgentIds, replaceAgentSessions])

  useEffect(() => {
    const applyResize = (clientX: number) => {
      if (!activeResizeRef.current || !shellRef.current) {
        return
      }

      const shellRect = shellRef.current.getBoundingClientRect()
      const activeResize = activeResizeRef.current
      const deltaX = clientX - activeResize.startX
      const nextWidth = activeResize.side === 'left'
        ? clampPanelWidth({
            side: 'left',
            requestedWidth: activeResize.startWidth + deltaX,
            containerWidth: shellRect.width,
            opposingPanelWidth: rightPanelOpenRef.current ? rightPanelWidthRef.current : 0,
          })
        : clampPanelWidth({
            side: 'right',
            requestedWidth: activeResize.startWidth - deltaX,
            containerWidth: shellRect.width,
            opposingPanelWidth: leftPanelOpenRef.current ? leftPanelWidthRef.current : 0,
          })

      if (activeResize.side === 'left') {
        setLeftPanelWidth(nextWidth)
        return
      }

      setRightPanelWidth(nextWidth)
    }

    const handlePointerMove = (event: PointerEvent) => {
      applyResize(event.clientX)
    }

    const handleMouseMove = (event: MouseEvent) => {
      applyResize(event.clientX)
    }

    const clearActiveResize = () => {
      if (!activeResizeRef.current) {
        return
      }

      activeResizeRef.current = null
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', clearActiveResize)
    window.addEventListener('pointercancel', clearActiveResize)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', clearActiveResize)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', clearActiveResize)
      window.removeEventListener('pointercancel', clearActiveResize)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', clearActiveResize)
      clearActiveResize()
    }
  }, [])

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

  
  const handleCreateSession = async (targetAgentId: string) => {
    try {
      const response = await panelRealtime.sendCommand('session.create', { agentId: targetAgentId })
      const created = (response.result as any)?.session
      if (created) {
        upsertAgentSession(mapProxySession(created))
        setSessionId(created.sessionKey || created.id)
      }
    } catch (e) {
      console.error(e)
    }
  }

  const handleSelectSession = (agentId: string, sessionId: string) => {
    if (agentId !== currentAgentId) {
      setCurrentAgentId(agentId)
    }

    setSessionId(sessionId)
  }

  const togglePanel = (side: PanelSide) => {
    const shellWidth = shellRef.current?.getBoundingClientRect().width ?? window.innerWidth

    if (side === 'left') {
      setLeftPanelOpen((currentValue) => {
        const nextValue = !currentValue
        if (nextValue) {
          setLeftPanelWidth((currentWidth) => clampPanelWidth({
            side: 'left',
            requestedWidth: currentWidth || LEFT_PANEL_DEFAULT_WIDTH,
            containerWidth: shellWidth,
            opposingPanelWidth: rightPanelOpen ? rightPanelWidth : 0,
          }))
        }
        return nextValue
      })
      return
    }

    setRightPanelOpen((currentValue) => {
      const nextValue = !currentValue
      if (nextValue) {
        setRightPanelWidth((currentWidth) => clampPanelWidth({
          side: 'right',
          requestedWidth: currentWidth || RIGHT_PANEL_DEFAULT_WIDTH,
          containerWidth: shellWidth,
          opposingPanelWidth: leftPanelOpen ? leftPanelWidth : 0,
        }))
      }
      return nextValue
    })
  }

  const beginResize = (side: PanelSide) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (window.matchMedia('(max-width: 980px)').matches) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    activeResizeRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === 'left' ? leftPanelWidth : rightPanelWidth,
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const shellStyle = !isManageRoute
    ? ({
        '--pw-left-panel-size': leftPanelOpen ? `${leftPanelWidth}px` : '0px',
        '--pw-right-panel-size': rightPanelOpen ? `${rightPanelWidth}px` : '0px',
        '--pw-panel-splitter-size': `${PANEL_SPLITTER_WIDTH}px`,
      } as React.CSSProperties)
    : undefined

  return (
    <div
      ref={shellRef}
      className={`pw-app-shell ${isManageRoute ? 'is-manage' : 'is-chat'}`}
      style={shellStyle}
    >
      {!isManageRoute && (
        <>
          <div className={`pw-panel-frame pw-panel-frame-left ${leftPanelOpen ? 'is-open' : 'is-collapsed'}`}>
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
                {loadingAgents && <div className="pw-empty-state">⏳ Loading...</div>}
                {!loadingAgents && agents.length === 0 && (
                  <div className="pw-empty-state">∅ No agents active</div>
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
                      <div className="pw-agent-button" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px' }}>
                        <div 
                          style={{ display: 'flex', alignItems: 'center', flex: 1, cursor: 'pointer', minWidth: 0 }}
                          onClick={() => toggleAgentExpanded(agent.id)}
                        >
                          <div className="pw-agent-avatar" style={{ width: 24, height: 24, fontSize: 12 }}>{agent.name.slice(0, 1)}</div>
                          <div className="pw-agent-copy" style={{ marginLeft: 8, minWidth: 0, overflow: 'hidden' }}>
                            <div className="pw-agent-topline" style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                              <span className="pw-agent-name" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</span>
                              <span className={`pw-presence-dot`} style={{ marginLeft: 6, width: 8, height: 8, borderRadius: '50%', display: 'inline-block', backgroundColor: agent.status === 'online' ? '#4ade80' : '#fbbf24' }}></span>
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <IconButton
                            className="pw-icon-button"
                            icon={Plus}
                            label="New session"
                            onClick={(e) => { e.stopPropagation(); handleCreateSession(agent.id) }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', opacity: 0.6 }}
                          />
                        </div>
                      </div>

                      {expanded && (
                        <div className="pw-session-tree">
                          <div className="pw-session-tree-label">Sessions</div>
                          {loadingSessions && <div className="pw-empty-state small">⏳ Loading sessions...</div>}
                          {!loadingSessions && regularSessions.length === 0 && channelGroups.length === 0 && (
                            <div className="pw-empty-state small">∅ No sessions</div>
                          )}
                          {regularSessions.map((session) => (
                            <button
                              key={session.id}
                              className={`pw-session-button ${session.id === currentSessionId ? 'is-active' : ''}`}
                              onClick={() => handleSelectSession(agent.id, session.id)}
                            >
                              <div className="pw-session-title-row" style={{ minWidth: 0 }}>
                                <span className="pw-session-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '80%' }}>{session.name}</span>
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
          </div>

          <div className="pw-panel-splitter pw-panel-splitter-left">
            <div className="pw-panel-splitter-controls">
              <IconButton
                className="pw-panel-toggle"
                icon={leftPanelOpen ? PanelLeftClose : PanelLeftOpen}
                label={leftPanelOpen ? 'Close left panel' : 'Open left panel'}
                onClick={() => togglePanel('left')}
                size={16}
              />
              {leftPanelOpen && (
                <IconButton
                  className="pw-panel-resize"
                  icon={GripVertical}
                  label="Resize left panel"
                  onPointerDown={beginResize('left')}
                  size={16}
                />
              )}
            </div>
          </div>
        </>
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
        <>
          <div className="pw-panel-splitter pw-panel-splitter-right">
            <div className="pw-panel-splitter-controls">
              <IconButton
                className="pw-panel-toggle"
                icon={rightPanelOpen ? PanelRightClose : PanelRightOpen}
                label={rightPanelOpen ? 'Close right panel' : 'Open right panel'}
                onClick={() => togglePanel('right')}
                size={16}
              />
              {rightPanelOpen && (
                <IconButton
                  className="pw-panel-resize"
                  icon={GripVertical}
                  label="Resize right panel"
                  onPointerDown={beginResize('right')}
                  size={16}
                />
              )}
            </div>
          </div>

          <div className={`pw-panel-frame pw-panel-frame-right ${rightPanelOpen ? 'is-open' : 'is-collapsed'}`}>
            <RightRailModulesHost agentId={currentAgentId} sessionKey={currentSessionId} />
          </div>
        </>
      )}
    </div>
  )
}
