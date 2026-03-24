import type WebSocket from 'ws'
import type { EventEnvelope } from '../../types'
import { ChatCommandGate, type GateResult } from './ChatCommandGate'
import { ChatSessionRegistry } from './ChatSessionRegistry'

type GatewayChatEvent = {
  type: 'event'
  event: 'gateway.chat' | 'gateway.tool' | 'gateway.session'
  kind: 'chat' | 'tool' | 'session'
  topic?: string
  at?: string
  sessionKey?: string
  runId?: string
  payload: Record<string, unknown>
}

type ChatPhase = 'streaming' | 'done' | 'error' | 'aborted'
type RuntimeNodeKind = 'assistant' | 'tool'
type SessionNodeState = {
  nextOrder: number
  nextAssistantSegment: number
  activeAssistantNodeId?: string
  nodeOrderById: Map<string, number>
  toolNodeByCallId: Map<string, string>
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

const asString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
)

const extractToolCallId = (payload: Record<string, unknown>): string | undefined => (
  asString(payload.toolCallId)
  ?? asString(payload.toolId)
  ?? asString(payload.callId)
  ?? asString((asRecord(payload.invocation) ?? {}).toolCallId)
  ?? asString((asRecord(payload.request) ?? {}).toolCallId)
)

const hasCompletionSignal = (payload: Record<string, unknown>, lifecycle?: string): boolean => (
  payload.done === true
  || payload.complete === true
  || payload.completed === true
  || payload.final === true
  || payload.finished === true
  || ['done', 'completed', 'complete', 'finished', 'ok', 'final'].includes(lifecycle ?? '')
)

const inferChatPhase = (payload: Record<string, unknown>): ChatPhase => {
  const gatewayEvent = asString(payload.gatewayEvent)?.toLowerCase() ?? ''
  const lifecycle = asString(payload.phase ?? payload.status ?? payload.state ?? payload.kind ?? payload.type)?.toLowerCase()

  if (payload.error || gatewayEvent.includes('error') || ['error', 'failed', 'failure'].includes(lifecycle ?? '')) {
    return 'error'
  }

  if (
    payload.aborted === true
    || gatewayEvent.includes('aborted')
    || gatewayEvent.includes('cancel')
    || gatewayEvent.includes('stopped')
    || ['aborted', 'cancelled', 'canceled', 'stopped'].includes(lifecycle ?? '')
  ) {
    return 'aborted'
  }

  if (
    gatewayEvent.includes('.done')
    || gatewayEvent.includes('.complete')
    || gatewayEvent.includes('.finished')
    || hasCompletionSignal(payload, lifecycle)
  ) {
    return 'done'
  }

  return 'streaming'
}

export class ChatStreamCoordinator {
  private readonly clients = new Set<WebSocket>()
  private readonly registry = new ChatSessionRegistry()
  private readonly gate = new ChatCommandGate(this.registry)
  private proxySeq = 0
  private readonly nodeStateBySession = new Map<string, SessionNodeState>()

  registerClient(ws: WebSocket) {
    this.clients.add(ws)
    this.registry.registerClient(ws)
  }

  unregisterClient(ws: WebSocket) {
    this.clients.delete(ws)
    this.registry.unregisterClient(ws)
  }

  getSubscribedSessions(ws: WebSocket): string[] {
    return this.registry.getSubscribedSessions(ws)
  }

  getSessionRuntimeSnapshot(sessionKey: string) {
    return this.registry.getRuntimeSnapshot(sessionKey)
  }

  handleSessionOpen(ws: WebSocket, sessionKey: string): GateResult {
    return this.gate.beforeSessionOpen(ws, sessionKey)
  }

  beforeChatSend(ws: WebSocket, sessionKey: string, message: string): GateResult {
    return this.gate.beforeChatSend(ws, sessionKey, message)
  }

  afterChatSendAck(sessionKey: string, runId?: string) {
    this.gate.onChatSendAck(sessionKey, runId)
  }

  afterChatSendFailure(sessionKey: string) {
    this.gate.onChatSendFailure(sessionKey)
  }

  beforeChatAbort(ws: WebSocket, params: { sessionKey?: string; runId?: string }): GateResult {
    return this.gate.beforeChatAbort(ws, params)
  }

  afterChatAbortAck(params: { sessionKey?: string; runId?: string }) {
    this.gate.onChatAbortAck(params)
  }

  emitSyncRequired(sessionKey: string, reason: string, details?: Record<string, unknown>) {
    const envelope: EventEnvelope = {
      type: 'event',
      event: 'chat.sync.required',
      kind: 'sync',
      topic: `session:${sessionKey}`,
      at: new Date().toISOString(),
      sessionKey,
      payload: {
        reason,
        ...(details ?? {}),
      },
    }

    if (this.registry.hasSubscribers(sessionKey)) {
      this.broadcastToSubscribers(sessionKey, envelope)
      return
    }

    this.broadcastToAll(envelope)
  }

