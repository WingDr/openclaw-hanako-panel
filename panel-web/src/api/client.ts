import { createPanelApiUrl, panelApiBaseUrl } from '../config'
import { notifyAuthRequired } from '../auth/events'

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

export type ToolInvocationStatus = 'pending' | 'running' | 'done' | 'error'

export type ToolInvocation = {
  toolName: string
  toolCallId?: string
  command?: string
  arguments?: string
  result?: string
  status: ToolInvocationStatus
  error?: string
}

export type TranscriptItem = {
  messageId: string
  sessionKey: string
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'error'
  text?: string
  createdAt: string
  timestamp: string
  status?: 'complete' | 'error' | 'aborted'
  toolInvocation?: ToolInvocation
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
    workspace?: boolean
    cron?: boolean
  }
}

export type WorkspaceNodeKind = 'file' | 'directory'

export type WorkspaceTreeNode = {
  id: string
  name: string
  path: string
  kind: WorkspaceNodeKind
  size?: number
  updatedAt?: string
  children?: WorkspaceTreeNode[]
}

export type WorkspaceTreeSnapshot = {
  agentId: string
  rootPath: string
  path: string
  nodes: WorkspaceTreeNode[]
  truncated: boolean
}

export type WorkspaceFileDocument = {
  agentId: string
  rootPath: string
  path: string
  content: string
  size: number
  updatedAt: string
}

export type CronSessionTarget = 'main' | 'isolated' | 'current' | `session:${string}`
export type CronScheduleKind = 'at' | 'every' | 'cron'
export type CronPayloadKind = 'agentTurn' | 'systemEvent'

export type CronDelivery = {
  mode?: 'none' | 'announce' | 'webhook'
  channel?: string
  to?: string
  accountId?: string
  bestEffort?: boolean
  [key: string]: unknown
}

export type RawCronJob = {
  id?: string
  jobId?: string
  name?: string
  description?: string
  enabled?: boolean
  agentId?: string
  schedule?: Record<string, unknown>
  payload?: Record<string, unknown>
  delivery?: CronDelivery
  sessionTarget?: CronSessionTarget
  sessionKey?: string
  wakeMode?: 'now' | 'next-heartbeat'
  deleteAfterRun?: boolean
  keepAfterRun?: boolean
  notify?: boolean
  state?: Record<string, unknown>
  [key: string]: unknown
}

