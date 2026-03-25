import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import type WebSocket from 'ws'
import {
  applyCorsHeaders,
  authConfig,
  clearSessionCookie,
  createAuthStatusPayload,
  createSessionCookie,
  isPublicPath,
  resolveRequestAuth,
  sendLoginUnavailable,
  sendUnauthorized,
  verifyPanelPassword,
} from './auth'
import {
  abortChatRun,
  bootstrap,
  createPanelSession,
  fetchAgents,
  fetchAgentSessions,
  fetchChatHistory,
  fetchSessions,
  sendChatInjection,
  sendChatMessage,
} from './gatewayClient'
import {
  getLogsSnapshot,
  getLogsStatus,
  getGatewayConnectionSnapshot,
  subscribeSubscriber,
  unsubscribeSubscriber,
} from './logsService'
import { browserWsHub } from './browserWsHub'
import { AckEnvelope, BrowserCommand, HttpOk, Session, StatusResponse } from './types'
import { snapshotStatus } from './statusService'
import { chatStreamCoordinator } from './streaming/chat/ChatStreamCoordinator'
import { syncBootstrapCoordinator } from './streaming/chat/SyncBootstrapCoordinator'
import {
  createValidatedCronJob,
  CronServiceError,
  getCronJobs,
  removeCronJob,
  toggleCronJob,
  triggerCronJob,
  updateValidatedCronJob,
  validateCronJob,
} from './cronService'
import {
  getWorkspaceTree,
  readWorkspaceFile,
  WorkspaceServiceError,
  writeWorkspaceFile,
} from './workspaceService'

type AgentSessionsParams = { agentId: string }
type ChatHistoryParams = { sessionKey: string }
type WorkspaceParams = { agentId: string }
type CronParams = { jobId: string }
type WorkspaceTreeQuery = { path?: string }
type WorkspaceFileBody = { path?: string; content?: string }
type WorkspaceFileQuery = { path?: string }
type CronQuery = { agentId?: string }
type CronValidateBody = { job?: unknown; patch?: unknown }
type CronBody = { job?: unknown }
type CronPatchBody = { patch?: unknown }
type CronToggleBody = { enabled?: boolean }

const asSessionKeyList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }

  const keys = value
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter((entry) => entry.length > 0)

  return [...new Set(keys)].slice(0, 20)
}

const ack = (action: BrowserCommand['cmd'], id?: string, result?: Record<string, unknown>): AckEnvelope => ({
  id,
  type: 'ack',
  ok: true,
  action,
  result,
})

const ackError = (action: BrowserCommand['cmd'], id: string | undefined, code: string, message: string): AckEnvelope => ({
  id,
  type: 'ack',
  ok: false,
  action,
  error: { code, message },
})

const decodeWsMessage = (raw: unknown): string => {
  if (typeof raw === 'string') {
    return raw
  }

  if (Buffer.isBuffer(raw)) {
    return raw.toString()
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString()
  }

  if (Array.isArray(raw)) {
    return Buffer.concat(raw.filter(Buffer.isBuffer)).toString()
  }

  return String(raw)
}

function sendHttpError(reply: { code: (statusCode: number) => unknown }, error: unknown) {
  if (error instanceof WorkspaceServiceError || error instanceof CronServiceError) {
    reply.code(error.statusCode)
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error instanceof CronServiceError && error.details ? { details: error.details } : {}),
      },
    }
  }

  const message = error instanceof Error ? error.message : 'Unexpected proxy error'
  reply.code(500)
  return {
    ok: false,
    error: {
      code: 'internal_error',
      message,
    },
  }
}

