import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import WebSocket from 'ws'
import { Agent, BootstrapResponse, ChatHistoryMessage, GatewayConnectionPayload, LogLine, Session } from './types'

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
const gatewayDeviceScopes = ['operator.admin', 'operator.read', 'operator.write'] as const
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
const activeActivityThresholdMs = 2 * 60 * 1000

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

export type ChatSendResult = {
  accepted: boolean
  runId?: string
}

export type SessionCreateResult = {
  accepted: boolean
  created: boolean
  session: Session
}

const trimToUndefined = (value?: string): string | undefined => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

const sessionKeyAgentPattern = /^agent:([^:]+):/

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }

  return trimToUndefined(value)
}

const asBoolean = (value: unknown): boolean | undefined => {
  return typeof value === 'boolean' ? value : undefined
}

const asFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  return undefined
}

const pickFirst = (record: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key]
    }
  }

  return undefined
}

const collectStringList = (...values: unknown[]): string[] => {
  const output = new Set<string>()

  for (const value of values) {
    const directValue = asString(value)
    if (directValue) {
      output.add(directValue)
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const next = asString(item)
        if (next) {
          output.add(next)
        }
      }
      continue
    }

    const record = asRecord(value)
    if (record) {
      for (const [key, entry] of Object.entries(record)) {
        if (entry === true) {
          output.add(key)
          continue
        }

        const next = asString(entry)
        if (next) {
          output.add(next)
        }
      }
    }
  }

  return [...output]
}

const toIsoTimestamp = (value: unknown): string | undefined => {
  const stringValue = asString(value)
  if (stringValue) {
    const parsed = Date.parse(stringValue)
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
  }

  const numericValue = asFiniteNumber(value)
  if (numericValue === undefined) {
    return undefined
  }

  return new Date(numericValue).toISOString()
}

const inferAgentIdFromSessionKey = (sessionKey: string): string | undefined => {
  const match = sessionKey.match(sessionKeyAgentPattern)
  return match?.[1]
}

const normalizeAgentStatus = (value: unknown): Agent['status'] => {
  const booleanValue = asBoolean(value)
  if (booleanValue !== undefined) {
    return booleanValue ? 'online' : 'offline'
  }

  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['online', 'connected', 'ready', 'active', 'available', 'running', 'busy'].includes(normalized)) {
    return 'online'
  }

  if (['idle', 'away', 'sleeping', 'waiting'].includes(normalized)) {
    return 'idle'
  }

  return 'offline'
}

const normalizeSessionStatus = (value: unknown): Session['status'] => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['pending', 'creating'].includes(normalized)) {
    return 'pending'
  }

  if (['closed', 'archived', 'done', 'stopped'].includes(normalized)) {
    return 'closed'
  }

  return 'opened'
}

const normalizeHistoryAuthor = (value: unknown): ChatHistoryMessage['author'] => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if ([
    'user',
    'human',
    'operator',
    'customer',
    'client',
    'request',
    'prompt',
    'input',
    'incoming',
    'inbound',
  ].includes(normalized)) {
    return 'user'
  }

  return 'agent'
}

function collectMessageText(value: unknown): string[] {
  const directValue = asString(value)
  if (directValue) {
    return [directValue]
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectMessageText(entry))
  }

  const record = asRecord(value)
  if (!record) {
    return []
  }

  const parts = [
    record.text,
    record.message,
    record.body,
    record.value,
    record.delta,
    record.summary,
    record.content,
    record.contents,
    record.parts,
    record.segments,
    record.items,
    record.blocks,
  ].flatMap((entry) => collectMessageText(entry))

  if (parts.length > 0) {
    return parts
  }

  return Object.keys(record)
    .filter((key) => /^\d+$/.test(key))
    .sort((left, right) => Number(left) - Number(right))
    .flatMap((key) => collectMessageText(record[key]))
}

function normalizeHistoryRecord(
  raw: unknown,
  sessionKey: string,
  index: number,
  fallbackCreatedAt: string,
): (ChatHistoryMessage & { order: number }) | undefined {
  if (typeof raw === 'string') {
    const text = trimToUndefined(raw)
    if (!text) {
      return undefined
    }

    return {
      id: `${sessionKey}:history:${index + 1}`,
      sessionKey,
      author: 'agent',
      text,
      createdAt: fallbackCreatedAt,
      order: index,
    }
  }

  const record = asRecord(raw)
  if (!record) {
    return undefined
  }

  const text = trimToUndefined(collectMessageText(raw).join('\n\n'))
  if (!text) {
    return undefined
  }

  return {
    id: asString(pickFirst(record, ['id', 'messageId', 'entryId', 'key'])) ?? `${sessionKey}:history:${index + 1}`,
    sessionKey,
    author: normalizeHistoryAuthor(pickFirst(record, ['author', 'role', 'sender', 'from', 'source', 'direction'])),
    text,
    createdAt: toIsoTimestamp(pickFirst(record, ['createdAt', 'timestamp', 'ts', 'time', 'at', 'date'])) ?? fallbackCreatedAt,
    order: index,
  }
}

