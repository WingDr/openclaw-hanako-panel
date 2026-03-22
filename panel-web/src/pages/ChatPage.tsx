import React, { useState } from 'react'
import { useChatStore } from '../store'
import type { Message } from '../store'

// Simple three-column chat layout within shell: Agents (left), Workspace (center), Sessions (right)
export default function ChatPage() {
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const sessions = useChatStore((state) => state.sessions)
  const messagesBySession = useChatStore((state) => state.messagesBySession)
  const addUserMessage = useChatStore((state) => state.addUserMessage)
  const addAgentMessage = useChatStore((state) => state.addAgentMessage)
  const setSessionId = useChatStore((state) => state.setSessionId)
  const [text, setText] = useState('')
  const currentMessages: Message[] = messagesBySession[currentSessionId] ?? []

  const onSend = () => {
    if (!text.trim()) return
    addUserMessage(currentSessionId, text.trim())
    setText('')
    // simple mock agent reply
    setTimeout(() => {
      addAgentMessage(currentSessionId, 'Agent: I see. Tell me more about your goal.')
    }, 600)
  }

  return (
    <div className="pw-chat-layout" style={{ display: 'grid', gridTemplateColumns: '260px 1fr 320px', gap: '16px', height: '100%', paddingRight: 8 }}>
      {/* Left: Agents */}
      <section className="pw-panel pw-agent-panel" aria-label="Agents list" style={{ background: 'var(--surface)', borderRadius: '8px', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="pw-panel-title">Agents</div>
        {[
          { id: 'a1', name: 'Astra', status: 'online' },
          { id: 'a2', name: 'Orion', status: 'online' },
          { id: 'a3', name: 'Nova', status: 'offline' }
        ].map((ag) => (
          <div key={ag.id} className="pw-agent-item" style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', borderRadius: 6, background: ag.status === 'online' ? 'rgba(0, 128, 0, 0.15)' : 'transparent' }}>
            <span style={{ fontFamily: 'system-ui, sans-serif' }}>{ag.name}</span>
            <span style={{ color: ag.status === 'online' ? '#4ade80' : '#888' }}>{ag.status}</span>
          </div>
        ))}
      </section>

      {/* Center: Workspace */}
        <section className="pw-workspace" aria-label="Chat workspace" style={{ background: 'var(--surface)', borderRadius: '8px', padding: 12, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="pw-workspace-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <strong>Session: {currentSessionId}</strong>
          <span className="pw-muted" style={{ color: '#a5a8c7' }}>Live</span>
        </div>
        <div className="pw-messages" style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
          {currentMessages.length === 0 && (
            <div className="pw-empty" style={{ color: '#888', padding: 8 }}>No messages yet. Start the conversation.</div>
          )}
          {currentMessages.map((m: Message) => (
            <div key={m.id} className="pw-message" style={{ display: 'flex', margin: '6px 0', justifyContent: m.author === 'agent' ? 'flex-start' : 'flex-end' }}>
              <div style={{ maxWidth: '80%', padding: '8px 12px', borderRadius: 10, background: m.author === 'agent' ? '#1f2a44' : '#1a2b4a', color: '#e8eaff' }}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{m.timestamp}</div>
                <div style={{ fontFamily: 'system-ui, sans-serif' }}>{m.text}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="pw-input" style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 8 }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message..."
            style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: '#0e1220', color: 'white' }}
          />
          <button onClick={onSend} style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--primary)', color: 'white', border: 'none' }}>Send</button>
        </div>
      </section>

      {/* Right: Sessions quick list (mock) */}
      <section className="pw-panel pw-chair-panel" aria-label="Sessions" style={{ background: 'var(--surface)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="pw-panel-title">Sessions</div>
        {sessions.map((session) => (
          <div key={session.id} className="pw-session-item" onClick={() => setSessionId(session.id)} style={{ padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: session.id === currentSessionId ? 'rgba(124, 58, 237, 0.18)' : 'transparent' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{session.name}</span>
              <span style={{ color: '#9aa3ff', fontSize: 12 }}>{session.updated ?? ''}</span>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