export type CronJobSummary = {
  id: string
  name: string
  description?: string
  enabled: boolean
  agentId?: string
  scheduleKind: CronScheduleKind
  scheduleLabel: string
  payloadKind: CronPayloadKind
  message?: string
  model?: string
  thinking?: string
  timeoutSeconds?: number
  lightContext?: boolean
  sessionTarget?: CronSessionTarget
  sessionKey?: string
  wakeMode?: 'now' | 'next-heartbeat'
  delivery?: CronDelivery
  nextRunAt?: string
  lastRunAt?: string
  lastStatus?: string
  lastError?: string
  lastDeliveryStatus?: string
  raw: RawCronJob
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

export type AuthStatus = {
  enabled: boolean
  requiresAuth: boolean
  authenticated: boolean
  loginEnabled: boolean
  apiTokenEnabled: boolean
  expiresAt?: string
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

type ProxyToolInvocation = {
  toolName: string
  toolCallId?: string
  command?: string
  arguments?: string
  result?: string
  status: ToolInvocationStatus
  error?: string
}

type ProxyChatHistoryItem = {
  messageId: string
  sessionKey: string
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'error'
  createdAt: string
  text?: string
  status?: 'complete' | 'error' | 'aborted'
  toolInvocation?: ProxyToolInvocation
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

type ProxyCronList = {
  jobs: RawCronJob[]
}

async function readJsonResponse<T>(response: Response): Promise<HttpResponse<T>> {
  return await response.json() as HttpResponse<T>
}

async function fetchProxyData<T>(pathname: string, init?: RequestInit, options?: { suppressAuthNotification?: boolean }): Promise<T> {
  const response = await fetch(createPanelApiUrl(pathname), {
    credentials: 'include',
    cache: 'no-store',
    ...init,
  })

  if (response.status === 401) {
    if (!options?.suppressAuthNotification) {
      notifyAuthRequired()
    }

    const payload = await readJsonResponse<T>(response)
    if (!payload.ok) {
      throw new Error(payload.error.message)
    }

    throw new Error('Authentication required')
  }

  if (!response.ok) {
    try {
      const payload = await readJsonResponse<T>(response)
      if (!payload.ok) {
        throw new Error(payload.error.message)
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error
      }
    }

    throw new Error(`Request failed with status ${response.status}`)
  }

  const payload = await readJsonResponse<T>(response)
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

export function formatDateTime(value?: string): string | undefined {
  if (!value) {
    return undefined
  }

  try {
    return new Date(value).toLocaleString([], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return value
  }
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

export function mapProxyChatHistoryMessage(message: ProxyChatHistoryItem): TranscriptItem {
  return {
    messageId: message.messageId,
    sessionKey: message.sessionKey,
    kind: message.kind,
    text: message.text,
    createdAt: message.createdAt,
    timestamp: formatClockTime(message.createdAt),
    status: message.status,
    toolInvocation: message.toolInvocation,
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

export function summarizeCronSchedule(rawJob: RawCronJob): string {
  const schedule = rawJob.schedule ?? {}
  const kind = typeof schedule.kind === 'string' ? schedule.kind : ''

  if (kind === 'every' && typeof schedule.everyMs === 'number') {
    const minutes = schedule.everyMs / 60_000
    if (minutes < 60) {
      return `Every ${minutes} min`
    }

    const hours = minutes / 60
    if (Number.isInteger(hours)) {
      return `Every ${hours} hr`
    }

    return `Every ${hours.toFixed(1)} hr`
  }

  if (kind === 'at') {
    const at = typeof schedule.at === 'string'
      ? schedule.at
      : typeof schedule.atMs === 'number'
        ? new Date(schedule.atMs).toISOString()
        : undefined
    return at ? `At ${formatDateTime(at) || at}` : 'Run once'
  }

  if (kind === 'cron' && typeof schedule.expr === 'string') {
    const tz = typeof schedule.tz === 'string' && schedule.tz.trim() ? ` · ${schedule.tz}` : ''
    return `${schedule.expr}${tz}`
  }

  return 'Unknown schedule'
}

export function normalizeCronJob(rawJob: RawCronJob): CronJobSummary {
  const schedule = rawJob.schedule ?? {}
  const payload = rawJob.payload ?? {}
  const state = rawJob.state ?? {}
  const scheduleKind = (
    typeof schedule.kind === 'string' && ['at', 'every', 'cron'].includes(schedule.kind)
      ? schedule.kind
      : 'every'
  ) as CronScheduleKind
  const payloadKind = (payload.kind === 'systemEvent' ? 'systemEvent' : 'agentTurn') as CronPayloadKind
  const nextRunAt = typeof state.nextRunAtMs === 'number'
    ? new Date(state.nextRunAtMs).toISOString()
    : typeof state.nextRunAt === 'string'
      ? state.nextRunAt
      : undefined
  const lastRunAt = typeof state.lastRunAtMs === 'number'
    ? new Date(state.lastRunAtMs).toISOString()
    : typeof state.lastRunAt === 'string'
      ? state.lastRunAt
      : undefined

  return {
    id: String(rawJob.id ?? rawJob.jobId ?? ''),
    name: String(rawJob.name ?? rawJob.id ?? rawJob.jobId ?? 'Untitled cron'),
    description: typeof rawJob.description === 'string' ? rawJob.description : undefined,
    enabled: rawJob.enabled !== false,
    agentId: typeof rawJob.agentId === 'string' ? rawJob.agentId : undefined,
    scheduleKind,
    scheduleLabel: summarizeCronSchedule(rawJob),
    payloadKind,
    message: typeof payload.message === 'string'
      ? payload.message
      : typeof payload.text === 'string'
        ? payload.text
        : undefined,
    model: typeof payload.model === 'string' ? payload.model : undefined,
    thinking: typeof payload.thinking === 'string' ? payload.thinking : undefined,
    timeoutSeconds: typeof payload.timeoutSeconds === 'number' ? payload.timeoutSeconds : undefined,
    lightContext: payload.lightContext === true,
    sessionTarget: typeof rawJob.sessionTarget === 'string' ? rawJob.sessionTarget as CronSessionTarget : undefined,
    sessionKey: typeof rawJob.sessionKey === 'string' ? rawJob.sessionKey : undefined,
    wakeMode: rawJob.wakeMode === 'next-heartbeat' ? 'next-heartbeat' : rawJob.wakeMode === 'now' ? 'now' : undefined,
    delivery: rawJob.delivery,
    nextRunAt,
    lastRunAt,
    lastStatus: typeof state.lastStatus === 'string'
      ? state.lastStatus
      : typeof state.lastRunStatus === 'string'
        ? state.lastRunStatus
        : undefined,
    lastError: typeof state.lastError === 'string' ? state.lastError : undefined,
    lastDeliveryStatus: typeof state.lastDeliveryStatus === 'string' ? state.lastDeliveryStatus : undefined,
    raw: rawJob,
  }
}

export async function fetchBootstrap(): Promise<BootstrapData> {
  return fetchProxyData<BootstrapData>('/api/bootstrap')
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  return fetchProxyData<AuthStatus>('/api/auth/me')
}

export async function loginPanel(password: string): Promise<AuthStatus> {
  return fetchProxyData<AuthStatus>('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  }, {
    suppressAuthNotification: true,
  })
}

export async function clearAuthSession(): Promise<AuthStatus> {
  return fetchProxyData<AuthStatus>('/api/auth/logout', {
    method: 'POST',
  }, {
    suppressAuthNotification: true,
  })
}

export async function fetchAgents(): Promise<AgentSummary[]> {
  const agents = await fetchProxyData<ProxyAgent[]>('/api/agents')
  return agents.map(mapProxyAgent)
}

export async function fetchSessions(agentId: string = 'main'): Promise<ChatSession[]> {
  const sessions = await fetchProxyData<ProxySession[]>(`/api/agents/${encodeURIComponent(agentId)}/sessions`)
  return sessions.map(mapProxySession)
}

export async function fetchChatHistory(sessionKey: string): Promise<TranscriptItem[]> {
  const messages = await fetchProxyData<ProxyChatHistoryItem[]>(`/api/chat/${encodeURIComponent(sessionKey)}/history`)
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

export async function fetchWorkspaceTree(agentId: string, requestedPath = ''): Promise<WorkspaceTreeSnapshot> {
  const query = requestedPath ? `?path=${encodeURIComponent(requestedPath)}` : ''
  return await fetchProxyData<WorkspaceTreeSnapshot>(`/api/workspace/${encodeURIComponent(agentId)}/tree${query}`)
}

export async function fetchWorkspaceFile(agentId: string, requestedPath: string): Promise<WorkspaceFileDocument> {
  return await fetchProxyData<WorkspaceFileDocument>(
    `/api/workspace/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(requestedPath)}`,
  )
}

export async function saveWorkspaceFile(agentId: string, requestedPath: string, content: string): Promise<WorkspaceFileDocument> {
  return await fetchProxyData<WorkspaceFileDocument>(`/api/workspace/${encodeURIComponent(agentId)}/file`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      path: requestedPath,
      content,
    }),
  })
}

export async function fetchCronJobs(agentId?: string): Promise<CronJobSummary[]> {
  const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''
  const payload = await fetchProxyData<ProxyCronList>(`/api/cron${query}`)
  return (payload.jobs ?? []).map(normalizeCronJob)
}

export async function validateCronDefinition(payload: { job?: Record<string, unknown>; patch?: Record<string, unknown> }): Promise<Record<string, unknown>> {
  return await fetchProxyData<Record<string, unknown>>('/api/cron/validate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

export async function createCronDefinition(job: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await fetchProxyData<Record<string, unknown>>('/api/cron', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ job }),
  })
}

export async function updateCronDefinition(jobId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await fetchProxyData<Record<string, unknown>>(`/api/cron/${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ patch }),
  })
}

export async function deleteCronDefinition(jobId: string): Promise<Record<string, unknown>> {
  return await fetchProxyData<Record<string, unknown>>(`/api/cron/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  })
}

export async function runCronDefinition(jobId: string): Promise<Record<string, unknown>> {
  return await fetchProxyData<Record<string, unknown>>(`/api/cron/${encodeURIComponent(jobId)}/run`, {
    method: 'POST',
  })
}

export async function toggleCronDefinition(jobId: string, enabled: boolean): Promise<Record<string, unknown>> {
  return await fetchProxyData<Record<string, unknown>>(`/api/cron/${encodeURIComponent(jobId)}/toggle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ enabled }),
  })
}