export async function createApp() {
  const app = Fastify({ logger: false })

  await app.register(fastifyWebsocket)

  app.addHook('onRequest', async (request, reply) => {
    applyCorsHeaders(request, reply)

    if (request.method === 'OPTIONS') {
      reply.code(204)
      return reply.send()
    }

    const pathname = request.raw.url?.split('?')[0] || ''
    if (isPublicPath(pathname)) {
      return
    }

    if (!resolveRequestAuth(request).ok) {
      sendUnauthorized(reply)
      return reply
    }
  })

  app.get('/api/auth/me', async (request) => {
    const response: HttpOk<ReturnType<typeof createAuthStatusPayload>> = {
      ok: true,
      data: createAuthStatusPayload(request),
    }
    return response
  })

  app.post<{ Body: { password?: string } }>('/api/auth/login', async (request, reply) => {
    if (!authConfig.loginEnabled) {
      if (!authConfig.enabled) {
        const response: HttpOk<ReturnType<typeof createAuthStatusPayload>> = {
          ok: true,
          data: createAuthStatusPayload(request),
        }
        return response
      }

      sendLoginUnavailable(reply)
      return reply
    }

    const password = typeof request.body?.password === 'string' ? request.body.password : undefined
    if (!verifyPanelPassword(password)) {
      sendUnauthorized(reply, 'Invalid panel password')
      return reply
    }

    const response: HttpOk<ReturnType<typeof createSessionCookie>> = {
      ok: true,
      data: createSessionCookie(reply, request),
    }
    return response
  })

  app.post('/api/auth/logout', async (request, reply) => {
    if (!authConfig.enabled) {
      const response: HttpOk<ReturnType<typeof createAuthStatusPayload>> = {
        ok: true,
        data: createAuthStatusPayload(request),
      }
      return response
    }
    clearSessionCookie(reply, request)
    const response: HttpOk<ReturnType<typeof createAuthStatusPayload>> = {
      ok: true,
      data: {
        ...createAuthStatusPayload(request),
        authenticated: false,
        expiresAt: undefined,
      },
    }
    return response
  })

  app.get('/api/bootstrap', async () => {
    const data = await bootstrap()
    const response: HttpOk<typeof data> = { ok: true, data }
    return response
  })

  app.get('/api/agents', async () => {
    const data = await fetchAgents()
    const response: HttpOk<typeof data> = { ok: true, data }
    return response
  })

  app.get<{ Params: AgentSessionsParams }>('/api/agents/:agentId/sessions', async (req) => {
    const data = await fetchAgentSessions(req.params.agentId)
    const response: HttpOk<typeof data> = { ok: true, data }
    return response
  })

  app.get<{ Params: ChatHistoryParams }>('/api/chat/:sessionKey/history', async (req) => {
    const data = await fetchChatHistory(req.params.sessionKey)
    const response: HttpOk<typeof data> = { ok: true, data }
    return response
  })

  app.get('/api/status', async () => {
    const logsStatus = getLogsStatus()
    let agents: Awaited<ReturnType<typeof fetchAgents>> = []
    let allSessions: Session[] = []
    let gatewayConnected = logsStatus.connected
    let gatewayMessage = logsStatus.lastError || (logsStatus.connected ? 'Live tail available' : 'Logs tail unavailable')

    try {
      agents = await fetchAgents()
      allSessions = await fetchSessions()
      gatewayConnected = getGatewayConnectionSnapshot().connected || agents.length > 0
    } catch (error) {
      gatewayConnected = getGatewayConnectionSnapshot().connected
      gatewayMessage = error instanceof Error ? error.message : gatewayMessage
    }

    const withGateway: StatusResponse = snapshotStatus(agents, allSessions, {
      gatewayConnected,
      logsConnected: logsStatus.connected,
      lastUpdatedAt: logsStatus.lastPollAt || new Date().toISOString(),
      logsMessage: gatewayMessage,
    })
    const response: HttpOk<typeof withGateway> = { ok: true, data: withGateway }
    return response
  })

  app.get('/api/logs/snapshot', async () => {
    const data = await getLogsSnapshot(100)
    const response: HttpOk<typeof data> = { ok: true, data }
    return response
  })

  app.get<{ Params: WorkspaceParams; Querystring: WorkspaceTreeQuery }>('/api/workspace/:agentId/tree', async (request, reply) => {
    try {
      const data = await getWorkspaceTree(request.params.agentId, request.query.path)
      return { ok: true, data }
    } catch (error) {
      return sendHttpError(reply, error)
    }
  })

  app.get<{ Params: WorkspaceParams; Querystring: WorkspaceFileQuery }>('/api/workspace/:agentId/file', async (request, reply) => {
    try {
      const requestedPath = typeof request.query.path === 'string' ? request.query.path : ''
      const data = await readWorkspaceFile(request.params.agentId, requestedPath)
      return { ok: true, data }
    } catch (error) {
      return sendHttpError(reply, error)
    }
  })

  app.put<{ Params: WorkspaceParams; Body: WorkspaceFileBody }>('/api/workspace/:agentId/file', async (request, reply) => {
    try {
      const requestedPath = typeof request.body?.path === 'string' ? request.body.path : ''
      const content = typeof request.body?.content === 'string' ? request.body.content : ''
      const data = await writeWorkspaceFile(request.params.agentId, requestedPath, content)
      return { ok: true, data }
    } catch (error) {
      return sendHttpError(reply, error)
    }
  })

  app.post<{ Body: CronValidateBody }>('/api/cron/validate', async (request, reply) => {
    try {
      const payload = request.body?.job ?? request.body?.patch
      const data = validateCronJob(payload)
      return { ok: true, data }
    } catch (error) {
      return sendHttpError(reply, error)
    }
  })

  app.get<{ Querystring: CronQuery }>('/api/cron', async (request, reply) => {
    try {
      const jobs = await getCronJobs(typeof request.query.agentId === 'string' ? request.query.agentId : undefined)
      return { ok: true, data: { jobs } }
    } catch (error) {
      return sendHttpError(reply, error)
    }
  })

  app.post<{ Body: CronBody }>('/api/cron', async (request, reply) => {
    try {
      const data = await createValidatedCronJob(request.body?.job)
      return { ok: true, data }
    } catch (error) {
      return sendHttpError(reply, error)
    }
  })

  app.patch<{ Params: CronParams; Body: CronPatchBody }>('/api/cron/:jobId', async (request, reply) => {
    try {
      const data = await updateValidatedCronJob(request.params.jobId, request.body?.patch)
      return { ok: true, data }
    } catch (error) {
      return sendHttpError(reply, error)
    }
  })

  app.delete<{ Params: CronParams }>('/api/cron/:jobId', async (request, reply) => {
    try {
      const data = await removeCronJob(request.params.jobId)
      return { ok: true, data }
    } catch (error) {
      return sendHttpError(reply, error)
    }
  })

  app.post<{ Params: CronParams }>('/api/cron/:jobId/run', async (request, reply) => {
    try {
      const data = await triggerCronJob(request.params.jobId)
      return { ok: true, data }
    } catch (error) {
      return sendHttpError(reply, error)
    }
  })

  app.post<{ Params: CronParams; Body: CronToggleBody }>('/api/cron/:jobId/toggle', async (request, reply) => {
    try {
      const enabled = request.body?.enabled === true
      const data = await toggleCronJob(request.params.jobId, enabled)
      return { ok: true, data }
    } catch (error) {
      return sendHttpError(reply, error)
    }
  })

  app.get('/ws', { websocket: true }, (socket, request) => {
    if (!resolveRequestAuth(request).ok) {
      void socket.close(1008, 'unauthorized')
      return
    }

    const ws: WebSocket = socket
    browserWsHub.addClient(ws)
    chatStreamCoordinator.registerClient(ws)
    try {
      ws.send(JSON.stringify({
        type: 'event',
        event: 'system.connection',
        kind: 'system',
        topic: 'gateway',
        at: getGatewayConnectionSnapshot().at,
        payload: getGatewayConnectionSnapshot(),
      }))
    } catch {
    }

    ws.on('message', (raw) => {
      let message: BrowserCommand
      try {
        message = JSON.parse(decodeWsMessage(raw)) as BrowserCommand
      } catch {
        ws.send(JSON.stringify(ackError('chat.send', undefined, 'invalid_json', 'Invalid command envelope')))
        return
      }
      void handleEnvelope(ws, message)
    })

    ws.on('close', () => {
      unsubscribeSubscriber(ws)
      browserWsHub.removeClient(ws)
      chatStreamCoordinator.unregisterClient(ws)
    })
  })

  return app
}

