import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import WebSocket from 'ws'
import { Agent, BootstrapResponse, GatewayConnectionPayload, LogLine, Session } from './types'

const openClawConfigPath = path.join(os.homedir(), '.openclaw', 'openclaw.json')
const openClawDeviceIdentityPath = path.join(os.homedir(), '.openclaw', 'identity', 'device.json')
const panelProxyIdentityPath = path.join(os.homedir(), '.openclaw-hanako-panel', 'device-identity.json')
const defaultGatewayPort = 18789
const defaultLogsPollMs = 1000
const defaultLogsLimit = 200
const defaultLogsMaxBytes = 250_000
const gatewayRequestTimeoutMs = 10_000
const gatewayChallengeTimeoutMs = 5_000
const gatewayClientId = 'gateway-client'
const gatewayClientMode = 'backend'
const gatewayDeviceScopes = ['operator.read', 'operator.write'] as const
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')

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

type StoredDeviceIdentity = {
  version?: number
  deviceId: string
  publicKeyPem: string
  privateKeyPem: string
  createdAtMs?: number
}

type DeviceIdentity = {
  deviceId: string
  publicKeyPem: string
  privateKeyPem: string
}

type GatewayErrorShape = {
  code?: string
  message?: string
}

type GatewayResponseFrame = {
  type: 'res'
  id?: string
  ok?: boolean
  payload?: unknown
  error?: GatewayErrorShape
}

type GatewayEventFrame = {
  type: 'event'
  event?: string
  payload?: Record<string, unknown>
}

type GatewayFrame = GatewayResponseFrame | GatewayEventFrame | Record<string, unknown>

type PendingRequest = {
  resolve: (payload: unknown) => void
  reject: (error: Error) => void
  timeoutId: NodeJS.Timeout
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

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  if (spki.length === ed25519SpkiPrefix.length + 32 && spki.subarray(0, ed25519SpkiPrefix.length).equals(ed25519SpkiPrefix)) {
    return spki.subarray(ed25519SpkiPrefix.length)
  }
  return spki
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash('sha256').update(derivePublicKeyRaw(publicKeyPem)).digest('hex')
}

function loadIdentityFromPath(filePath: string): DeviceIdentity | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredDeviceIdentity>
    if (
      typeof parsed.deviceId === 'string'
      && typeof parsed.publicKeyPem === 'string'
      && typeof parsed.privateKeyPem === 'string'
    ) {
      return {
        deviceId: parsed.deviceId,
        publicKeyPem: parsed.publicKeyPem,
        privateKeyPem: parsed.privateKeyPem,
      }
    }
  } catch {
  }

  return undefined
}

function storeIdentity(filePath: string, identity: DeviceIdentity) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const stored: StoredDeviceIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  }
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
}

function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  }
}

let cachedDeviceIdentity: DeviceIdentity | undefined

function resolveDeviceIdentity(): DeviceIdentity {
  if (cachedDeviceIdentity) {
    return cachedDeviceIdentity
  }

  const explicitPath = trimToUndefined(process.env.PANEL_PROXY_DEVICE_IDENTITY_PATH)
  const candidatePaths = [
    explicitPath,
    fs.existsSync(openClawDeviceIdentityPath) ? openClawDeviceIdentityPath : undefined,
    panelProxyIdentityPath,
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)

  for (const candidate of candidatePaths) {
    const identity = loadIdentityFromPath(candidate)
    if (identity) {
      cachedDeviceIdentity = identity
      return identity
    }
  }

  const generated = generateDeviceIdentity()
  storeIdentity(panelProxyIdentityPath, generated)
  cachedDeviceIdentity = generated
  return generated
}

function buildDeviceSignaturePayload(params: {
  deviceId: string
  clientId: string
  clientMode: string
  role: string
  scopes: string[]
  signedAtMs: number
  token: string
  nonce: string
  platform: string
  deviceFamily?: string
}): string {
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token,
    params.nonce,
    params.platform,
    params.deviceFamily ?? '',
  ].join('|')
}

