import React from 'react'

export default function LogsPage() {
  const logs = [
    { id: 'l1', time: '10:01', level: 'info', message: 'Panel started' },
    { id: 'l2', time: '10:02', level: 'warning', message: 'Slow response on chat API' },
    { id: 'l3', time: '10:03', level: 'error', message: 'Websocket disconnected' },
  ]
  return (
    <div className="pw-logs" style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div className="pw-toolbar" style={{ display: 'flex', gap: 8, padding: 8, alignItems: 'center' }}>
        <input placeholder="Search logs" style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)' }} />
        <button style={{ padding: '8px 12px', borderRadius: 6, border: 'none', background: '#1f2a44', color: 'white' }}>Clear</button>
      </div>
      <div className="pw-loglist" style={{ overflow: 'auto', padding: 8, display: 'grid', gap: 6 }}>
        {logs.map((log) => (
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
