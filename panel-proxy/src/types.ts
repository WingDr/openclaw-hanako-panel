export type AgentStatus = 'online' | 'idle' | 'offline' | 'unknown'
export type SessionStatus = 'pending' | 'opened' | 'closed'

export type Agent = {
  agentId: string
  label: string
  status: AgentStatus
  capabilities: string[]
}

export type Session = {
  sessionKey: string
  agentId: string
  updatedAt: string
  preview: string
  status: SessionStatus
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

export type ChatHistoryItem = {
  messageId: string
  sessionKey: string
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'error'
  createdAt: string
  text?: string
  status?: 'complete' | 'error' | 'aborted'
  toolInvocation?: ToolInvocation
}

export type LogLine = {
  ts: string
  level: 'info' | 'warn' | 'error'
  text: string
}

export type GatewayConnectionPayload = {
  source: 'gateway'
  connected: boolean
  at: string
  message?: string
}

export type BootstrapResponse = {
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

export type LogsSnapshot = {
  cursor: number
  lines: LogLine[]
}

export type LogsAppendPayload = {
  cursor: number
  lines: LogLine[]
}

export type LogsResetPayload = {
  reason: string
}

export type StatusResponse = {
  gateway: {
    connected: boolean
    lastUpdatedAt: string
  }
  agents: Agent[]
  channels: Array<{
    channelKey: string
    status: 'connected' | 'disconnected'
    summary: string
  }>
  recentSessions: Session[]
}

export type HttpOk<T> = {
  ok: true
  data: T
}

export type ErrorShape = {
  code: string
  message: string
}

export type BrowserCommand = {
  id?: string
  type?: 'cmd'
  cmd: 'chat.send' | 'chat.abort' | 'chat.inject' | 'session.create' | 'session.open' | 'logs.subscribe' | 'logs.unsubscribe'
  payload?: Record<string, unknown>
}

export type AckEnvelope = {
  id?: string
  type: 'ack'
  ok: boolean
  action: BrowserCommand['cmd']
  result?: Record<string, unknown>
  error?: ErrorShape
}

export type EventEnvelope = {
  type: 'event'
  event:
    | 'gateway.chat'
    | 'gateway.tool'
    | 'gateway.session'
    | 'logs.append'
    | 'logs.reset'
    | 'system.connection'
    | 'status.snapshot'
  kind: 'chat' | 'tool' | 'session' | 'logs' | 'system' | 'status'
  topic?: string
  at?: string
  sessionKey?: string
  runId?: string
  payload: unknown
}

export type ApiResponse<T> = {
  ok: boolean;
  data: T;
};
