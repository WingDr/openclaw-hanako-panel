import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

type GatewayRequest = {
  id?: string
  method?: string
  params?: Record<string, unknown>
}

type SessionRecord = {
  sessionKey: string
  agentId: string
  updatedAt: string
  preview: string
  status: 'opened' | 'pending' | 'closed'
}

type MessageRecord = {
  messageId: string
  sessionKey: string
  kind: 'user' | 'assistant' | 'system'
  createdAt: string
  text: string
}

const port = Number(process.env.MOCK_GATEWAY_PORT || '22838')
const nonce = 'mock-gateway-nonce'

const now = () => new Date().toISOString()
const messageId = () => `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const sessions: SessionRecord[] = [
  {
    sessionKey: 'agent:mon3tr:hanako-panel:test-session',
    agentId: 'mon3tr',
    updatedAt: now(),
    preview: 'Panel session',
    status: 'opened',
  },
]

const histories = new Map<string, MessageRecord[]>([
  ['agent:mon3tr:hanako-panel:test-session', [
    {
      messageId: messageId(),
      sessionKey: 'agent:mon3tr:hanako-panel:test-session',
      kind: 'assistant',
      createdAt: now(),
      text: 'Mock gateway ready.',
    },
  ]],
])

const jobs: Array<Record<string, unknown>> = [
  {
    id: 'job-main',
    name: 'Main heartbeat',
    enabled: true,
    agentId: 'mon3tr',
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
    sessionTarget: 'main',
    sessionKey: 'agent:mon3tr:main',
    wakeMode: 'now',
    payload: { kind: 'systemEvent', text: 'Main thread reminder.' },
    delivery: { mode: 'none' },
    state: {
      nextRunAtMs: Date.now() + 60 * 60 * 1000,
      lastRunAtMs: Date.now() - 60 * 60 * 1000,
      lastStatus: 'ok',
    },
  },
  {
    id: 'job-isolated',
    name: 'Isolated summary',
    enabled: false,
    agentId: 'mon3tr',
    schedule: { kind: 'every', everyMs: 30 * 60 * 1000 },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: { kind: 'agentTurn', message: 'Summarize the workspace.' },
    delivery: { mode: 'announce', channel: 'discord', to: 'ops-room' },
    state: {
      nextRunAtMs: Date.now() + 30 * 60 * 1000,
      lastRunAtMs: Date.now() - 30 * 60 * 1000,
      lastStatus: 'ok',
    },
  },
]

function send(socket: { send: (payload: string) => void }, payload: Record<string, unknown>) {
  socket.send(JSON.stringify(payload))
}

function updateSessionPreview(sessionKey: string, preview: string) {
  const current = sessions.find((session) => session.sessionKey === sessionKey)
  if (!current) {
    return
  }

  current.preview = preview.slice(0, 120)
  current.updatedAt = now()
}

const httpServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('mock-gateway ok')
})

const server = new WebSocketServer({ server: httpServer })

server.on('connection', (socket) => {
  send(socket, {
    type: 'event',
    event: 'connect.challenge',
    payload: { nonce },
  })

  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString()) as GatewayRequest
    if (!request.id || !request.method) {
      return
    }

    if (request.method === 'connect') {
      send(socket, { type: 'res', id: request.id, ok: true, payload: { accepted: true } })
      return
    }

    if (request.method === 'agents.list') {
      send(socket, {
        type: 'res',
        id: request.id,
        ok: true,
        payload: {
          defaultId: 'mon3tr',
          agents: [
            {
              id: 'mon3tr',
              name: 'Mon3tr',
            },
          ],
        },
      })
      return
    }

    if (request.method === 'sessions.list') {
      send(socket, {
        type: 'res',
        id: request.id,
        ok: true,
        payload: sessions,
      })
      return
    }

    if (request.method === 'chat.history') {
      const sessionKey = typeof request.params?.sessionKey === 'string' ? request.params.sessionKey : ''
      send(socket, {
        type: 'res',
        id: request.id,
        ok: true,
        payload: histories.get(sessionKey) ?? [],
      })
      return
    }

    if (request.method === 'chat.inject') {
      const sessionKey = typeof request.params?.sessionKey === 'string' ? request.params.sessionKey : ''
      const message = typeof request.params?.message === 'string' ? request.params.message : ''
      const nextHistory = histories.get(sessionKey) ?? []
      nextHistory.push({
        messageId: messageId(),
        sessionKey,
        kind: 'user',
        createdAt: now(),
        text: message,
      })
      histories.set(sessionKey, nextHistory)
      updateSessionPreview(sessionKey, message)
      send(socket, { type: 'res', id: request.id, ok: true, payload: { accepted: true, sessionKey } })
      return
    }

    if (request.method === 'cron.list') {
      send(socket, { type: 'res', id: request.id, ok: true, payload: { jobs, total: jobs.length } })
      return
    }

    if (request.method === 'cron.add') {
      const nextJob = {
        id: `job-${jobs.length + 1}`,
        enabled: true,
        ...(request.params?.job ?? {}),
      }
      jobs.push(nextJob)
      send(socket, { type: 'res', id: request.id, ok: true, payload: nextJob })
      return
    }

    if (request.method === 'cron.update') {
      const jobId = String(request.params?.jobId ?? '')
      const patch = (request.params?.patch ?? {}) as Record<string, unknown>
      const index = jobs.findIndex((job) => String(job.id) === jobId)
      if (index >= 0) {
        jobs[index] = { ...jobs[index], ...patch }
      }
      send(socket, { type: 'res', id: request.id, ok: true, payload: jobs[index] ?? { id: jobId, ...patch } })
      return
    }

    if (request.method === 'cron.remove') {
      const jobId = String(request.params?.jobId ?? '')
      const index = jobs.findIndex((job) => String(job.id) === jobId)
      if (index >= 0) {
        jobs.splice(index, 1)
      }
      send(socket, { type: 'res', id: request.id, ok: true, payload: { accepted: true, jobId } })
      return
    }

    if (request.method === 'cron.run') {
      send(socket, { type: 'res', id: request.id, ok: true, payload: { accepted: true } })
      return
    }

    if (request.method === 'status') {
      send(socket, {
        type: 'res',
        id: request.id,
        ok: true,
        payload: {
          heartbeat: {
            defaultAgentId: 'mon3tr',
            agents: [{ agentId: 'mon3tr', enabled: true, every: '30m', everyMs: 1_800_000 }],
          },
          sessions: {
            byAgent: [
              {
                agentId: 'mon3tr',
                recent: sessions.map((session) => ({
                  agentId: session.agentId,
                  key: session.sessionKey,
                  updatedAt: new Date(session.updatedAt).getTime(),
                })),
              },
            ],
          },
        },
      })
      return
    }

    if (request.method === 'logs.tail') {
      send(socket, {
        type: 'res',
        id: request.id,
        ok: true,
        payload: {
          file: 'mock.log',
          cursor: 0,
          size: 0,
          lines: [],
        },
      })
      return
    }

    send(socket, {
      type: 'res',
      id: request.id,
      ok: false,
      error: {
        code: 'UNKNOWN_METHOD',
        message: `unknown method ${request.method}`,
      },
    })
  })
})

httpServer.listen(port, '127.0.0.1', () => {
  console.log(`mock-gateway listening on ws://127.0.0.1:${port}`)
})
