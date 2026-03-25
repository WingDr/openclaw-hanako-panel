import React, { useEffect, useState } from 'react'
import { fetchStatus, formatClockTime, formatRelativeTime, type StatusSnapshot } from '../api/client'
import { LogsStreamModule } from '../features/logs/LogsStreamModule'
import { useRealtimeLogs } from '../features/logs/useRealtimeLogs'

export default function ManagePage() {
  const [activeManageView, setActiveManageView] = useState<'status' | 'logs'>('status')
  const [status, setStatus] = useState<StatusSnapshot | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const logsController = useRealtimeLogs()

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
    if (activeManageView !== 'logs' || !logsController.autoFollow) {
      return
    }

    logsController.scrollToBottom()
  }, [activeManageView, logsController.autoFollow, logsController.scrollToBottom])

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
          <span className={`pw-live-pill ${logsController.live ? 'is-live' : 'is-offline'}`}>
            {logsController.live ? (logsController.autoFollow ? 'Live log stream' : 'Live stream paused') : 'Snapshot only'}
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
            </div>
            <LogsStreamModule controller={logsController} variant="card" />
          </article>
        )}
      </section>
    </div>
  )
}
