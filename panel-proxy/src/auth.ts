import crypto from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

const defaultSessionTtlMs = 12 * 60 * 60 * 1000
const sessionCookieName = 'panel_proxy_session'
const sessionSecret = crypto.randomBytes(32)

type SessionRecord = {
  expiresAt: number
}

type PasswordHashConfig = {
  algorithm: 'scrypt'
  cost: number
  blockSize: number
  parallelization: number
  salt: Buffer
  hash: Buffer
}

type RequestAuthState = {
  ok: boolean
  source?: 'bearer' | 'cookie' | 'disabled'
  expiresAt?: string
}

export type AuthStatusPayload = {
  enabled: boolean
  requiresAuth: boolean
  authenticated: boolean
  loginEnabled: boolean
  apiTokenEnabled: boolean
  expiresAt?: string
}

const sessions = new Map<string, SessionRecord>()

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback
  }

  const parsed = parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const parsePasswordHashConfig = (value: string | undefined): PasswordHashConfig | null => {
  const normalized = (value ?? '').trim()
  if (!normalized) {
    return null
  }

  const parts = normalized.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    throw new Error('Invalid PANEL_LOGIN_PASSWORD_HASH format. Expected scrypt$N$r$p$salt$hash')
  }

  const cost = parsePositiveInt(parts[1], 0)
  const blockSize = parsePositiveInt(parts[2], 0)
  const parallelization = parsePositiveInt(parts[3], 0)
  const salt = Buffer.from(parts[4], 'base64url')
  const hash = Buffer.from(parts[5], 'base64url')

  if (!cost || !blockSize || !parallelization || salt.length === 0 || hash.length === 0) {
    throw new Error('Invalid PANEL_LOGIN_PASSWORD_HASH contents')
  }

  return {
    algorithm: 'scrypt',
    cost,
    blockSize,
    parallelization,
    salt,
    hash,
  }
}

const passwordHashConfig = parsePasswordHashConfig(process.env.PANEL_LOGIN_PASSWORD_HASH)
const apiToken = (process.env.PANEL_PROXY_API_TOKEN ?? '').trim()
const sessionTtlMs = parsePositiveInt(process.env.PANEL_SESSION_TTL_MS, defaultSessionTtlMs)

export const authConfig = {
  enabled: Boolean(passwordHashConfig) || apiToken.length > 0,
  loginEnabled: Boolean(passwordHashConfig),
  apiTokenEnabled: apiToken.length > 0,
  sessionTtlMs,
}

const encodeCookieValue = (sessionId: string): string => {
  const signature = crypto
    .createHmac('sha256', sessionSecret)
    .update(sessionId)
    .digest('base64url')

  return `${sessionId}.${signature}`
}

const decodeCookieValue = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined
  }

  const separatorIndex = value.lastIndexOf('.')
  if (separatorIndex <= 0) {
    return undefined
  }

  const sessionId = value.slice(0, separatorIndex)
  const signature = value.slice(separatorIndex + 1)
  const expected = crypto
    .createHmac('sha256', sessionSecret)
    .update(sessionId)
    .digest('base64url')

  const providedBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (providedBuffer.length !== expectedBuffer.length) {
    return undefined
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer) ? sessionId : undefined
}

const parseCookies = (cookieHeader: string | undefined): Record<string, string> => {
  if (!cookieHeader) {
    return {}
  }

  return cookieHeader
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((accumulator, entry) => {
      const separatorIndex = entry.indexOf('=')
      if (separatorIndex <= 0) {
        return accumulator
      }

      const key = entry.slice(0, separatorIndex).trim()
      const value = entry.slice(separatorIndex + 1).trim()
      accumulator[key] = decodeURIComponent(value)
      return accumulator
    }, {})
}

const extractBearerToken = (authorizationHeader: string | undefined): string | undefined => {
  if (!authorizationHeader) {
    return undefined
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || undefined
}

export function extractRequestBearerToken(request: FastifyRequest): string | undefined {
  return extractBearerToken(typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined)
}

const purgeExpiredSessions = (now = Date.now()) => {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(sessionId)
    }
  }
}

const getSessionRecord = (sessionId: string | undefined): SessionRecord | undefined => {
  if (!sessionId) {
    return undefined
  }

  purgeExpiredSessions()
  const session = sessions.get(sessionId)
  if (!session) {
    return undefined
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId)
    return undefined
  }

  return session
}

const isMatchingApiToken = (candidate: string | undefined): boolean => {
  if (!authConfig.apiTokenEnabled || !candidate) {
    return false
  }

  const candidateBuffer = Buffer.from(candidate)
  const expectedBuffer = Buffer.from(apiToken)
  if (candidateBuffer.length !== expectedBuffer.length) {
    return false
  }

  return crypto.timingSafeEqual(candidateBuffer, expectedBuffer)
}

