import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import type WebSocket from 'ws'
import { addSession, bootstrap, fetchAgents, fetchAgentSessions } from './gatewayClient'
import { getLogsSnapshot } from './logsService'
import { subscribeSubscriber, unsubscribeSubscriber, appendLog } from './logsService'
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
    const agents = await fetchAgents()
    const allSessions: Session[] = []
    for (const a of agents) {
      const s = await fetchAgentSessions(a.agentId)
      allSessions.push(...s)
    }
    const data: StatusResponse = snapshotStatus(agents, allSessions)
    const response: HttpOk<typeof data> = { ok: true, data }
    return response
  })

  app.get('/api/logs/snapshot', async () => {
    const data = getLogsSnapshot(100)
    const response: HttpOk<typeof data> = { ok: true, data }
    return response
  })

  app.get('/ws', { websocket: true }, (socket, _request) => {
    const ws: WebSocket = socket
    browserWsHub.addClient(ws)

    ws.on('message', (raw) => {
      let message: BrowserCommand
      try {
        message = JSON.parse(decodeWsMessage(raw)) as BrowserCommand
      } catch {
        ws.send(JSON.stringify(ackError('chat.send', undefined, 'invalid_json', 'Invalid command envelope')))
        return
      }
      handleEnvelope(ws, message)
    })

    ws.on('close', () => {
      unsubscribeSubscriber(ws)
      browserWsHub.removeClient(ws)
    })
  })

  await app.listen({ port, host: '0.0.0.0' })
  console.log(`panel-proxy listening on http://0.0.0.0:${port}`)
}

function handleEnvelope(ws: WebSocket, envelope: BrowserCommand) {
  switch (envelope.cmd) {
    case 'chat.send': {
      const text = typeof envelope.payload?.text === 'string'
        ? envelope.payload.text
        : typeof envelope.payload?.message === 'string'
          ? envelope.payload.message
          : ''

      appendLog({ ts: new Date().toISOString(), level: 'info', text: `chat.send: ${text}` })
      ws.send(JSON.stringify(ack('chat.send', envelope.id, { accepted: true, echo: text })))
      break
    }
    case 'chat.abort': {
      ws.send(JSON.stringify(ack('chat.abort', envelope.id, { accepted: true })))
      break
    }
    case 'session.create': {
      const agentId = typeof envelope.payload?.agentId === 'string' ? envelope.payload.agentId : 'main'
      const slug = typeof envelope.payload?.slug === 'string' ? envelope.payload.slug : `session-${Date.now()}`
      const session = addSession(agentId, slug)
      ws.send(JSON.stringify(ack('session.create', envelope.id, { accepted: true, session })))
      break
    }
    case 'session.open': {
      const sessionKey = typeof envelope.payload?.sessionKey === 'string'
        ? envelope.payload.sessionKey
        : typeof envelope.payload?.sessionId === 'string'
          ? envelope.payload.sessionId
          : ''
      ws.send(JSON.stringify(ack('session.open', envelope.id, { accepted: true, sessionKey })))
      break
    }
    case 'logs.subscribe': {
      subscribeSubscriber(ws)
      ws.send(JSON.stringify(ack('logs.subscribe', envelope.id, { accepted: true, topic: 'logs:gateway' })))
      break
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
