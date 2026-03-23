import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import type WebSocket from 'ws'
import { bootstrap, createPanelSession, fetchAgents, fetchAgentSessions, fetchSessions, sendChatMessage } from './gatewayClient'
import { getLogsSnapshot, getLogsStatus, getGatewayConnectionSnapshot, subscribeSubscriber, unsubscribeSubscriber } from './logsService'
import { browserWsHub } from './browserWsHub'
import { AckEnvelope, BrowserCommand, HttpOk, Session, StatusResponse } from './types'
import { snapshotStatus } from './statusService'

const defaultPort = 22846

const parsePort = (...candidates: Array<string | undefined>): number => {
  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }

    const parsed = parseInt(candidate, 10)
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed
    }
  }

  return defaultPort
}

const port = parsePort(process.env.PANEL_PROXY_PORT, process.env.PORT)

type AgentSessionsParams = { agentId: string }

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

async function main() {
  const app = Fastify({ logger: false })
  await app.register(fastifyWebsocket)

  app.addHook('onRequest', async (request, reply) => {
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '*'
    reply.header('Access-Control-Allow-Origin', origin)
    reply.header('Vary', 'Origin')
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (request.method === 'OPTIONS') {
      reply.code(204)
      return reply.send()
    }
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
    const agentId = req.params.agentId
    const data = await fetchAgentSessions(agentId)
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

  app.get('/ws', { websocket: true }, (socket, _request) => {
    const ws: WebSocket = socket
    browserWsHub.addClient(ws)
    try {
      ws.send(JSON.stringify({
        type: 'event',
        event: 'system.connection',
        topic: 'gateway',
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
    })
  })

  await app.listen({ port, host: '0.0.0.0' })
  console.log(`panel-proxy listening on http://0.0.0.0:${port}`)
}

async function handleEnvelope(ws: WebSocket, envelope: BrowserCommand) {
  switch (envelope.cmd) {
    case 'chat.send': {
      const text = typeof envelope.payload?.text === 'string'
        ? envelope.payload.text
        : typeof envelope.payload?.message === 'string'
          ? envelope.payload.message
          : ''
      const sessionKey = typeof envelope.payload?.sessionKey === 'string'
        ? envelope.payload.sessionKey
        : typeof envelope.payload?.sessionId === 'string'
          ? envelope.payload.sessionId
          : ''
      const agentId = typeof envelope.payload?.agentId === 'string' ? envelope.payload.agentId : undefined

      if (!sessionKey || !text.trim()) {
        ws.send(JSON.stringify(ackError('chat.send', envelope.id, 'invalid_params', 'chat.send requires sessionKey and text')))
        break
      }

      try {
        const result = await sendChatMessage({ agentId, sessionKey, text })
        ws.send(JSON.stringify(ack('chat.send', envelope.id, result)))
      } catch (error) {
        ws.send(JSON.stringify(ackError('chat.send', envelope.id, 'gateway_error', error instanceof Error ? error.message : 'Failed to send chat message')))
      }
      break
    }
    case 'chat.abort': {
      ws.send(JSON.stringify(ack('chat.abort', envelope.id, { accepted: true })))
      break
    }
    case 'session.create': {
      const agentId = typeof envelope.payload?.agentId === 'string' ? envelope.payload.agentId : 'main'
      const slug = typeof envelope.payload?.slug === 'string' ? envelope.payload.slug : `session-${Date.now()}`
      const title = typeof envelope.payload?.title === 'string' ? envelope.payload.title : undefined

      try {
        const result = await createPanelSession(agentId, slug, title)
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

      ws.send(JSON.stringify(ack('session.open', envelope.id, { accepted: true, sessionKey })))
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
      ws.send(JSON.stringify(ackError('chat.send', envelope.id, 'unknown_command', 'Unknown command')))
  }
}

main().catch((err) => {
  console.error('panel-proxy failed to start', err)
  process.exit(1)
})
