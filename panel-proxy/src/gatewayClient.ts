import { Agent, Session, BootstrapResponse, LogsSnapshot, StatusResponse, LogLine } from './types'

const mockAgents: Agent[] = [
  { agentId: 'main', label: 'Main', status: 'online', capabilities: ['chat', 'session'] },
  { agentId: 'research', label: 'Research', status: 'online', capabilities: ['chat'] },
  { agentId: 'design', label: 'Design', status: 'idle', capabilities: ['session'] },
]

let mockSessions: Session[] = [
  { sessionKey: 'agent:main:panel:daily-review', agentId: 'main', updatedAt: new Date().toISOString(), preview: 'Continue panel review', status: 'opened' },
  { sessionKey: 'agent:main:panel:debug-stream', agentId: 'main', updatedAt: new Date().toISOString(), preview: 'Check live events', status: 'pending' },
  { sessionKey: 'agent:research:panel:notes', agentId: 'research', updatedAt: new Date().toISOString(), preview: 'Research notes thread', status: 'opened' },
]

let mockLogs: LogLine[] = [
  { ts: new Date().toISOString(), level: 'info', text: 'Gateway initialized' },
  { ts: new Date().toISOString(), level: 'info', text: 'Agents discovered' },
]

let logCursor = mockLogs.length

export async function bootstrap(): Promise<BootstrapResponse> {
  return {
    proxyVersion: '0.1.0',
    gateway: { connected: true, mode: 'proxy' },
    defaultAgentId: 'main',
    features: { chat: true, logs: true, status: true },
  }
}

export async function fetchAgents(): Promise<Agent[]> {
  return mockAgents
}

export async function fetchAgentSessions(agentId: string): Promise<Session[]> {
  return mockSessions.filter((s) => s.agentId === agentId)
}

export async function fetchStatus(): Promise<StatusResponse> {
  const recent = mockSessions.slice().sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1)).slice(0, 3)
  return {
    gateway: {
      connected: true,
      lastUpdatedAt: new Date().toISOString(),
    },
    agents: mockAgents,
    channels: [
      { channelKey: 'gateway', status: 'connected' as const, summary: 'Primary control link' },
      { channelKey: 'logs', status: 'connected' as const, summary: 'Live tail available' },
    ],
    recentSessions: recent,
  }
}

export async function fetchLogsSnapshot(): Promise<LogsSnapshot> {
  return { cursor: logCursor, lines: mockLogs.slice(-50) }
}

export function appendLog(message: string, level: LogLine['level'] = 'info') {
  const entry: LogLine = { ts: new Date().toISOString(), level, text: message }
  mockLogs.push(entry)
  logCursor += 1
  return entry
}

export function addSession(agentId: string, slug: string, status: Session['status'] = 'pending') {
  const sess: Session = {
    sessionKey: `agent:${agentId}:panel:${slug}`,
    agentId,
    updatedAt: new Date().toISOString(),
    preview: 'New panel session',
    status,
  }
  mockSessions.push(sess)
  return sess
}