function createDeviceBlock(token: string, nonce: string) {
  const identity = resolveDeviceIdentity()
  const signedAt = Date.now()
  const payload = buildDeviceSignaturePayload({
    deviceId: identity.deviceId,
    clientId: gatewayClientId,
    clientMode: gatewayClientMode,
    role: 'operator',
    scopes: [...gatewayDeviceScopes],
    signedAtMs: signedAt,
    token,
    nonce,
    platform: process.platform,
    deviceFamily: '',
  })
  const signature = base64UrlEncode(
    crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(identity.privateKeyPem)),
  )

  return {
    id: identity.deviceId,
    publicKey: base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem)),
    signature,
    signedAt,
    nonce,
  }
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

function isGatewayEventFrame(payload: GatewayFrame): payload is GatewayEventFrame {
  return payload.type === 'event'
}

function isGatewayResponseFrame(payload: GatewayFrame): payload is GatewayResponseFrame {
  return payload.type === 'res'
}

function normalizeTlsFingerprint(value?: string): string {
  return (value ?? '').trim().replace(/^sha-?256\s*:?\s*/i, '').replace(/[^a-fA-F0-9]/g, '').toLowerCase()
}

function buildGatewayWsOptions(config: GatewayResolvedConfig): WebSocket.ClientOptions {
  const parsed = new URL(config.url)
  const options: WebSocket.ClientOptions = {
    maxPayload: 25 * 1024 * 1024,
  }

  if (parsed.protocol !== 'wss:') {
    return options
  }

  if (config.tlsFingerprint) {
    options.rejectUnauthorized = false
    options.checkServerIdentity = (_host, cert) => {
      const fingerprintValue = typeof cert === 'object' && cert && 'fingerprint256' in cert ? cert.fingerprint256 ?? '' : ''
      const fingerprint = normalizeTlsFingerprint(typeof fingerprintValue === 'string' ? fingerprintValue : '')
      const expected = normalizeTlsFingerprint(config.tlsFingerprint)
      return Boolean(expected) && Boolean(fingerprint) && fingerprint === expected
    }
    return options
  }

  if (isLoopbackHost(parsed.hostname)) {
    options.rejectUnauthorized = false
  }

  return options
}

