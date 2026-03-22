import React, { useEffect, useMemo, useState } from 'react'
import { fetchLogs, mapProxyLogLine } from '../api/client'
import type { LogEntry } from '../api/client'
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

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null)

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
      setLoading(true)
      setError(null)

      try {
        const snapshot = await fetchLogs()
        if (!cancelled) {
          setLogs(snapshot)
        }

        await panelRealtime.sendCommand('logs.subscribe', {})
        if (!cancelled) {
          setConnectionMessage(null)
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : 'Failed to load logs')
          setLive(false)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadLogs()

    return () => {
      cancelled = true
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

  return (
    <div className="pw-logs" style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div className="pw-toolbar" style={{ display: 'flex', gap: 8, padding: 8, alignItems: 'center' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search logs"
          style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', minWidth: 220 }}
        />
        <button
          onClick={() => setSearch('')}
          style={{ padding: '8px 12px', borderRadius: 6, border: 'none', background: '#1f2a44', color: 'white' }}
        >
          Clear
        </button>
        <div style={{ marginLeft: 'auto', color: live ? '#4ade80' : '#fca5a5', fontSize: 12 }}>
          {live ? 'Live stream connected' : 'Snapshot only'}
        </div>
      </div>
      {error && (
        <div style={{ padding: '0 8px', color: '#fca5a5' }}>{error}</div>
      )}
      {connectionMessage && !error && (
        <div style={{ padding: '0 8px', color: live ? '#93c5fd' : '#fca5a5' }}>{connectionMessage}</div>
      )}
      <div className="pw-loglist" style={{ overflow: 'auto', padding: 8, display: 'grid', gap: 6 }}>
        {loading && <div style={{ color: '#888' }}>Loading logs...</div>}
        {!loading && filteredLogs.length === 0 && (
          <div style={{ color: '#888' }}>No logs match the current filter.</div>
        )}
        {filteredLogs.map((log) => (
          <div key={log.id} className="pw-logrow" style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.04)' }}>
            <span style={{ color: '#a8b3e1' }}>{log.time}</span>
            <span style={{ color: log.level === 'error' ? '#ff6b6b' : log.level === 'warning' ? '#f59e0b' : '#93c5fd' }}>{log.level.toUpperCase()}</span>
            <span style={{ marginLeft: 8 }}>{log.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
