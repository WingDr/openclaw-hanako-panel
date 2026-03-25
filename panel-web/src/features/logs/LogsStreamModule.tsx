import React from 'react'
import type { RealtimeLogsController } from './useRealtimeLogs'

type LogsStreamModuleProps = {
  controller: RealtimeLogsController
  variant?: 'page' | 'card'
}

export function LogsStreamModule(props: LogsStreamModuleProps) {
  const { controller, variant = 'card' } = props
  const {
    filteredLogs,
    search,
    setSearch,
    loading,
    error,
    live,
    connectionMessage,
    autoFollow,
    setAutoFollow,
    logListRef,
    scrollToBottom,
    updateAutoFollow,
  } = controller

  if (variant === 'page') {
    return (
      <div className="pw-logs" style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
        <div className="pw-toolbar" style={{ display: 'flex', gap: 8, padding: 8, alignItems: 'center' }}>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search logs"
            style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', minWidth: 220 }}
          />
          <button
            onClick={() => setSearch('')}
            style={{ padding: '8px 12px', borderRadius: 6, border: 'none', background: '#1f2a44', color: 'white' }}
          >
            Clear
          </button>
          {!autoFollow && (
            <button
              onClick={() => {
                setAutoFollow(true)
                scrollToBottom()
              }}
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.06)', color: 'white' }}
            >
              Jump to latest
            </button>
          )}
          <div style={{ marginLeft: 'auto', color: live ? '#4ade80' : '#fca5a5', fontSize: 12 }}>
            {live ? (autoFollow ? 'Live stream following' : 'Live stream paused') : 'Snapshot only'}
          </div>
        </div>
        {error && <div style={{ padding: '0 8px', color: '#fca5a5' }}>{error}</div>}
        {connectionMessage && !error && (
          <div style={{ padding: '0 8px', color: live ? '#93c5fd' : '#fca5a5' }}>{connectionMessage}</div>
        )}
        <div
          ref={logListRef}
          className="pw-loglist"
          onScroll={updateAutoFollow}
          style={{ overflow: 'auto', padding: 8, display: 'grid', gap: 6 }}
        >
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

  return (
    <>
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

      {error && <div className="pw-error-banner">{error}</div>}
      {connectionMessage && !error && <div className="pw-inline-note">{connectionMessage}</div>}

      <div
        ref={logListRef}
        className="pw-log-stream"
        onScroll={updateAutoFollow}
      >
        {loading && <div className="pw-empty-state">Loading logs...</div>}
        {!loading && filteredLogs.length === 0 && (
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
    </>
  )
}
