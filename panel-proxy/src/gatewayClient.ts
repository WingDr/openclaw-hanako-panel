import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { pathToFileURL } from 'node:url'
import { Agent, BootstrapResponse, GatewayConnectionPayload, LogLine, Session } from './types'

const openClawConfigPath = path.join(os.homedir(), '.openclaw', 'openclaw.json')
const defaultGatewayPort = 18789
const defaultLogsPollMs = 1000
const defaultLogsLimit = 200
const defaultLogsMaxBytes = 250_000
const gatewayRequestTimeoutMs = 10_000

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

type OpenClawGatewayConfig = {
  gateway?: {
    port?: number
    auth?: {
      mode?: string
      token?: string
    }
    tls?: {
      enabled?: boolean
    }
  }
}

type GatewayResolvedConfig = {
  url: string
  token?: string
  logsPollMs: number
  logsLimit: number
  logsMaxBytes: number
  tlsFingerprint?: string
}

type GatewayAuthProfilesModule = {
  Ks: (opts: {
    url?: string
    token?: string
    method: string
    params?: Record<string, unknown>
    timeoutMs?: number
    clientName?: string
    clientDisplayName?: string
    mode?: string
    scopes?: string[]
    tlsFingerprint?: string
  }) => Promise<unknown>
}

export type LogsTailParams = {
  cursor?: number
  limit?: number
  maxBytes?: number
}

export type GatewayLogsTailResult = {
  file: string
  cursor: number
  size: number
  lines: string[]
  truncated?: boolean
  reset?: boolean
}

const trimToUndefined = (value?: string): string | undefined => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const isLoopbackHost = (hostname: string): boolean => {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

const readLocalOpenClawConfig = (): OpenClawGatewayConfig | undefined => {
  try {
    const raw = fs.readFileSync(openClawConfigPath, 'utf8')
    return JSON.parse(raw) as OpenClawGatewayConfig
  } catch {
    return undefined
  }
}

const resolveGatewayUrlFromConfig = (config?: OpenClawGatewayConfig): string => {
  const port = config?.gateway?.port ?? defaultGatewayPort
  const tlsEnabled = config?.gateway?.tls?.enabled === true
  const protocol = tlsEnabled ? 'wss' : 'ws'
  return `${protocol}://127.0.0.1:${port}`
}

async function resolveTlsFingerprint(url: string): Promise<string | undefined> {
  const configured = trimToUndefined(process.env.OPENCLAW_GATEWAY_TLS_FINGERPRINT)
  if (configured) {
    return configured
  }

  const parsed = new URL(url)
  if (parsed.protocol !== 'wss:' || !isLoopbackHost(parsed.hostname)) {
    return undefined
  }

  return await new Promise<string>((resolve, reject) => {
    const socket = tls.connect({
      host: parsed.hostname,
      port: Number(parsed.port || '443'),
      servername: parsed.hostname,
      rejectUnauthorized: false,
    }, () => {
      const fingerprint = socket.getPeerCertificate()?.fingerprint256
      socket.end()
      if (typeof fingerprint === 'string' && fingerprint.trim()) {
        resolve(fingerprint)
        return
      }
      reject(new Error('Failed to resolve Gateway TLS fingerprint'))
    })

    socket.on('error', (error) => {
      reject(error)
    })
  })
}

async function resolveGatewayConfig(): Promise<GatewayResolvedConfig> {
  const localConfig = readLocalOpenClawConfig()
  const url = trimToUndefined(process.env.OPENCLAW_GATEWAY_WS_URL) || resolveGatewayUrlFromConfig(localConfig)

  return {
    url,
    token: trimToUndefined(process.env.OPENCLAW_GATEWAY_AUTH_TOKEN)
      || trimToUndefined(localConfig?.gateway?.auth?.mode === 'token' ? localConfig.gateway.auth.token : undefined),
    logsPollMs: parsePositiveInt(process.env.OPENCLAW_LOGS_POLL_MS, defaultLogsPollMs),
    logsLimit: parsePositiveInt(process.env.OPENCLAW_LOGS_LIMIT, defaultLogsLimit),
    logsMaxBytes: parsePositiveInt(process.env.OPENCLAW_LOGS_MAX_BYTES, defaultLogsMaxBytes),
    tlsFingerprint: await resolveTlsFingerprint(url),
  }
}

function makeConnectionPayload(connected: boolean, message?: string): GatewayConnectionPayload {
  return {
    source: 'gateway',
    connected,
    at: new Date().toISOString(),
    message,
  }
}

let authProfilesModulePromise: Promise<GatewayAuthProfilesModule> | undefined

function resolveAuthProfilesModulePath(): string {
  const binaryPath = execFileSync('which', ['openclaw'], { encoding: 'utf8' }).trim()
  const packageEntrypoint = fs.realpathSync(binaryPath)
  const distDir = path.join(path.dirname(packageEntrypoint), 'dist')
  const gatewayRpcModule = fs.readdirSync(distDir).find((entry) => /^gateway-rpc-.*\.js$/.test(entry))

  if (!gatewayRpcModule) {
    throw new Error('Failed to resolve OpenClaw gateway-rpc module')
  }

  const gatewayRpcSource = fs.readFileSync(path.join(distDir, gatewayRpcModule), 'utf8')
  const matchedImport = gatewayRpcSource.match(/from "\.\/(auth-profiles-[^"]+\.js)"/)
  if (!matchedImport) {
    throw new Error('Failed to resolve OpenClaw auth-profiles import')
  }

  return path.join(distDir, matchedImport[1])
}

