import { createPanelApiUrl, panelApiBaseUrl } from '../config'

export type AgentStatus = 'online' | 'idle' | 'offline' | 'unknown'
export type SessionStatus = 'pending' | 'opened' | 'closed'
export type ChannelStatus = 'connected' | 'disconnected'
export type LogLevel = 'info' | 'warning' | 'error'

export type AgentSummary = {
  id: string
  name: string
  status: AgentStatus
  capabilities: string[]
}

export type ChatSession = {
  id: string
  agentId: string
  name: string
  updatedAt?: string
  updated?: string
  status?: SessionStatus
}

export type Message = {
  id: string
  sessionId: string
  author: 'agent' | 'user'
  text: string
  timestamp: string
}

export type LogEntry = {
  id: string
  time: string
  timestamp: string
  level: LogLevel
  message: string
}

export type BootstrapData = {
  proxyVersion: string
  gateway: {
    connected: boolean
    mode: 'proxy'
  }
  defaultAgentId: string
  features: {
    chat: boolean
    logs: boolean
    status: boolean
  }
}

export type StatusSnapshot = {
  gateway: {
    connected: boolean
    lastUpdatedAt: string
  }
  agents: AgentSummary[]
  channels: Array<{
    channelKey: string
    status: ChannelStatus
    summary: string
  }>
  recentSessions: ChatSession[]
}

type HttpOk<T> = { ok: true; data: T }
type HttpError = { ok: false; error: { code: string; message: string } }
type HttpResponse<T> = HttpOk<T> | HttpError

type ProxyAgent = {
  agentId: string
  label: string
  status: AgentStatus
  capabilities: string[]
}

type ProxySession = {
  sessionKey: string
  agentId: string
  preview?: string
  updatedAt?: string
  status?: SessionStatus
}

type ProxyChatHistoryMessage = {
  id: string
  sessionKey: string
  author: 'agent' | 'user'
  text: string
  createdAt: string
}

type ProxyLogLine = {
  ts: string
  level: 'info' | 'warn' | 'error'
  text: string
}

type ProxyLogsSnapshot = {
  cursor: number
  lines: ProxyLogLine[]
}

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

export function formatClockTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatRelativeTime(value?: string): string | undefined {
  if (!value) {
    return undefined
  }

  const diffMs = new Date(value).getTime() - Date.now()
  const diffMinutes = Math.round(diffMs / 60000)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

  if (Math.abs(diffMinutes) < 60) {
    return rtf.format(diffMinutes, 'minute')
  }

  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return rtf.format(diffHours, 'hour')
  }

  const diffDays = Math.round(diffHours / 24)
  return rtf.format(diffDays, 'day')
}

export function mapProxyAgent(agent: ProxyAgent): AgentSummary {
  return {
    id: agent.agentId,
    name: agent.label,
    status: agent.status,
    capabilities: agent.capabilities,
  }
}

export function mapProxySession(session: ProxySession): ChatSession {
  return {
    id: session.sessionKey,
    agentId: session.agentId,
    name: session.preview || session.sessionKey,
    updatedAt: session.updatedAt,
    updated: formatRelativeTime(session.updatedAt),
    status: session.status,
  }
}

export function mapProxyChatHistoryMessage(message: ProxyChatHistoryMessage): Message {
  return {
    id: message.id,
    sessionId: message.sessionKey,
    author: message.author,
    text: message.text,
    timestamp: formatClockTime(message.createdAt),
  }
}

export function mapProxyLogLine(line: ProxyLogLine, index: number): LogEntry {
  return {
    id: `log-${index}-${line.ts}`,
    time: formatClockTime(line.ts),
    timestamp: line.ts,
    level: line.level === 'warn' ? 'warning' : line.level,
    message: line.text,
  }
}

export async function fetchBootstrap(): Promise<BootstrapData> {
  return fetchProxyData<BootstrapData>('/api/bootstrap')
}

export async function fetchAgents(): Promise<AgentSummary[]> {
  const agents = await fetchProxyData<ProxyAgent[]>('/api/agents')
  return agents.map(mapProxyAgent)
}

export async function fetchSessions(agentId: string = 'main'): Promise<ChatSession[]> {
  const sessions = await fetchProxyData<ProxySession[]>(`/api/agents/${encodeURIComponent(agentId)}/sessions`)
  return sessions.map(mapProxySession)
}

export async function fetchChatHistory(sessionKey: string): Promise<Message[]> {
  const messages = await fetchProxyData<ProxyChatHistoryMessage[]>(`/api/chat/${encodeURIComponent(sessionKey)}/history`)
  return messages.map(mapProxyChatHistoryMessage)
}

export async function fetchLogs(): Promise<LogEntry[]> {
  const snapshot = await fetchProxyData<ProxyLogsSnapshot>('/api/logs/snapshot')
  return snapshot.lines.map(mapProxyLogLine)
}

export async function fetchStatus(): Promise<StatusSnapshot> {
  const snapshot = await fetchProxyData<{
    gateway: {
      connected: boolean
      lastUpdatedAt: string
    }
    agents: ProxyAgent[]
    channels: Array<{
      channelKey: string
      status: ChannelStatus
      summary: string
    }>
    recentSessions: ProxySession[]
  }>('/api/status')

  return {
    gateway: snapshot.gateway,
    agents: snapshot.agents.map(mapProxyAgent),
    channels: snapshot.channels,
    recentSessions: snapshot.recentSessions.map(mapProxySession),
  }
}
