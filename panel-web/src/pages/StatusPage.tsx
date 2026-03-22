import React, { useEffect, useState } from 'react'
import { fetchStatus, formatClockTime, formatRelativeTime } from '../api/client'
import type { StatusSnapshot } from '../api/client'

export default function StatusPage() {
  const [status, setStatus] = useState<StatusSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const loadStatus = async () => {
      try {
        const nextStatus = await fetchStatus()
        if (!cancelled) {
          setStatus(nextStatus)
          setError(null)
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : 'Failed to load status')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
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

  if (loading && !status) {
    return <div style={{ color: '#888' }}>Loading status...</div>
  }

  if (error && !status) {
    return <div style={{ color: '#fca5a5' }}>{error}</div>
  }

  const gatewayState = status?.gateway.connected ? 'Connected' : 'Disconnected'

  return (
    <div className="pw-status" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
      <section className="pw-card" style={{ padding: 12, borderRadius: 8, background: '#11172a' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Gateway</div>
        <div>State: {gatewayState}</div>
        <div>Updated: {status ? formatClockTime(status.gateway.lastUpdatedAt) : '--'}</div>
        <div style={{ color: '#9bd6ff', marginTop: 6 }}>
          {status?.gateway.lastUpdatedAt ? formatRelativeTime(status.gateway.lastUpdatedAt) : '--'}
        </div>
      </section>
      <section className="pw-card" style={{ padding: 12, borderRadius: 8, background: '#11172a' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Channels</div>
        {status?.channels.map((channel) => (
          <div key={channel.channelKey} style={{ margin: '8px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span>{channel.channelKey}</span>
              <span style={{ color: channel.status === 'connected' ? '#4ade80' : '#fca5a5' }}>{channel.status}</span>
            </div>
            <div style={{ color: '#9bd6ff', fontSize: 12 }}>
              {channel.summary}
            </div>
          </div>
        ))}
      </section>
      <section className="pw-card" style={{ padding: 12, borderRadius: 8, gridColumn: '1/3', background: '#11172a' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Agents</div>
        {status?.agents.map((agent) => (
          <div key={agent.id} style={{ display: 'flex', justifyContent: 'space-between', margin: '6px 0' }}>
            <span>{agent.name}</span>
            <span style={{ color: agent.status === 'online' ? '#4ade80' : agent.status === 'idle' ? '#fbbf24' : '#f472b6' }}>{agent.status}</span>
          </div>
        ))}
      </section>
      <section className="pw-card" style={{ padding: 12, borderRadius: 8, background: '#11172a' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Recent Sessions</div>
        {status?.recentSessions.map((session) => (
          <div key={session.id} style={{ display: 'flex', justifyContent: 'space-between', margin: '6px 0', gap: 8 }}>
            <span>{session.name}</span>
            <span style={{ color: '#9bd6ff' }}>{session.updated || formatRelativeTime(session.updatedAt) || '--'}</span>
          </div>
        ))}
      </section>
      {error && (
        <div style={{ gridColumn: '1/3', color: '#fca5a5' }}>{error}</div>
      )}
    </div>
  )
}