async function loadAuthProfilesModule(): Promise<GatewayAuthProfilesModule> {
  if (!authProfilesModulePromise) {
    authProfilesModulePromise = import(pathToFileURL(resolveAuthProfilesModulePath()).href) as Promise<GatewayAuthProfilesModule>
  }

  return authProfilesModulePromise
}

function normalizeLogLevel(value?: string): LogLine['level'] {
  if (value === 'error' || value === 'fatal') {
    return 'error'
  }

  if (value === 'warn' || value === 'warning') {
    return 'warn'
  }

  return 'info'
}

function extractStructuredMessage(payload: Record<string, unknown>): string {
  return Object.keys(payload)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => {
      const item = payload[key]
      return typeof item === 'string' ? item : JSON.stringify(item)
    })
    .join(' ')
    .trim()
}

export function parseGatewayLogLine(raw: string): LogLine {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>
    const meta = (payload._meta as Record<string, unknown> | undefined) ?? {}
    const ts = typeof payload.time === 'string'
      ? payload.time
      : typeof meta.date === 'string'
        ? meta.date
        : new Date().toISOString()
    const level = normalizeLogLevel(typeof meta.logLevelName === 'string' ? meta.logLevelName.toLowerCase() : undefined)
    const text = extractStructuredMessage(payload) || raw
    return { ts, level, text }
  } catch {
    return { ts: new Date().toISOString(), level: 'info', text: raw }
  }
}

export class GatewayLogsClient {
  private connection = makeConnectionPayload(false, 'Gateway logs client idle')
  private listeners = new Set<(payload: GatewayConnectionPayload) => void>()

  onConnectionChange(listener: (payload: GatewayConnectionPayload) => void): () => void {
    this.listeners.add(listener)
    listener(this.connection)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getConnectionSnapshot(): GatewayConnectionPayload {
    return this.connection
  }

  async getResolvedConfig(): Promise<GatewayResolvedConfig> {
    return resolveGatewayConfig()
  }

  async logsTail(params: LogsTailParams): Promise<GatewayLogsTailResult> {
    const [config, authProfilesModule] = await Promise.all([resolveGatewayConfig(), loadAuthProfilesModule()])

    try {
      const payload = await authProfilesModule.Ks({
        url: config.url,
        token: config.token,
        method: 'logs.tail',
        params: params as Record<string, unknown>,
        timeoutMs: gatewayRequestTimeoutMs,
        clientName: 'gateway-client',
        clientDisplayName: 'openclaw-hanako-panel proxy',
        mode: 'backend',
        tlsFingerprint: config.tlsFingerprint,
      })

      if (!payload || typeof payload !== 'object') {
        throw new Error('Unexpected logs.tail response')
      }

      this.setConnection(true, `Connected to ${config.url}`)
      const parsed = payload as Partial<GatewayLogsTailResult>
      return {
        file: typeof parsed.file === 'string' ? parsed.file : '',
        cursor: typeof parsed.cursor === 'number' ? parsed.cursor : 0,
        size: typeof parsed.size === 'number' ? parsed.size : 0,
        lines: Array.isArray(parsed.lines) ? parsed.lines.filter((line): line is string => typeof line === 'string') : [],
        truncated: parsed.truncated === true,
        reset: parsed.reset === true,
      }
    } catch (error) {
      const nextError = error instanceof Error ? error : new Error(String(error))
      this.setConnection(false, nextError.message)
      throw nextError
    }
  }

  private setConnection(connected: boolean, message?: string) {
    this.connection = makeConnectionPayload(connected, message)
    for (const listener of this.listeners) {
      listener(this.connection)
    }
  }
}

export const gatewayLogsClient = new GatewayLogsClient()

export async function bootstrap(): Promise<BootstrapResponse> {
  const connection = gatewayLogsClient.getConnectionSnapshot()
  return {
    proxyVersion: '0.1.0',
    gateway: { connected: connection.connected, mode: 'proxy' },
    defaultAgentId: 'main',
    features: { chat: true, logs: true, status: true },
  }
}

export async function fetchAgents(): Promise<Agent[]> {
  return mockAgents
}

export async function fetchAgentSessions(agentId: string): Promise<Session[]> {
  return mockSessions.filter((session) => session.agentId === agentId)
}

export function addSession(agentId: string, slug: string, status: Session['status'] = 'pending') {
  const session: Session = {
    sessionKey: `agent:${agentId}:panel:${slug}`,
    agentId,
    updatedAt: new Date().toISOString(),
    preview: 'New panel session',
    status,
  }
  mockSessions.push(session)
  return session
}
