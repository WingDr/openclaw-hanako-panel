import type WebSocket from 'ws'
import { browserWsHub } from './browserWsHub'
import { gatewayLogsClient, parseGatewayLogLine } from './gatewayClient'
import { EventEnvelope, GatewayConnectionPayload, LogLine, LogsAppendPayload, LogsResetPayload, LogsSnapshot } from './types'

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

const state: LogsState = {
  cursor: null,
  lines: [],
  subscribers: new Set(),
  polling: false,
  initialized: false,
}

gatewayLogsClient.onConnectionChange((payload) => {
  const envelope: EventEnvelope = {
    type: 'event',
    event: 'system.connection',
    topic: 'gateway',
    payload,
  }
  browserWsHub.broadcast(envelope)
})

function appendLines(lines: LogLine[]) {
  if (lines.length === 0) {
    return
  }

  state.lines.push(...lines)
  if (state.lines.length > maxBufferedLines) {
    state.lines.splice(0, state.lines.length - maxBufferedLines)
  }
}

function sendEvent(target: WebSocket, envelope: EventEnvelope) {
  try {
    target.send(JSON.stringify(envelope))
  } catch {
  }
}

function broadcastToSubscribers(envelope: EventEnvelope) {
  for (const subscriber of state.subscribers) {
    sendEvent(subscriber, envelope)
  }
}

function emitLogsReset(reason: string) {
  const payload: LogsResetPayload = { reason }
  const envelope: EventEnvelope = {
    type: 'event',
    event: 'logs.reset',
    topic: logsTopic,
    payload,
  }
  broadcastToSubscribers(envelope)
}

function emitLogsAppend(lines: LogLine[]) {
  const payload: LogsAppendPayload = {
    cursor: state.cursor ?? 0,
    lines,
  }
  const envelope: EventEnvelope = {
    type: 'event',
    event: 'logs.append',
    topic: logsTopic,
    payload,
  }
  broadcastToSubscribers(envelope)
}

async function loadSnapshot(cursor?: number): Promise<{ appendedLines: LogLine[]; reset: boolean }> {
  const config = await gatewayLogsClient.getResolvedConfig()
  const result = await gatewayLogsClient.logsTail({
    cursor,
    limit: config.logsLimit,
    maxBytes: config.logsMaxBytes,
  })

  const nextLines = result.lines.map(parseGatewayLogLine)
  state.lastPollAt = new Date().toISOString()
  state.lastError = undefined
  const reset = result.reset === true

  if (reset) {
    state.lines = []
    state.cursor = null
    emitLogsReset('cursor-invalid')
  }

  appendLines(nextLines)
  state.cursor = result.cursor
  return { appendedLines: nextLines, reset }
}

export async function ensureLogsInitialized(): Promise<void> {
  if (state.initialized) {
    return
  }

  if (state.initializingPromise) {
    return state.initializingPromise
  }

  state.initializingPromise = (async () => {
    try {
      await loadSnapshot()
      state.initialized = true
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      state.initializingPromise = undefined
    }
  })()

  return state.initializingPromise
}

async function pollLogs(): Promise<void> {
  try {
    await ensureLogsInitialized()
    const previousCursor = state.cursor ?? undefined
    const { appendedLines } = await loadSnapshot(previousCursor)
    if (appendedLines.length > 0) {
      emitLogsAppend(appendedLines)
    }
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error)
  }
}

function stopPolling() {
  state.polling = false
  if (state.pollTimer) {
    clearInterval(state.pollTimer)
    state.pollTimer = undefined
  }
}

function startPolling() {
  if (state.polling) {
    return
  }

  state.polling = true
  void (async () => {
    const intervalMs = (await gatewayLogsClient.getResolvedConfig()).logsPollMs
    void pollLogs()
    state.pollTimer = setInterval(() => {
      void pollLogs()
    }, intervalMs)
  })()
}

export function getGatewayConnectionSnapshot(): GatewayConnectionPayload {
  return gatewayLogsClient.getConnectionSnapshot()
}

export function getLogsStatus() {
  const liveTailAvailable = state.initialized && !state.lastError
  return {
    polling: state.polling,
    initialized: state.initialized,
    lastError: state.lastError,
    lastPollAt: state.lastPollAt,
    connected: liveTailAvailable,
  }
}

export async function getLogsSnapshot(limit = 100): Promise<LogsSnapshot> {
  await ensureLogsInitialized()
  return {
    cursor: state.cursor ?? 0,
    lines: state.lines.slice(-limit),
  }
}

export async function subscribeSubscriber(ws: WebSocket): Promise<void> {
  state.subscribers.add(ws)
  await ensureLogsInitialized()

  sendEvent(ws, {
    type: 'event',
    event: 'logs.reset',
    topic: logsTopic,
    payload: { reason: 'subscribed' } satisfies LogsResetPayload,
  })

  sendEvent(ws, {
    type: 'event',
    event: 'logs.append',
    topic: logsTopic,
    payload: {
      cursor: state.cursor ?? 0,
      lines: state.lines,
    } satisfies LogsAppendPayload,
  })

  sendEvent(ws, {
    type: 'event',
    event: 'system.connection',
    topic: 'gateway',
    payload: gatewayLogsClient.getConnectionSnapshot(),
  })

  startPolling()
}

export function unsubscribeSubscriber(ws: WebSocket) {
  state.subscribers.delete(ws)
  if (state.subscribers.size === 0) {
    stopPolling()
  }
}
