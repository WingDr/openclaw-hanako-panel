import { panelWsUrl } from '../config'

type BrowserCommand = {
  id?: string
  type?: 'cmd'
  cmd: 'chat.send' | 'chat.abort' | 'chat.inject' | 'session.create' | 'session.open' | 'logs.subscribe' | 'logs.unsubscribe'
  payload?: Record<string, unknown>
}

type AckEnvelope = {
  id?: string
  type: 'ack'
  ok: boolean
  action: BrowserCommand['cmd']
  result?: Record<string, unknown>
  error?: {
    code: string
    message: string
  }
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

type RealtimeEnvelope = AckEnvelope | EventEnvelope
type EventHandler = (payload: EventEnvelope) => void
type PendingRequest = {
  resolve: (payload: AckEnvelope) => void
  reject: (error: Error) => void
  timeoutId: number
}

const commandTimeoutMs = 10_000

function isAckEnvelope(value: RealtimeEnvelope): value is AckEnvelope {
  return value.type === 'ack'
}

function makeRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export class RealtimeClient {
  private ws?: WebSocket
  private connectPromise?: Promise<void>
  private pending = new Map<string, PendingRequest>()
  private handlers = new Set<EventHandler>()

  constructor(private url: string = panelWsUrl) {}

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return
    }

    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url)
      let settled = false

      const settle = (callback: () => void) => {
        if (settled) {
          return
        }

        settled = true
        callback()
      }

      ws.addEventListener('open', () => {
        this.ws = ws
        settle(resolve)
      })

      ws.addEventListener('message', (event) => {
        this.handleMessage(event.data)
      })

      ws.addEventListener('error', () => {
        settle(() => reject(new Error('Failed to connect to panel-proxy WebSocket')))
      })

      ws.addEventListener('close', () => {
        if (this.ws === ws) {
          this.ws = undefined
        }
        this.rejectPending(new Error('WebSocket connection closed'))
        this.emitEvent({
          type: 'event',
          event: 'system.connection',
          kind: 'system',
          at: new Date().toISOString(),
          payload: {
            source: 'panel',
            connected: false,
            at: new Date().toISOString(),
            message: 'Panel WebSocket connection closed',
          },
        })
        settle(() => reject(new Error('WebSocket connection closed before ready')))
      })
    }).finally(() => {
      this.connectPromise = undefined
    })

    return this.connectPromise
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  async sendCommand<Result extends Record<string, unknown> = Record<string, unknown>>(
    cmd: BrowserCommand['cmd'],
    payload?: Record<string, unknown>,
  ): Promise<AckEnvelope & { result?: Result }> {
    await this.connect()

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Panel WebSocket is not connected')
    }

    const id = makeRequestId()
    const envelope: BrowserCommand = { id, type: 'cmd', cmd, payload }

    const response = await new Promise<AckEnvelope>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${cmd} acknowledgement`))
      }, commandTimeoutMs)

      this.pending.set(id, { resolve, reject, timeoutId })
      this.ws?.send(JSON.stringify(envelope))
    })

    if (!response.ok) {
      throw new Error(response.error?.message || `${cmd} failed`)
    }

    return response as AckEnvelope & { result?: Result }
  }

  private handleMessage(raw: unknown) {
    if (typeof raw !== 'string') {
      return
    }

    let payload: RealtimeEnvelope
    try {
      payload = JSON.parse(raw) as RealtimeEnvelope
    } catch {
      return
    }

    if (isAckEnvelope(payload)) {
      if (!payload.id) {
        return
      }

      const pending = this.pending.get(payload.id)
      if (!pending) {
        return
      }

      window.clearTimeout(pending.timeoutId)
      this.pending.delete(payload.id)
      pending.resolve(payload)
      return
    }

    for (const handler of this.handlers) {
      handler(payload)
    }
  }

  private rejectPending(error: Error) {
    for (const [id, pending] of this.pending.entries()) {
      window.clearTimeout(pending.timeoutId)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private emitEvent(event: EventEnvelope) {
    for (const handler of this.handlers) {
      handler(event)
    }
  }
}

export const panelRealtime = new RealtimeClient()