function normalizeChatHistoryPayload(payload: unknown, sessionKey: string): ChatHistoryMessage[] {
  const fallbackCreatedAt = new Date().toISOString()
  const rawEntries = Array.isArray(payload)
    ? payload
    : (() => {
        const record = asRecord(payload)
        if (!record) {
          return []
        }

        const nestedCollection = ['messages', 'history', 'items', 'list', 'entries', 'transcript', 'conversation']
          .map((key) => record[key])
          .find((value) => Array.isArray(value) || Boolean(asRecord(value)))

        if (Array.isArray(nestedCollection)) {
          return nestedCollection
        }

        const nestedRecord = asRecord(nestedCollection)
        if (nestedRecord) {
          return Object.values(nestedRecord)
        }

        return Object.keys(record).some((key) => ['text', 'message', 'content', 'role', 'author'].includes(key))
          ? [record]
          : []
      })()

  return rawEntries
    .map((entry, index) => normalizeHistoryRecord(entry, sessionKey, index, fallbackCreatedAt))
    .filter((entry): entry is ChatHistoryMessage & { order: number } => Boolean(entry))
    .sort((left, right) => {
      if (left.createdAt === right.createdAt) {
        return left.order - right.order
      }

      return left.createdAt < right.createdAt ? -1 : 1
    })
    .map(({ order: _order, ...message }) => message)
}

function normalizeAgentRecord(raw: unknown, fallbackId?: string): Agent | undefined {
  if (typeof raw === 'string') {
    return {
      agentId: raw,
      label: raw,
      status: 'online',
      capabilities: [],
    }
  }

  const record = asRecord(raw)
  if (!record) {
    const status = normalizeAgentStatus(raw)
    return fallbackId
      ? {
          agentId: fallbackId,
          label: fallbackId,
          status,
          capabilities: [],
        }
      : undefined
  }

  const agentId = asString(pickFirst(record, ['agentId', 'id', 'agent', 'agentKey', 'key']))
    ?? fallbackId
  if (!agentId) {
    return undefined
  }

  return {
    agentId,
    label: asString(pickFirst(record, ['label', 'name', 'displayName', 'title'])) ?? agentId,
    status: normalizeAgentStatus(pickFirst(record, ['status', 'state', 'presence', 'connectionState', 'connected'])),
    capabilities: collectStringList(
      record.capabilities,
      record.features,
      record.scopes,
      record.roles,
    ),
  }
}

function normalizePresencePayload(payload: unknown): Agent[] {
  const items: Array<{ raw: unknown; fallbackId?: string }> = []

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      items.push({ raw: entry })
    }
  } else {
    const record = asRecord(payload)
    if (!record) {
      return []
    }

    const nestedCollection = ['agents', 'items', 'list', 'entries', 'presence']
      .map((key) => record[key])
      .find((value) => Array.isArray(value) || Boolean(asRecord(value)))

    if (Array.isArray(nestedCollection)) {
      for (const entry of nestedCollection) {
        items.push({ raw: entry })
      }
    } else {
      const nestedRecord = asRecord(nestedCollection)
      if (nestedRecord) {
        for (const [key, value] of Object.entries(nestedRecord)) {
          items.push({ raw: value, fallbackId: key })
        }
      } else {
        for (const [key, value] of Object.entries(record)) {
          if (['summary', 'meta', 'gateway', 'system', 'status'].includes(key)) {
            continue
          }

          items.push({ raw: value, fallbackId: key })
        }
      }
    }
  }

  const agentsById = new Map<string, Agent>()
  for (const item of items) {
    const normalized = normalizeAgentRecord(item.raw, item.fallbackId)
    if (normalized) {
      agentsById.set(normalized.agentId, normalized)
    }
  }

  return [...agentsById.values()]
}