const isMatchingPassword = (candidate: string | undefined): boolean => {
  if (!authConfig.loginEnabled || !passwordHashConfig || !candidate) {
    return false
  }

  const derived = crypto.scryptSync(candidate, passwordHashConfig.salt, passwordHashConfig.hash.length, {
    N: passwordHashConfig.cost,
    r: passwordHashConfig.blockSize,
    p: passwordHashConfig.parallelization,
  })

  if (derived.length !== passwordHashConfig.hash.length) {
    return false
  }

  return crypto.timingSafeEqual(derived, passwordHashConfig.hash)
}

const serializeCookie = (value: string, maxAgeSeconds: number, secure: boolean): string => {
  const parts = [
    `${sessionCookieName}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ]

  if (secure) {
    parts.push('Secure')
  }

  return parts.join('; ')
}

const clearCookieValue = (secure: boolean): string => {
  const parts = [
    `${sessionCookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ]

  if (secure) {
    parts.push('Secure')
  }

  return parts.join('; ')
}

const shouldUseSecureCookie = (request: FastifyRequest): boolean => {
  const forwardedProto = request.headers['x-forwarded-proto']
  if (typeof forwardedProto === 'string') {
    return forwardedProto.split(',')[0]?.trim() === 'https'
  }

  return request.protocol === 'https'
}

export function applyCorsHeaders(request: FastifyRequest, reply: FastifyReply) {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
  if (origin) {
    reply.header('Access-Control-Allow-Origin', origin)
    reply.header('Vary', 'Origin')
    reply.header('Access-Control-Allow-Credentials', 'true')
  }

  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

export function isPublicPath(pathname: string): boolean {
  return pathname === '/api/auth/me' || pathname === '/api/auth/login' || pathname === '/api/auth/logout'
}

export function resolveRequestAuth(request: FastifyRequest): RequestAuthState {
  if (!authConfig.enabled) {
    return {
      ok: true,
      source: 'disabled',
    }
  }

  const bearerToken = extractRequestBearerToken(request)
  if (isMatchingApiToken(bearerToken)) {
    return {
      ok: true,
      source: 'bearer',
    }
  }

  const cookies = parseCookies(typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined)
  const sessionId = decodeCookieValue(cookies[sessionCookieName])
  const session = getSessionRecord(sessionId)
  if (session) {
    return {
      ok: true,
      source: 'cookie',
      expiresAt: new Date(session.expiresAt).toISOString(),
    }
  }

  return {
    ok: false,
  }
}

export function sendUnauthorized(reply: FastifyReply, message: string = 'Authentication required') {
  reply.code(401).send({
    ok: false,
    error: {
      code: 'unauthorized',
      message,
    },
  })
}

export function sendLoginUnavailable(reply: FastifyReply) {
  reply.code(503).send({
    ok: false,
    error: {
      code: 'login_unavailable',
      message: 'Panel login is not configured on panel-proxy',
    },
  })
}

export function createAuthStatusPayload(request: FastifyRequest): AuthStatusPayload {
  const auth = resolveRequestAuth(request)
  const authEnabled = authConfig.enabled

  return {
    enabled: authEnabled,
    requiresAuth: authEnabled,
    authenticated: authEnabled ? auth.ok : false,
    loginEnabled: authConfig.loginEnabled,
    apiTokenEnabled: authConfig.apiTokenEnabled,
    expiresAt: authEnabled ? auth.expiresAt : undefined,
  }
}

export function createSessionCookie(reply: FastifyReply, request: FastifyRequest): AuthStatusPayload {
  const sessionId = crypto.randomUUID()
  const expiresAt = Date.now() + authConfig.sessionTtlMs
  sessions.set(sessionId, { expiresAt })

  reply.header(
    'Set-Cookie',
    serializeCookie(encodeCookieValue(sessionId), Math.floor(authConfig.sessionTtlMs / 1000), shouldUseSecureCookie(request)),
  )

  return {
    enabled: authConfig.enabled,
    requiresAuth: authConfig.enabled,
    authenticated: true,
    loginEnabled: authConfig.loginEnabled,
    apiTokenEnabled: authConfig.apiTokenEnabled,
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

export function clearSessionCookie(reply: FastifyReply, request: FastifyRequest) {
  const cookies = parseCookies(typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined)
  const sessionId = decodeCookieValue(cookies[sessionCookieName])
  if (sessionId) {
    sessions.delete(sessionId)
  }

  reply.header('Set-Cookie', clearCookieValue(shouldUseSecureCookie(request)))
}

export function verifyPanelPassword(password: string | undefined): boolean {
  return isMatchingPassword(password)
}

export function verifyApiToken(token: string | undefined): boolean {
  return isMatchingApiToken(token)
}

export function buildPasswordHash(password: string): string {
  const salt = crypto.randomBytes(16)
  const cost = 16_384
  const blockSize = 8
  const parallelization = 1
  const hash = crypto.scryptSync(password, salt, 32, {
    N: cost,
    r: blockSize,
    p: parallelization,
  })

  return [
    'scrypt',
    String(cost),
    String(blockSize),
    String(parallelization),
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$')
}