function makeGatewayError(method: string, error?: GatewayErrorShape): Error {
  const code = trimToUndefined(error?.code)
  const message = trimToUndefined(error?.message) || `${method} failed`
  return new Error(code ? `${message} (${code})` : message)
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
  private ws?: WebSocket
  private pending = new Map<string, PendingRequest>()
  private listeners = new Set<(payload: GatewayConnectionPayload) => void>()
  private connection = makeConnectionPayload(false, 'Gateway logs client idle')
  private connectPromise?: Promise<void>
  private connectResolve?: () => void
  private connectReject?: (error: Error) => void
  private connectRequestId?: string
  private config?: GatewayResolvedConfig
  private requestSeq = 0
  private challengeTimer?: NodeJS.Timeout

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
    const payload = await this.request('logs.tail', params)
    if (!payload || typeof payload !== 'object') {
      throw new Error('Unexpected logs.tail response')
    }

    const parsed = payload as Partial<GatewayLogsTailResult>
    return {
      file: typeof parsed.file === 'string' ? parsed.file : '',
      cursor: typeof parsed.cursor === 'number' ? parsed.cursor : 0,
      size: typeof parsed.size === 'number' ? parsed.size : 0,
      lines: Array.isArray(parsed.lines) ? parsed.lines.filter((line): line is string => typeof line === 'string') : [],
      truncated: parsed.truncated === true,
      reset: parsed.reset === true,
    }
  }

  private nextRequestId(prefix: string): string {
    this.requestSeq += 1
    return `${prefix}-${this.requestSeq}`
  }

  private setConnection(connected: boolean, message?: string) {
    this.connection = makeConnectionPayload(connected, message)
    for (const listener of this.listeners) {
      listener(this.connection)
    }
  }

  private clearChallengeTimer() {
    if (this.challengeTimer) {
      clearTimeout(this.challengeTimer)
      this.challengeTimer = undefined
    }
  }

  private rejectPending(error: Error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private failConnect(error: Error) {
    this.clearChallengeTimer()
    this.connectRequestId = undefined
    if (this.connectReject) {
      this.connectReject(error)
    }
    this.connectResolve = undefined
    this.connectReject = undefined
    this.setConnection(false, error.message)
  }

  private finalizeConnected() {
    this.clearChallengeTimer()
    this.connectRequestId = undefined
    if (this.connectResolve) {
      this.connectResolve()
    }
    this.connectResolve = undefined
    this.connectReject = undefined
    this.setConnection(true, `Connected to ${this.config?.url ?? 'Gateway'}`)
  }

  private cleanupSocket(error?: Error) {
    const socket = this.ws
    this.ws = undefined
    if (socket) {
      socket.removeAllListeners()
      try {
        socket.close()
      } catch {
      }
    }

    this.config = undefined
    if (error) {
      this.failConnect(error)
      this.rejectPending(error)
    } else {
      this.clearChallengeTimer()
      this.connectResolve = undefined
      this.connectReject = undefined
      this.connectRequestId = undefined
    }
  }

  private handleGatewayMessage(raw: WebSocket.RawData) {
    let payload: GatewayFrame
    try {
      payload = JSON.parse(raw.toString()) as GatewayFrame
    } catch {
      return
    }

    if (isGatewayEventFrame(payload)) {
      if (payload.event === 'connect.challenge') {
        void this.sendConnectChallengeResponse(payload.payload)
      }
      return
    }

    if (!isGatewayResponseFrame(payload) || !payload.id) {
      return
    }

    if (payload.id === this.connectRequestId) {
      if (payload.ok) {
        this.finalizeConnected()
        return
      }

      const error = makeGatewayError('connect', payload.error)
      this.cleanupSocket(error)
      return
    }

    const pending = this.pending.get(payload.id)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeoutId)
    this.pending.delete(payload.id)

    if (!payload.ok) {
      const error = makeGatewayError('request', payload.error)
      if (payload.error?.message?.includes('missing scope')) {
        this.setConnection(false, payload.error.message)
      }
      pending.reject(error)
      return
    }

    pending.resolve(payload.payload)
  }

  private async sendConnectChallengeResponse(payload?: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.connectRequestId) {
      return
    }

    const nonce = typeof payload?.nonce === 'string' ? payload.nonce.trim() : ''
    if (!nonce) {
      this.cleanupSocket(new Error('Gateway connect challenge missing nonce'))
      return
    }

    const token = this.config?.token ?? ''
    const connectId = this.nextRequestId('connect')
    this.connectRequestId = connectId

    const message = {
      type: 'req',
      id: connectId,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: gatewayClientId,
          displayName: 'openclaw-hanako-panel proxy',
          version: '0.1.0',
          platform: process.platform,
          mode: gatewayClientMode,
        },
        role: 'operator',
        scopes: [...gatewayDeviceScopes],
        ...(token ? { auth: { token } } : {}),
        device: createDeviceBlock(token, nonce),
      },
    }

    this.ws.send(JSON.stringify(message))
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && !this.connectPromise && !this.connectRequestId) {
      return
    }

    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = (async () => {
      const config = await resolveGatewayConfig()
      this.config = config

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(config.url, buildGatewayWsOptions(config))
        this.ws = ws
        this.connectResolve = resolve
        this.connectReject = reject
        this.setConnection(false, `Connecting to ${config.url}`)

        this.challengeTimer = setTimeout(() => {
          this.cleanupSocket(new Error('Timed out waiting for Gateway connect challenge'))
        }, gatewayChallengeTimeoutMs)

        ws.on('message', (data) => {
          this.handleGatewayMessage(data)
        })

        ws.on('close', (code, reason) => {
          const reasonText = reason.toString().trim()
          const message = `gateway closed (${code}): ${reasonText || 'no reason provided'}`
          this.cleanupSocket(new Error(message))
        })

        ws.on('error', (error) => {
          this.cleanupSocket(error instanceof Error ? error : new Error(String(error)))
        })
      })
    })().finally(() => {
      this.connectPromise = undefined
    })

    return this.connectPromise
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureConnected()

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway WebSocket is not connected')
    }

    const id = this.nextRequestId(method.replace(/\./g, '-'))
    return await new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${gatewayRequestTimeoutMs}ms`))
      }, gatewayRequestTimeoutMs)

      this.pending.set(id, { resolve, reject, timeoutId })
      this.ws?.send(JSON.stringify({
        type: 'req',
        id,
        method,
        params,
      }))
    })
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