function normalizeAgentsListPayload(payload: unknown): Agent[] {
  const record = asRecord(payload)
  const rawAgents = Array.isArray(record?.agents) ? record.agents : Array.isArray(payload) ? payload : []
  const agentsById = new Map<string, Agent>()

  for (const rawAgent of rawAgents) {
    const agent = normalizeAgentRecord(rawAgent)
    if (agent) {
      agentsById.set(agent.agentId, {
        ...agent,
        status: 'unknown',
      })
      continue
    }

    const agentRecord = asRecord(rawAgent)
    const agentId = asString(agentRecord?.id)
    if (!agentId) {
      continue
    }

    agentsById.set(agentId, {
      agentId,
      label: asString(agentRecord?.name) ?? agentId,
      status: 'unknown',
      capabilities: [],
    })
  }

  return [...agentsById.values()].sort((left, right) => left.agentId.localeCompare(right.agentId))
}

function normalizeStatusPayloadAgents(payload: unknown): Agent[] {
  const record = asRecord(payload)
  if (!record) {
    return []
  }

  const activityByAgent = new Map<string, number>()
  const sessionsByAgent = Array.isArray(asRecord(record.sessions)?.byAgent)
    ? (asRecord(record.sessions)?.byAgent as unknown[])
    : []

  for (const item of sessionsByAgent) {
    const itemRecord = asRecord(item)
    const agentId = asString(itemRecord?.agentId)
    if (!agentId) {
      continue
    }

    const recentSessions = Array.isArray(itemRecord?.recent) ? itemRecord.recent : []
    for (const recentSession of recentSessions) {
      const recentRecord = asRecord(recentSession)
      const updatedAtMs = asFiniteNumber(recentRecord?.updatedAt)
      if (updatedAtMs !== undefined) {
        activityByAgent.set(agentId, Math.max(activityByAgent.get(agentId) ?? updatedAtMs, updatedAtMs))
      }
    }
  }

  const rawAgents = Array.isArray(record.agents)
    ? record.agents
    : Array.isArray(asRecord(record.heartbeat)?.agents)
      ? (asRecord(record.heartbeat)?.agents as unknown[])
      : []

  const nowMs = Date.now()
  const agentsById = new Map<string, Agent>()
  for (const rawAgent of rawAgents) {
    const agentRecord = asRecord(rawAgent)
    if (!agentRecord) {
      continue
    }

    const agentId = asString(pickFirst(agentRecord, ['agentId', 'id']))
    if (!agentId) {
      continue
    }

    const directRecentSessions = Array.isArray(asRecord(agentRecord.sessions)?.recent)
      ? (asRecord(agentRecord.sessions)?.recent as unknown[])
      : []
    let latestActivityMs = activityByAgent.get(agentId)
    for (const recentSession of directRecentSessions) {
      const recentRecord = asRecord(recentSession)
      const updatedAtMs = asFiniteNumber(recentRecord?.updatedAt)
      if (updatedAtMs !== undefined) {
        latestActivityMs = Math.max(latestActivityMs ?? updatedAtMs, updatedAtMs)
      }
    }

    const heartbeatEnabled = asBoolean(asRecord(agentRecord.heartbeat)?.enabled) === true
      || asBoolean(agentRecord.enabled) === true
    const ageMs = latestActivityMs !== undefined ? Math.max(0, nowMs - latestActivityMs) : undefined
    const hasSeenActivity = latestActivityMs !== undefined || directRecentSessions.length > 0
    let status: Agent['status'] = 'offline'
    if (ageMs !== undefined && ageMs <= activeActivityThresholdMs) {
      status = 'online'
    } else if (hasSeenActivity || heartbeatEnabled) {
      status = 'idle'
    }

    agentsById.set(agentId, {
      agentId,
      label: asString(pickFirst(agentRecord, ['name', 'label', 'displayName'])) ?? agentId,
      status,
      capabilities: [],
    })
  }

  return [...agentsById.values()].sort((left, right) => left.agentId.localeCompare(right.agentId))
}

function normalizeSessionRecord(raw: unknown, fallbackKey?: string): Session | undefined {
  if (typeof raw === 'string') {
    const agentId = inferAgentIdFromSessionKey(raw)
    if (!agentId) {
      return undefined
    }

    return {
      sessionKey: raw,
      agentId,
      updatedAt: new Date().toISOString(),
      preview: raw,
      status: 'opened',
    }
  }

  const record = asRecord(raw)
  if (!record) {
    return undefined
  }

  const sessionKey = asString(pickFirst(record, ['sessionKey', 'key', 'id'])) ?? fallbackKey
  if (!sessionKey) {
    return undefined
  }

  const agentId = asString(pickFirst(record, ['agentId', 'agent', 'agentKey']))
    ?? inferAgentIdFromSessionKey(sessionKey)
  if (!agentId) {
    return undefined
  }

  return {
    sessionKey,
    agentId,
    updatedAt: toIsoTimestamp(
      pickFirst(record, ['updatedAt', 'lastUpdatedAt', 'updated', 'modifiedAt', 'lastActivityAt', 'createdAt', 'ts']),
    ) ?? new Date().toISOString(),
    preview: asString(pickFirst(record, ['preview', 'title', 'summary', 'name', 'label'])) ?? sessionKey,
    status: normalizeSessionStatus(pickFirst(record, ['status', 'state'])),
  }
}

