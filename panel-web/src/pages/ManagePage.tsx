import React, { useEffect, useMemo, useRef, useState } from 'react'
import { fetchLogs, fetchStatus, formatClockTime, formatRelativeTime, mapProxyLogLine } from '../api/client'
import type { LogEntry, StatusSnapshot } from '../api/client'
import { panelRealtime } from '../realtime/ws'

type RealtimeLogsAppendPayload = {
  cursor: number
  lines: Array<{
    ts: string
    level: 'info' | 'warn' | 'error'
    text: string
  }>
}

type RealtimeLogsResetPayload = {
  reason: string
}

type SystemConnectionPayload = {
  source: 'gateway'
  connected: boolean
  at: string
  message?: string
}

const autoFollowThresholdPx = 32

function isNearBottom(element: HTMLDivElement): boolean {
  const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
  return distanceFromBottom <= autoFollowThresholdPx
}

export default function ManagePage() {
  const [activeManageView, setActiveManageView] = useState<'status' | 'logs'>('status')
  const [status, setStatus] = useState<StatusSnapshot | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [search, setSearch] = useState('')
  const [logsLoading, setLogsLoading] = useState(true)
  const [logsError, setLogsError] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null)
  const [autoFollow, setAutoFollow] = useState(true)
  const logListRef = useRef<HTMLDivElement | null>(null)
  const previousFilteredLogCountRef = useRef(0)
  const scrollIgnoreUntilRef = useRef(0)
  const scrollFrameRef = useRef<number | null>(null)

  const scrollToBottom = () => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current)
    }

    scrollFrameRef.current = window.requestAnimationFrame(() => {
      const element = logListRef.current
      if (!element) {
        return
      }

      scrollIgnoreUntilRef.current = Date.now() + 180
      element.scrollTop = element.scrollHeight

      window.requestAnimationFrame(() => {
        const nextElement = logListRef.current
        if (!nextElement) {
          return
        }

        if (isNearBottom(nextElement)) {
          setAutoFollow(true)
        }
      })
    })
  }

  const updateAutoFollow = () => {
    const element = logListRef.current
    if (!element) {
      return
    }

    if (Date.now() < scrollIgnoreUntilRef.current) {
      return
    }

    setAutoFollow(isNearBottom(element))
  }

  useEffect(() => {
    let cancelled = false

    const loadStatus = async () => {
      try {
        const nextStatus = await fetchStatus()
        if (!cancelled) {
          setStatus(nextStatus)
          setStatusError(null)
        }
      } catch (error) {
        if (!cancelled) {
          setStatusError(error instanceof Error ? error.message : 'Failed to load status')
        }
      } finally {
        if (!cancelled) {
          setStatusLoading(false)
        }
      }
    }

    void loadStatus()
    const intervalId = window.setInterval(() => {
      void loadStatus()
    }, 10_000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const unsubscribe = panelRealtime.subscribe((event) => {
      if (cancelled) {
        return
      }

      if (event.event === 'logs.reset') {
        const payload = event.payload as RealtimeLogsResetPayload
        setLogs([])
        setConnectionMessage(payload.reason === 'subscribed' ? null : `Logs reset: ${payload.reason}`)
      }

      if (event.event === 'logs.append') {
        const payload = event.payload as RealtimeLogsAppendPayload
        setLogs((current) => [
          ...current,
          ...payload.lines.map((line, index) => mapProxyLogLine(line, current.length + index)),
        ])
      }

      if (event.event === 'system.connection') {
        const payload = event.payload as SystemConnectionPayload
        setLive(payload.connected)
        setConnectionMessage(payload.message || null)
      }
    })

    const loadLogs = async () => {
      setLogsLoading(true)
      setLogsError(null)

      try {
        const snapshot = await fetchLogs()
        if (!cancelled) {
          setLogs(snapshot)
        }

        await panelRealtime.sendCommand('logs.subscribe', {})
        if (!cancelled) {
          setConnectionMessage(null)
        }
      } catch (error) {
        if (!cancelled) {
          setLogsError(error instanceof Error ? error.message : 'Failed to load logs')
          setLive(false)
        }
      } finally {
        if (!cancelled) {
          setLogsLoading(false)
        }
      }
    }

    void loadLogs()

    return () => {
      cancelled = true
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current)
      }
      unsubscribe()
      void panelRealtime.sendCommand('logs.unsubscribe', {}).catch(() => {})
    }
  }, [])

  const filteredLogs = useMemo(
    () => logs.filter((log) => {
      if (!search.trim()) {
        return true
      }

      const query = search.trim().toLowerCase()
      return `${log.level} ${log.message} ${log.timestamp}`.toLowerCase().includes(query)
    }),
    [logs, search],
  )

  useEffect(() => {
    const previousCount = previousFilteredLogCountRef.current
    previousFilteredLogCountRef.current = filteredLogs.length

    if (!autoFollow) {
      return
    }

    scrollToBottom()
  }, [autoFollow, filteredLogs.length])

  useEffect(() => {
    if (activeManageView !== 'logs' || !autoFollow) {
      return
    }

    scrollToBottom()
  }, [activeManageView, autoFollow])

  const onlineAgents = status?.agents.filter((agent) => agent.status === 'online').length ?? 0
  const connectedChannels = status?.channels.filter((channel) => channel.status === 'connected').length ?? 0
  const summaryCards = [
    {
      label: 'Gateway',
      value: status?.gateway.connected ? 'Connected' : 'Disconnected',
      tone: status?.gateway.connected ? 'good' : 'bad',
      meta: status?.gateway.lastUpdatedAt ? formatRelativeTime(status.gateway.lastUpdatedAt) : 'Waiting for snapshot',
    },
    {
      label: 'Agents',
      value: `${onlineAgents}/${status?.agents.length ?? 0}`,
      tone: onlineAgents > 0 ? 'good' : 'muted',
      meta: onlineAgents > 0 ? 'online now' : 'no active agents',
    },
    {
      label: 'Channels',
      value: `${connectedChannels}/${status?.channels.length ?? 0}`,
      tone: connectedChannels > 0 ? 'good' : 'muted',
      meta: connectedChannels > 0 ? 'connected' : 'awaiting bridge',
    },
    {
      label: 'Recent sessions',
      value: String(status?.recentSessions.length ?? 0),
      tone: 'accent',
      meta: status?.recentSessions[0]?.updatedAt ? formatRelativeTime(status.recentSessions[0].updatedAt) : 'no recent activity',
    },
  ]

  return (
    <div className="pw-manage-page">
      <section className="pw-manage-hero">
        <div>
          <p className="pw-section-kicker">Manage Panel</p>
          <h1>System pulse and live proxy logs in one place.</h1>
        </div>
        <div className="pw-manage-hero-meta">
          <span className={`pw-live-pill ${live ? 'is-live' : 'is-offline'}`}>
            {live ? (autoFollow ? 'Live log stream' : 'Live stream paused') : 'Snapshot only'}
          </span>
          {status?.gateway.lastUpdatedAt && (
            <span className="pw-hero-time">
              Updated {formatClockTime(status.gateway.lastUpdatedAt)}
            </span>
          )}
        </div>
      </section>

      <section className="pw-status-grid">
        {summaryCards.map((card) => (
          <article key={card.label} className={`pw-summary-card tone-${card.tone}`}>
            <div className="pw-summary-label">{card.label}</div>
            <div className="pw-summary-value">{card.value}</div>
            <div className="pw-summary-meta">{card.meta}</div>
          </article>
        ))}
      </section>

      <section className="pw-manage-view-switcher" aria-label="Manage sections">
        <button
          className={`pw-subtab-button ${activeManageView === 'status' ? 'is-active' : ''}`}
          onClick={() => setActiveManageView('status')}
        >
          Gateway and workspace snapshot
        </button>
        <button
          className={`pw-subtab-button ${activeManageView === 'logs' ? 'is-active' : ''}`}
          onClick={() => setActiveManageView('logs')}
        >
          Realtime proxy stream
        </button>
      </section>

      <section className="pw-manage-view">
        {activeManageView === 'status' ? (
          <article className="pw-manage-card pw-manage-card-wide">
            <div className="pw-card-heading">
              <div>
                <p className="pw-section-kicker">Status</p>
                <h2>Gateway and workspace snapshot</h2>
              </div>
            </div>
            {statusLoading && !status && <div className="pw-empty-state">Loading system status...</div>}
            {statusError && !status && <div className="pw-error-banner">{statusError}</div>}
            {status && (
              <div className="pw-status-columns">
                <div className="pw-status-panel">
                  <div className="pw-status-block">
                    <div className="pw-mini-label">Gateway</div>
                    <div className={`pw-status-value ${status.gateway.connected ? 'tone-good' : 'tone-bad'}`}>
                      {status.gateway.connected ? 'Connected' : 'Disconnected'}
                    </div>
                    <div className="pw-status-meta">
                      {formatClockTime(status.gateway.lastUpdatedAt)} · {formatRelativeTime(status.gateway.lastUpdatedAt)}
                    </div>
                  </div>
                  <div className="pw-status-block">
                    <div className="pw-mini-label">Channels</div>
                    <div className="pw-inline-list">
                      {status.channels.length === 0 && <span className="pw-muted-copy">No channels reported.</span>}
                      {status.channels.map((channel) => (
                        <div key={channel.channelKey} className="pw-list-row">
                          <div>
                            <div className="pw-list-title">{channel.channelKey}</div>
                            <div className="pw-list-meta">{channel.summary}</div>
                          </div>
                          <span className={`pw-badge ${channel.status === 'connected' ? 'tone-good' : 'tone-bad'}`}>
                            {channel.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="pw-status-panel">
                  <div className="pw-status-block">
                    <div className="pw-mini-label">Agents</div>
                    <div className="pw-inline-list">
                      {status.agents.map((agent) => (
                        <div key={agent.id} className="pw-list-row">
                          <div>
                            <div className="pw-list-title">{agent.name}</div>
                            <div className="pw-list-meta">{agent.capabilities.join(' · ') || 'No capability metadata'}</div>
                          </div>
                          <span className={`pw-badge tone-${agent.status === 'online' ? 'good' : agent.status === 'idle' ? 'warn' : agent.status === 'offline' ? 'bad' : 'muted'}`}>
                            {agent.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="pw-status-block">
                    <div className="pw-mini-label">Recent sessions</div>
                    <div className="pw-inline-list">
                      {status.recentSessions.length === 0 && <span className="pw-muted-copy">No recent sessions yet.</span>}
                      {status.recentSessions.map((session) => (
                        <div key={session.id} className="pw-list-row">
                          <div>
                            <div className="pw-list-title">{session.name}</div>
                            <div className="pw-list-meta">{session.id}</div>
                          </div>
                          <span className="pw-badge tone-accent">
                            {session.updated || formatRelativeTime(session.updatedAt) || '--'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {statusError && status && <div className="pw-inline-note">{statusError}</div>}
          </article>
        ) : (
          <article className="pw-manage-card pw-log-card">
            <div className="pw-card-heading">
              <div>
                <p className="pw-section-kicker">Logs</p>
                <h2>Realtime proxy stream</h2>
              </div>
              <div className="pw-log-toolbar">
                <input
                  className="pw-log-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Filter log lines"
                />
                <button className="pw-secondary-button" onClick={() => setSearch('')}>
                  Clear
                </button>
                {!autoFollow && (
                <button
                  className="pw-secondary-button"
                  onClick={() => {
                      setAutoFollow(true)
                      scrollToBottom()
                    }}
                  >
                    Jump to latest
                  </button>
                )}
              </div>
            </div>

            {logsError && <div className="pw-error-banner">{logsError}</div>}
            {connectionMessage && !logsError && <div className="pw-inline-note">{connectionMessage}</div>}

            <div
              ref={logListRef}
              className="pw-log-stream"
              onScroll={updateAutoFollow}
            >
              {logsLoading && <div className="pw-empty-state">Loading logs...</div>}
              {!logsLoading && filteredLogs.length === 0 && (
                <div className="pw-empty-state">No logs match the current filter.</div>
              )}
              {filteredLogs.map((log) => (
                <div key={log.id} className="pw-log-line">
                  <span className="pw-log-time">{log.time}</span>
                  <span className={`pw-log-level tone-${log.level === 'error' ? 'bad' : log.level === 'warning' ? 'warn' : 'accent'}`}>
                    {log.level.toUpperCase()}
                  </span>
                  <span className="pw-log-message">{log.message}</span>
                </div>
              ))}
            </div>
          </article>
        )}
      </section>
    </div>
  )
}
