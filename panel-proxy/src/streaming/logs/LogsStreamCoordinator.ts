import type WebSocket from 'ws'
import { browserWsHub } from '../../browserWsHub'
import { gatewayLogsClient, parseGatewayLogLine } from '../../gatewayClient'
import type {
  EventEnvelope,
  GatewayConnectionPayload,
  LogLine,
  LogsAppendPayload,
  LogsResetPayload,
  LogsSnapshot,
} from '../../types'

const maxBufferedLines = 1000
const logsTopic = 'logs:gateway'

type LogsState = {
  cursor: number | null
  lines: LogLine[]
  subscribers: Set<WebSocket>
  polling: boolean
  pollTimer?: NodeJS.Timeout
  initialized: boolean
  initializingPromise?: Promise<void>
  lastError?: string
  lastPollAt?: string
}

export class LogsStreamCoordinator {
  private readonly state: LogsState = {
    cursor: null,
    lines: [],
    subscribers: new Set(),
    polling: false,
    initialized: false,
  }

  constructor() {
    gatewayLogsClient.onConnectionChange((payload) => {
      const envelope: EventEnvelope = {
        type: 'event',
        event: 'system.connection',
        kind: 'system',
        topic: 'gateway',
        at: payload.at,
        payload,
      }
      browserWsHub.broadcast(envelope)
    })
  }

  getGatewayConnectionSnapshot(): GatewayConnectionPayload {
    return gatewayLogsClient.getConnectionSnapshot()
  }

  getLogsStatus() {
    const liveTailAvailable = this.state.initialized && !this.state.lastError
    return {
      polling: this.state.polling,
      initialized: this.state.initialized,
      lastError: this.state.lastError,
      lastPollAt: this.state.lastPollAt,
      connected: liveTailAvailable,
    }
  }

  async getLogsSnapshot(limit = 100): Promise<LogsSnapshot> {
    await this.ensureInitialized()
    return {
      cursor: this.state.cursor ?? 0,
      lines: this.state.lines.slice(-limit),
    }
  }

  async subscribe(ws: WebSocket): Promise<void> {
    this.state.subscribers.add(ws)
    await this.ensureInitialized()

    this.sendEvent(ws, {
      type: 'event',
      event: 'logs.reset',
      kind: 'logs',
      topic: logsTopic,
      at: new Date().toISOString(),
      payload: { reason: 'subscribed' } satisfies LogsResetPayload,
    })

    this.sendEvent(ws, {
      type: 'event',
      event: 'logs.append',
      kind: 'logs',
      topic: logsTopic,
      at: new Date().toISOString(),
      payload: {
        cursor: this.state.cursor ?? 0,
        lines: this.state.lines,
      } satisfies LogsAppendPayload,
    })

    this.sendEvent(ws, {
      type: 'event',
      event: 'system.connection',
      kind: 'system',
      topic: 'gateway',
      at: gatewayLogsClient.getConnectionSnapshot().at,
      payload: gatewayLogsClient.getConnectionSnapshot(),
    })

    this.startPolling()
  }

  unsubscribe(ws: WebSocket) {
    this.state.subscribers.delete(ws)
    if (this.state.subscribers.size === 0) {
      this.stopPolling()
    }
  }

  private appendLines(lines: LogLine[]) {
    if (lines.length === 0) {
      return
    }

    this.state.lines.push(...lines)
    if (this.state.lines.length > maxBufferedLines) {
      this.state.lines.splice(0, this.state.lines.length - maxBufferedLines)
    }
  }

  private sendEvent(target: WebSocket, envelope: EventEnvelope) {
    try {
      target.send(JSON.stringify(envelope))
    } catch {
      this.state.subscribers.delete(target)
    }
  }

  private broadcastToSubscribers(envelope: EventEnvelope) {
    for (const subscriber of this.state.subscribers) {
      this.sendEvent(subscriber, envelope)
    }
  }

  private emitLogsReset(reason: string) {
    const payload: LogsResetPayload = { reason }
    const envelope: EventEnvelope = {
      type: 'event',
      event: 'logs.reset',
      kind: 'logs',
      topic: logsTopic,
      at: new Date().toISOString(),
      payload,
    }
    this.broadcastToSubscribers(envelope)
  }

  private emitLogsAppend(lines: LogLine[]) {
    const payload: LogsAppendPayload = {
      cursor: this.state.cursor ?? 0,
      lines,
    }
    const envelope: EventEnvelope = {
      type: 'event',
      event: 'logs.append',
      kind: 'logs',
      topic: logsTopic,
      at: new Date().toISOString(),
      payload,
    }
    this.broadcastToSubscribers(envelope)
  }

  private async loadSnapshot(cursor?: number): Promise<{ appendedLines: LogLine[]; reset: boolean }> {
    const config = await gatewayLogsClient.getResolvedConfig()
    const result = await gatewayLogsClient.logsTail({
      cursor,
      limit: config.logsLimit,
      maxBytes: config.logsMaxBytes,
    })

    const nextLines = result.lines.map(parseGatewayLogLine)
    this.state.lastPollAt = new Date().toISOString()
    this.state.lastError = undefined
    const reset = result.reset === true

    if (reset) {
      this.state.lines = []
      this.state.cursor = null
      this.emitLogsReset('cursor-invalid')
    }

    this.appendLines(nextLines)
    this.state.cursor = result.cursor
    return { appendedLines: nextLines, reset }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.state.initialized) {
      return
    }

    if (this.state.initializingPromise) {
      return this.state.initializingPromise
    }

    this.state.initializingPromise = (async () => {
      try {
        await this.loadSnapshot()
        this.state.initialized = true
      } catch (error) {
        this.state.lastError = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        this.state.initializingPromise = undefined
      }
    })()

    return this.state.initializingPromise
  }

  private async pollLogs(): Promise<void> {
    try {
      await this.ensureInitialized()
      const previousCursor = this.state.cursor ?? undefined
      const { appendedLines } = await this.loadSnapshot(previousCursor)
      if (appendedLines.length > 0) {
        this.emitLogsAppend(appendedLines)
      }
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  private stopPolling() {
    this.state.polling = false
    if (this.state.pollTimer) {
      clearInterval(this.state.pollTimer)
      this.state.pollTimer = undefined
    }
  }

  private startPolling() {
    if (this.state.polling) {
      return
    }

    this.state.polling = true
    void (async () => {
      const intervalMs = (await gatewayLogsClient.getResolvedConfig()).logsPollMs
      void this.pollLogs()
      this.state.pollTimer = setInterval(() => {
        void this.pollLogs()
      }, intervalMs)
    })()
  }
}

export const logsStreamCoordinator = new LogsStreamCoordinator()