function normalizeSessionsPayload(payload: unknown): Session[] {
  const sessionsByKey = new Map<string, Session>()

  const collect = (value: unknown, fallbackKey?: string) => {
    const normalized = normalizeSessionRecord(value, fallbackKey)
    if (normalized) {
      sessionsByKey.set(normalized.sessionKey, normalized)
    }
  }

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      collect(entry)
    }
  } else {
    const record = asRecord(payload)
    if (!record) {
      return []
    }

    const nestedCollection = ['sessions', 'items', 'list', 'entries']
      .map((key) => record[key])
      .find((value) => Array.isArray(value) || Boolean(asRecord(value)))

    if (Array.isArray(nestedCollection)) {
      for (const entry of nestedCollection) {
        collect(entry)
      }
    } else {
      const nestedRecord = asRecord(nestedCollection)
      if (nestedRecord) {
        for (const [key, value] of Object.entries(nestedRecord)) {
          collect(value, key)
        }
      } else {
        for (const [key, value] of Object.entries(record)) {
          collect(value, key)
        }
      }
    }
  }

  return [...sessionsByKey.values()].sort((left, right) => {
    if (left.updatedAt === right.updatedAt) {
      return left.sessionKey.localeCompare(right.sessionKey)
    }

    return left.updatedAt > right.updatedAt ? -1 : 1
  })
}

function deriveAgentsFromSessions(sessions: Session[], fallbackStatus: Agent['status'] = 'unknown'): Agent[] {
  const agentsById = new Map<string, Agent>()

  for (const session of sessions) {
    if (!agentsById.has(session.agentId)) {
      agentsById.set(session.agentId, {
        agentId: session.agentId,
        label: session.agentId,
        status: fallbackStatus,
        capabilities: [],
      })
    }
  }

  return [...agentsById.values()].sort((left, right) => left.agentId.localeCompare(right.agentId))
}

