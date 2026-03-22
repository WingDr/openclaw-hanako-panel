// API client stubs and mock data hooks

export type ChatSession = { id: string; name: string; updated?: string }
export type Message = { id: string; sessionId: string; author: 'agent'|'user'; text: string; timestamp: string }
export type LogEntry = { id: string; time: string; level: 'info'|'warning'|'error'; message: string }

export async function fetchSessions(): Promise<ChatSession[]> {
  // mock
  return [ { id: 'sess1', name: 'Session 1' }, { id: 'sess2', name: 'Session 2' } ]
}

export async function fetchMessages(sessionId: string): Promise<Message[]> {
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return [ { id: 'm1', sessionId, author: 'agent', text: 'Hello from API mock', timestamp: now } ]
}

export async function sendMessage(sessionId: string, text: string): Promise<Message> {
  return { id: 'm_auto', sessionId, author: 'user', text, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
}

export async function fetchLogs(): Promise<LogEntry[]> {
  return [
    { id: 'l1', time: '10:00', level: 'info', message: 'Initialized' },
    { id: 'l2', time: '10:01', level: 'warning', message: 'Latency detected' },
  ]
}
