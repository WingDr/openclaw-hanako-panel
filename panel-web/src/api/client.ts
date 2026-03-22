// API client stubs and mock data hooks
import { createPanelApiUrl, panelApiBaseUrl } from '../config'

export type ChatSession = { id: string; name: string; updated?: string }
export type Message = { id: string; sessionId: string; author: 'agent'|'user'; text: string; timestamp: string }
export type LogEntry = { id: string; time: string; level: 'info'|'warning'|'error'; message: string }

type HttpOk<T> = { ok: true; data: T }
type HttpError = { ok: false; error: { code: string; message: string } }
type HttpResponse<T> = HttpOk<T> | HttpError

type ProxySession = {
  sessionKey: string
  preview?: string
  updatedAt?: string
}

type ProxyLogLine = {
  ts: string
  level: 'info'|'warning'|'error'
  text: string
}

type ProxyLogsSnapshot = {
  cursor: number
  lines: ProxyLogLine[]
}

const fallbackSessions: ChatSession[] = [
  { id: 'sess1', name: 'Session 1' },
  { id: 'sess2', name: 'Session 2' },
]

const fallbackLogs: LogEntry[] = [
  { id: 'l1', time: '10:00', level: 'info', message: 'Initialized' },
  { id: 'l2', time: '10:01', level: 'warning', message: 'Latency detected' },
]

async function fetchProxyData<T>(pathname: string): Promise<T> {
  const response = await fetch(createPanelApiUrl(pathname))
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`)
  }

  const payload = await response.json() as HttpResponse<T>
  if (!payload.ok) {
    throw new Error(payload.error.message)
  }

  return payload.data
}

export function getPanelApiBaseUrl(): string {
  return panelApiBaseUrl
}

export async function fetchSessions(agentId: string = 'main'): Promise<ChatSession[]> {
  try {
    const sessions = await fetchProxyData<ProxySession[]>(`/api/agents/${encodeURIComponent(agentId)}/sessions`)
    return sessions.map((session) => ({
      id: session.sessionKey,
      name: session.preview || session.sessionKey,
      updated: session.updatedAt,
    }))
  } catch {
    return fallbackSessions
  }
}

export async function fetchMessages(sessionId: string): Promise<Message[]> {
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return [ { id: 'm1', sessionId, author: 'agent', text: 'Hello from API mock', timestamp: now } ]
}

export async function sendMessage(sessionId: string, text: string): Promise<Message> {
  return { id: 'm_auto', sessionId, author: 'user', text, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
}

export async function fetchLogs(): Promise<LogEntry[]> {
  try {
    const snapshot = await fetchProxyData<ProxyLogsSnapshot>('/api/logs/snapshot')
    return snapshot.lines.map((line, index) => ({
      id: `log-${index}-${line.ts}`,
      time: new Date(line.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      level: line.level,
      message: line.text,
    }))
  } catch {
    return fallbackLogs
  }
}