function mergeAgents(...groups: Agent[][]): Agent[] {
  const agentsById = new Map<string, Agent>()

  for (const group of groups) {
    for (const agent of group) {
      const existing = agentsById.get(agent.agentId)
      if (!existing) {
        agentsById.set(agent.agentId, agent)
        continue
      }

      const existingHasCustomLabel = existing.label.trim() !== existing.agentId.trim()
      const nextHasCustomLabel = agent.label.trim() !== agent.agentId.trim()
      const mergedStatus = agent.status === 'unknown' && existing.status !== 'unknown'
        ? existing.status
        : agent.status

      agentsById.set(agent.agentId, {
        ...existing,
        ...agent,
        label: nextHasCustomLabel || !existingHasCustomLabel ? agent.label || existing.label : existing.label,
        status: mergedStatus,
        capabilities: Array.from(new Set([...existing.capabilities, ...agent.capabilities])),
      })
    }
  }

  return [...agentsById.values()].sort((left, right) => left.agentId.localeCompare(right.agentId))
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

function isMissingScopeError(error?: GatewayErrorShape): boolean {
  return Boolean(error?.message?.includes('missing scope'))
}

function isUnknownMethodError(error?: GatewayErrorShape): boolean {
  return Boolean(error?.message?.includes('unknown method'))
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
  private systemPresenceUnavailable = false
  private unsupportedMethods = new Set<string>()

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

  async chatSend(params: { sessionKey: string; text: string; agentId?: string }): Promise<ChatSendResult> {
    const payload = await this.request('chat.send', {
      sessionKey: params.sessionKey,
      text: params.text,
      ...(params.agentId ? { agentId: params.agentId } : {}),
    })

    const record = asRecord(payload)
    return {
      accepted: true,
      runId: asString(record?.runId) ?? asString(record?.id),
    }
  }

  async chatHistory(params: { sessionKey: string }): Promise<ChatHistoryMessage[]> {
    let lastError: Error | undefined

    for (const method of ['chat.history', 'chat.history.get']) {
      if (this.unsupportedMethods.has(method)) {
        continue
      }

      try {
        const payload = await this.request(method, { sessionKey: params.sessionKey })
        return normalizeChatHistoryPayload(payload, params.sessionKey)
      } catch (error) {
        if (error instanceof Error && error.message.includes('unknown method')) {
          this.unsupportedMethods.add(method)
          lastError = error
          continue
        }

        throw error
      }
    }

    if (lastError) {
      throw lastError
    }

    return []
  }

  async systemPresence(): Promise<Agent[]> {
    if (this.systemPresenceUnavailable) {
      return []
    }

    const results: Agent[][] = []
    let lastError: Error | undefined

    for (const method of ['system-presence', 'system.presence']) {
      if (this.unsupportedMethods.has(method)) {
        continue
      }

      try {
        const payload = await this.request(method)
        const agents = normalizePresencePayload(payload)
        if (agents.length > 0) {
          results.push(agents)
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('unknown method')) {
          this.unsupportedMethods.add(method)
        }
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }

    if (results.length > 0) {
      return mergeAgents(...results)
    }

    if (lastError) {
      throw lastError
    }

    return []
  }

  async agentsList(): Promise<Agent[]> {
    const payload = await this.request('agents.list')
    return normalizeAgentsListPayload(payload)
  }

  async statusAgents(): Promise<Agent[]> {
    const payload = await this.request('status')
    return normalizeStatusPayloadAgents(payload)
  }

  async sessionsList(agentId?: string): Promise<Session[]> {
    const payload = await this.request('sessions.list')
    const sessions = normalizeSessionsPayload(payload)

    if (!agentId) {
      return sessions
    }

    return sessions.filter((session) => session.agentId === agentId)
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
    this.systemPresenceUnavailable = false
    this.unsupportedMethods.clear()
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
      if (isMissingScopeError(payload.error) && payload.id.startsWith('system-presence-')) {
        this.systemPresenceUnavailable = true
      }
      if (isUnknownMethodError(payload.error) && payload.id.startsWith('system-presence-')) {
        this.unsupportedMethods.add('system.presence')
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

function buildPanelSession(agentId: string, slug: string, preview?: string): Session {
  return {
    sessionKey: `agent:${agentId}:panel:${slug}`,
    agentId,
    updatedAt: new Date().toISOString(),
    preview: preview || 'New panel session',
    status: 'pending',
  }
}

export async function bootstrap(): Promise<BootstrapResponse> {
  const connection = gatewayLogsClient.getConnectionSnapshot()
  let defaultAgentId = 'main'

  try {
    const agents = await fetchAgents()
    defaultAgentId = agents[0]?.agentId || defaultAgentId
  } catch {
  }

  return {
    proxyVersion: '0.1.0',
    gateway: { connected: connection.connected, mode: 'proxy' },
    defaultAgentId,
    features: { chat: true, logs: true, status: true },
  }
}

export async function fetchAgents(): Promise<Agent[]> {
  let agentsFromCatalog: Agent[] = []
  let agentsFromStatus: Agent[] = []
  try {
    agentsFromCatalog = await gatewayLogsClient.agentsList()
  } catch {
  }
  try {
    agentsFromStatus = await gatewayLogsClient.statusAgents()
  } catch {
  }

  const sessions = await gatewayLogsClient.sessionsList()
  const agentsFromSessions = deriveAgentsFromSessions(sessions, 'unknown')
  return mergeAgents(agentsFromCatalog, agentsFromStatus, agentsFromSessions)
}

export async function fetchAgentSessions(agentId: string): Promise<Session[]> {
  return gatewayLogsClient.sessionsList(agentId)
}

export async function fetchSessions(): Promise<Session[]> {
  return gatewayLogsClient.sessionsList()
}

export async function fetchChatHistory(sessionKey: string): Promise<ChatHistoryMessage[]> {
  return gatewayLogsClient.chatHistory({ sessionKey })
}

export async function sendChatMessage(params: { sessionKey: string; text: string; agentId?: string }): Promise<ChatSendResult> {
  return gatewayLogsClient.chatSend(params)
}

export async function createPanelSession(agentId: string, slug: string, title?: string): Promise<SessionCreateResult> {
  const sessionKey = `agent:${agentId}:panel:${slug}`
  const existingSessions = await fetchAgentSessions(agentId)
  const existing = existingSessions.find((session) => session.sessionKey === sessionKey)

  if (existing) {
    return {
      accepted: true,
      created: false,
      session: existing,
    }
  }

  return {
    accepted: true,
    created: true,
    session: buildPanelSession(agentId, slug, title),
  }
}
