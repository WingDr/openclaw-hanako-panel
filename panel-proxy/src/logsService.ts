import type WebSocket from 'ws'
import { EventEnvelope, LogLine } from './types'

let logs: LogLine[] = []
const subscribers = new Set<WebSocket>()

export function resetLogs() {
  logs = []
}

export function getLogsSnapshot(limit = 100): { cursor: number; lines: LogLine[] } {
  return { cursor: logs.length, lines: logs.slice(-limit) }
}

export function appendLog(entry: LogLine) {
  logs.push(entry)
  notifySubscribers(entry)
}

export function subscribeSubscriber(ws: WebSocket) {
  subscribers.add(ws)
  try {
    const envelope: EventEnvelope = { type: 'event', event: 'logs.init', topic: 'logs:gateway', payload: getLogsSnapshot() }
    ws.send(JSON.stringify(envelope))
  } catch {
  }
}

export function unsubscribeSubscriber(ws: WebSocket) {
  subscribers.delete(ws)
}

function notifySubscribers(entry: LogLine) {
  const envelope: EventEnvelope = { type: 'event', event: 'logs.update', topic: 'logs:gateway', payload: entry }
  for (const ws of subscribers) {
    try {
      ws.send(JSON.stringify(envelope))
    } catch {
    }
  }
}