  handleGatewayEvent(event: GatewayChatEvent) {
    const payload = asRecord(event.payload) ?? {}
    const eventAt = event.at ?? new Date().toISOString()
    const runId = event.runId ?? asString(payload.runId)
    const sessionKey = event.sessionKey
      ?? asString(payload.sessionKey)
      ?? asString(payload.sessionId)
      ?? (runId ? this.registry.resolveSessionByRunId(runId) : undefined)
    const proxySeq = ++this.proxySeq

    const envelope: EventEnvelope = {
      ...event,
      at: eventAt,
      sessionKey,
      runId,
      payload,
    }

    if (event.event === 'gateway.session') {
      this.broadcastToAll(envelope)
      return
    }

    if (!sessionKey) {
      envelope.payload = {
        ...payload,
        proxySeq,
      }
      this.broadcastToAll(envelope)
      return
    }

    const sessionSequence = this.registry.bumpSessionSeq(sessionKey, eventAt)
    const runtimeBeforeEvent = this.registry.getRuntimeSnapshot(sessionKey)
    const phase = event.event === 'gateway.chat' ? inferChatPhase(payload) : undefined
    const nodeMeta = this.resolveNodeMeta({
      event,
      payload,
      sessionKey,
      runId,
      eventAt,
      phase,
    })
    envelope.payload = {
      ...payload,
      proxySeq,
      proxySessionSeq: sessionSequence.seq,
      proxyWatermark: sessionSequence.watermark,
      ...(nodeMeta ? {
        proxyNodeId: nodeMeta.nodeId,
        proxyNodeKind: nodeMeta.nodeKind,
        proxyNodeOrder: nodeMeta.nodeOrder,
      } : {}),
    }

    if (event.event === 'gateway.chat') {
      if (
        phase !== 'streaming'
        && runtimeBeforeEvent.activeRunId
        && runId
        && runtimeBeforeEvent.activeRunId !== runId
      ) {
        this.emitSyncRequired(sessionKey, 'terminal-run-mismatch', {
          activeRunId: runtimeBeforeEvent.activeRunId,
          receivedRunId: runId,
        })
      }

      if (phase === 'streaming') {
        this.registry.setStreaming(sessionKey, runId, eventAt)
      } else {
        this.registry.markReconcile(sessionKey, eventAt)
        this.registry.clearRun(sessionKey, runId)
      }
    }

    if (event.event === 'gateway.tool') {
      if (
        runtimeBeforeEvent.activeRunId
        && runId
        && runtimeBeforeEvent.activeRunId !== runId
      ) {
        this.emitSyncRequired(sessionKey, 'tool-run-mismatch', {
          activeRunId: runtimeBeforeEvent.activeRunId,
          receivedRunId: runId,
        })
      }

      this.registry.bindRun(sessionKey, runId)
      this.registry.setStreaming(sessionKey, runId, eventAt)
    }

    if (!this.registry.hasSubscribers(sessionKey)) {
      this.broadcastToAll(envelope)
      return
    }

    this.broadcastToSubscribers(sessionKey, envelope)
  }

  private broadcastToSubscribers(sessionKey: string, envelope: EventEnvelope) {
    const payload = JSON.stringify(envelope)
    const subscribers = this.registry.getSubscribedClients(sessionKey)
    for (const ws of subscribers) {
      if (!this.clients.has(ws)) {
        continue
      }

      this.send(ws, payload)
    }
  }

  private broadcastToAll(envelope: EventEnvelope) {
    const payload = JSON.stringify(envelope)
    for (const ws of this.clients) {
      this.send(ws, payload)
    }
  }

  private send(ws: WebSocket, payload: string) {
    try {
      ws.send(payload)
    } catch {
      this.unregisterClient(ws)
    }
  }

  private getNodeState(sessionKey: string): SessionNodeState {
    const existing = this.nodeStateBySession.get(sessionKey)
    if (existing) {
      return existing
    }

    const created: SessionNodeState = {
      nextOrder: 1,
      nextAssistantSegment: 1,
      nodeOrderById: new Map(),
      toolNodeByCallId: new Map(),
    }
    this.nodeStateBySession.set(sessionKey, created)
    return created
  }

  private ensureNodeOrder(state: SessionNodeState, nodeId: string): number {
    const existing = state.nodeOrderById.get(nodeId)
    if (existing !== undefined) {
      return existing
    }

    const created = state.nextOrder
    state.nextOrder += 1
    state.nodeOrderById.set(nodeId, created)
    return created
  }

  private resolveNodeMeta(params: {
    event: GatewayChatEvent
    payload: Record<string, unknown>
    sessionKey: string
    runId?: string
    eventAt: string
    phase?: ChatPhase
  }): { nodeId: string; nodeKind: RuntimeNodeKind; nodeOrder: number } | undefined {
    const state = this.getNodeState(params.sessionKey)

    if (params.event.event === 'gateway.chat') {
      const chatPhase = params.phase ?? 'streaming'
      if (!state.activeAssistantNodeId) {
        state.activeAssistantNodeId = `assistant:${params.runId ?? params.sessionKey}:${state.nextAssistantSegment}`
        state.nextAssistantSegment += 1
      }

      const nodeId = state.activeAssistantNodeId
      const nodeOrder = this.ensureNodeOrder(state, nodeId)

      if (chatPhase !== 'streaming') {
        state.activeAssistantNodeId = undefined
      }

      return {
        nodeId,
        nodeKind: 'assistant',
        nodeOrder,
      }
    }

    if (params.event.event !== 'gateway.tool') {
      return undefined
    }

    const toolCallId = extractToolCallId(params.payload)
    let nodeId = toolCallId ? state.toolNodeByCallId.get(toolCallId) : undefined
    if (!nodeId) {
      nodeId = `tool:${toolCallId ?? params.runId ?? params.eventAt}:${state.nextOrder}`
      if (toolCallId) {
        state.toolNodeByCallId.set(toolCallId, nodeId)
      }
    }

    const nodeOrder = this.ensureNodeOrder(state, nodeId)
    state.activeAssistantNodeId = undefined
    return {
      nodeId,
      nodeKind: 'tool',
      nodeOrder,
    }
  }
}

export const chatStreamCoordinator = new ChatStreamCoordinator()