export async function handleEnvelope(ws: WebSocket, envelope: BrowserCommand) {
  switch (envelope.cmd) {
    case 'chat.send': {
      const message = typeof envelope.payload?.text === 'string'
        ? envelope.payload.text
        : typeof envelope.payload?.message === 'string'
          ? envelope.payload.message
          : ''
      const sessionKey = typeof envelope.payload?.sessionKey === 'string'
        ? envelope.payload.sessionKey
        : typeof envelope.payload?.sessionId === 'string'
          ? envelope.payload.sessionId
          : ''
      const idempotencyKey = typeof envelope.payload?.idempotencyKey === 'string'
        ? envelope.payload.idempotencyKey
        : undefined

      if (!sessionKey || !message.trim()) {
        ws.send(JSON.stringify(ackError('chat.send', envelope.id, 'invalid_params', 'chat.send requires sessionKey and message')))
        break
      }

      const gate = chatStreamCoordinator.beforeChatSend(ws, sessionKey, message)
      if (!gate.ok) {
        ws.send(JSON.stringify(ackError('chat.send', envelope.id, gate.code, gate.message)))
        break
      }

      try {
        const result = await sendChatMessage({ sessionKey, message, idempotencyKey })
        chatStreamCoordinator.afterChatSendAck(sessionKey, typeof result.runId === 'string' ? result.runId : undefined)
        ws.send(JSON.stringify(ack('chat.send', envelope.id, result)))
      } catch (error) {
        chatStreamCoordinator.afterChatSendFailure(sessionKey)
        ws.send(JSON.stringify(ackError('chat.send', envelope.id, 'gateway_error', error instanceof Error ? error.message : 'Failed to send chat message')))
      }
      break
    }
    case 'chat.abort': {
      const runId = typeof envelope.payload?.runId === 'string' ? envelope.payload.runId : undefined
      const sessionKey = typeof envelope.payload?.sessionKey === 'string'
        ? envelope.payload.sessionKey
        : typeof envelope.payload?.sessionId === 'string'
          ? envelope.payload.sessionId
          : undefined

      if (!runId && !sessionKey) {
        ws.send(JSON.stringify(ackError('chat.abort', envelope.id, 'invalid_params', 'chat.abort requires runId or sessionKey')))
        break
      }

      const gate = chatStreamCoordinator.beforeChatAbort(ws, { runId, sessionKey })
      if (!gate.ok) {
        ws.send(JSON.stringify(ackError('chat.abort', envelope.id, gate.code, gate.message)))
        break
      }

      try {
        const result = await abortChatRun({ runId, sessionKey })
        chatStreamCoordinator.afterChatAbortAck({ runId, sessionKey })
        ws.send(JSON.stringify(ack('chat.abort', envelope.id, result)))
      } catch (error) {
        ws.send(JSON.stringify(ackError('chat.abort', envelope.id, 'gateway_error', error instanceof Error ? error.message : 'Failed to abort chat run')))
      }
      break
    }
    case 'chat.inject': {
      const message = typeof envelope.payload?.message === 'string'
        ? envelope.payload.message
        : typeof envelope.payload?.text === 'string'
          ? envelope.payload.text
          : ''
      const sessionKey = typeof envelope.payload?.sessionKey === 'string'
        ? envelope.payload.sessionKey
        : typeof envelope.payload?.sessionId === 'string'
          ? envelope.payload.sessionId
          : ''

      if (!sessionKey || !message.trim()) {
        ws.send(JSON.stringify(ackError('chat.inject', envelope.id, 'invalid_params', 'chat.inject requires sessionKey and message')))
        break
      }

      try {
        const result = await sendChatInjection({ sessionKey, message })
        ws.send(JSON.stringify(ack('chat.inject', envelope.id, result)))
      } catch (error) {
        ws.send(JSON.stringify(ackError('chat.inject', envelope.id, 'gateway_error', error instanceof Error ? error.message : 'Failed to inject chat message')))
      }
      break
    }
    case 'session.create': {
      const agentId = typeof envelope.payload?.agentId === 'string' ? envelope.payload.agentId : 'main'
      const title = typeof envelope.payload?.title === 'string' ? envelope.payload.title : undefined

      try {
        const result = await createPanelSession(agentId, title)
        ws.send(JSON.stringify(ack('session.create', envelope.id, result)))
      } catch (error) {
        ws.send(JSON.stringify(ackError('session.create', envelope.id, 'gateway_error', error instanceof Error ? error.message : 'Failed to create session')))
      }
      break
    }
    case 'session.open': {
      const sessionKey = typeof envelope.payload?.sessionKey === 'string'
        ? envelope.payload.sessionKey
        : typeof envelope.payload?.sessionId === 'string'
          ? envelope.payload.sessionId
          : ''
      if (!sessionKey) {
        ws.send(JSON.stringify(ackError('session.open', envelope.id, 'invalid_params', 'session.open requires sessionKey')))
        break
      }

      const gate = chatStreamCoordinator.handleSessionOpen(ws, sessionKey)
      if (!gate.ok) {
        ws.send(JSON.stringify(ackError('session.open', envelope.id, gate.code, gate.message)))
        break
      }

      ws.send(JSON.stringify(ack('session.open', envelope.id, { accepted: true, sessionKey, subscribed: true })))
      break
    }
    case 'sync.bootstrap': {
      const payload = envelope.payload ?? {}
      const directSessionKeys = asSessionKeyList(payload.sessionKeys)
      const selectedSessionKey = typeof payload.sessionKey === 'string' && payload.sessionKey.trim()
        ? payload.sessionKey.trim()
        : ''
      const includeCatalog = payload.includeCatalog === true
      const subscribedSessions = chatStreamCoordinator.getSubscribedSessions(ws)
      const sessionKeys = [...new Set([
        ...directSessionKeys,
        ...(selectedSessionKey ? [selectedSessionKey] : []),
        ...subscribedSessions,
      ])]

      try {
        const [catalog, sessionSnapshots] = await Promise.all([
          syncBootstrapCoordinator.resolveCatalogSnapshot(
            includeCatalog,
            async () => {
              const [agents, sessions] = await Promise.all([fetchAgents(), fetchSessions()])
              return { agents, sessions }
            },
          ),
          syncBootstrapCoordinator.resolveSessionSnapshots(
            sessionKeys,
            (sessionKey) => chatStreamCoordinator.getSessionRuntimeSnapshot(sessionKey),
            async (sessionKey) => await fetchChatHistory(sessionKey),
          ),
        ])

        ws.send(JSON.stringify(ack('sync.bootstrap', envelope.id, {
          accepted: true,
          at: new Date().toISOString(),
          agents: catalog?.agents ?? [],
          sessions: catalog?.sessions ?? [],
          sessionSnapshots,
        })))
      } catch (error) {
        ws.send(JSON.stringify(ackError(
          'sync.bootstrap',
          envelope.id,
          'gateway_error',
          error instanceof Error ? error.message : 'Failed to bootstrap sync',
        )))
      }
      break
    }
    case 'logs.subscribe': {
      void subscribeSubscriber(ws)
        .then(() => {
          ws.send(JSON.stringify(ack('logs.subscribe', envelope.id, { accepted: true, topic: 'logs:gateway' })))
        })
        .catch((error) => {
          ws.send(JSON.stringify(ackError('logs.subscribe', envelope.id, 'gateway_error', error instanceof Error ? error.message : 'Failed to subscribe logs')))
        })
      return
    }
    case 'logs.unsubscribe': {
      unsubscribeSubscriber(ws)
      ws.send(JSON.stringify(ack('logs.unsubscribe', envelope.id, { accepted: true })))
      break
    }
    default:
      ws.send(JSON.stringify(ackError(envelope.cmd, envelope.id, 'unknown_command', 'Unknown command')))
  }
}
