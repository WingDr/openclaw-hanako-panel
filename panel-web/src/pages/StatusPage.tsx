import React from 'react'

export default function StatusPage() {
  const status = {
    gateway: { name: 'Gateway', state: 'Connected', ping: '12ms' },
    agents: [
      { name: 'Astra', state: 'Online' },
      { name: 'Orion', state: 'Online' },
      { name: 'Nova', state: 'Degraded' },
    ],
    channels: [
      { name: 'Chat', latency: '12ms' },
      { name: 'Logs', latency: '9ms' }
    ],
    recent: [
      { id: 'r1', name: 'Session 1', started: '2m' },
      { id: 'r2', name: 'Session 2', started: '5m' }
    ]
  }
  return (
    <div className="pw-status" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
      <section className="pw-card" style={{ padding: 12, borderRadius: 8, background: '#11172a' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Gateway</div>
        <div>State: {status.gateway.state}</div>
        <div>Ping: {status.gateway.ping}</div>
      </section>
      <section className="pw-card" style={{ padding: 12, borderRadius: 8, background: '#11172a' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Channels</div>
        {status.channels.map((c) => (
          <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', margin: '6px 0' }}>
            <span>{c.name}</span>
            <span style={{ color: '#9bd6ff' }}>{c.latency}</span>
          </div>
        ))}
      </section>
      <section className="pw-card" style={{ padding: 12, borderRadius: 8, gridColumn: '1/3', background: '#11172a' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Agents</div>
        {status.agents.map((a) => (
          <div key={a.name} style={{ display: 'flex', justifyContent: 'space-between', margin: '6px 0' }}>
            <span>{a.name}</span>
            <span style={{ color: a.state === 'Online' ? '#4ade80' : '#f472b6' }}>{a.state}</span>
          </div>
        ))}
      </section>
      <section className="pw-card" style={{ padding: 12, borderRadius: 8, background: '#11172a' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Recent Sessions</div>
        {status.recent.map((r) => (
          <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', margin: '6px 0' }}>
            <span>{r.name}</span>
            <span style={{ color: '#9bd6ff' }}>{r.started} ago</span>
          </div>
        ))}
      </section>
    </div>
  )
}
