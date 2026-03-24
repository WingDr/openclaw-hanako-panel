import type { ChatSession } from '../../api/client'
import { useChatStore } from '../../store'
import type { EventEnvelope } from '../../realtime/ws'

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

const asString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
)

const stringifyStructuredValue = (value: unknown): string | undefined => {
  const directValue = asString(value)
  if (directValue) {
    return directValue
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => stringifyStructuredValue(entry))
      .filter((entry): entry is string => Boolean(entry))
    return entries.length > 0 ? entries.join('\n') : undefined
  }

  const record = asRecord(value)
  if (!record) {
    return undefined
  }

  try {
    const serialized = JSON.stringify(record, null, 2)
    return serialized && serialized !== '{}' ? serialized : undefined
  } catch {
    return undefined
  }
}

const asFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  return undefined
}

const inferAgentIdFromSessionKey = (sessionKey: string): string | undefined => {
  const match = sessionKey.match(/^agent:([^:]+):/)
  return match?.[1]
}

const toChatSession = (payload: Record<string, unknown>): ChatSession | undefined => {
  const sessionKey = asString(payload.sessionKey) ?? asString(payload.sessionId)
  if (!sessionKey) {
    return undefined
  }

  const agentId = asString(payload.agentId) ?? inferAgentIdFromSessionKey(sessionKey)
  if (!agentId) {
    return undefined
  }

  const updatedAt = asString(payload.updatedAt) ?? new Date().toISOString()
  const name = asString(payload.preview) ?? asString(payload.title) ?? sessionKey
  const statusValue = asString(payload.status)

  return {
    id: sessionKey,
    agentId,
    name,
    updatedAt,
    status: statusValue === 'closed' ? 'closed' : statusValue === 'pending' ? 'pending' : 'opened',
  }
}

const hasCompletionSignal = (payload: Record<string, unknown>, lifecycle?: string): boolean => (
  payload.done === true
  || payload.complete === true
  || payload.completed === true
  || payload.final === true
  || payload.finished === true
  || ['done', 'completed', 'complete', 'finished', 'ok', 'final'].includes(lifecycle ?? '')
)

const inferChatPhase = (payload: Record<string, unknown>): 'streaming' | 'done' | 'error' | 'aborted' => {
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

const inferToolStatus = (payload: Record<string, unknown>): 'pending' | 'running' | 'done' | 'error' => {
  const gatewayEvent = asString(payload.gatewayEvent)?.toLowerCase() ?? ''
  const lifecycle = asString(payload.phase ?? payload.status ?? payload.state ?? payload.event)?.toLowerCase()

  if (payload.error || gatewayEvent.includes('error') || ['error', 'failed', 'failure'].includes(lifecycle ?? '')) {
    return 'error'
  }

  if (
    gatewayEvent.includes('.done')
    || gatewayEvent.includes('.complete')
    || gatewayEvent.includes('.finished')
    || ['done', 'completed', 'complete', 'finished', 'ok'].includes(lifecycle ?? '')
  ) {
    return 'done'
  }

  if (
    gatewayEvent.includes('.started')
    || gatewayEvent.includes('.start')
    || ['started', 'start', 'created', 'invoked', 'running', 'active'].includes(lifecycle ?? '')
  ) {
    return 'running'
  }

  return 'running'
}

const normalizeToolStatusFromChatPhase = (
  chatPhase: 'streaming' | 'done' | 'error' | 'aborted',
  fallback: 'pending' | 'running' | 'done' | 'error',
): 'pending' | 'running' | 'done' | 'error' => {
  if (chatPhase === 'error' || chatPhase === 'aborted') {
    return 'error'
  }

  if (chatPhase === 'done') {
    return 'done'
  }

  return fallback
}

type ToolPatch = {
  toolCallId?: string
  toolName: string
  command?: string
  argumentsText?: string
  result?: string
  error?: string
  status: 'pending' | 'running' | 'done' | 'error'
}

const extractToolPatch = (
  payload: Record<string, unknown>,
  options?: { chatPhase?: 'streaming' | 'done' | 'error' | 'aborted' },
): ToolPatch | undefined => {
  const toolCallId = asString(payload.toolCallId) ?? asString(payload.toolId) ?? asString(payload.callId)
  const toolNameRaw = asString(payload.toolName) ?? asString(payload.tool) ?? asString(payload.name)
  const command = stringifyStructuredValue(payload.toolCommand)
    ?? stringifyStructuredValue(payload.command)
    ?? stringifyStructuredValue(payload.cmd)
  const argumentsText = stringifyStructuredValue(payload.toolArguments)
    ?? stringifyStructuredValue(payload.arguments)
    ?? stringifyStructuredValue(payload.args)
  const result = stringifyStructuredValue(payload.toolResult)
    ?? stringifyStructuredValue(payload.result)
    ?? stringifyStructuredValue(payload.output)
  const error = asString(payload.errorMessage) ?? asString(asRecord(payload.error)?.message)
  const gatewayEvent = asString(payload.gatewayEvent)?.toLowerCase() ?? ''
  const lifecycle = asString(payload.phase ?? payload.status ?? payload.state ?? payload.event)?.toLowerCase() ?? ''

  const hasToolSignal = Boolean(
    toolCallId
    || toolNameRaw
    || command
    || argumentsText
    || result
    || gatewayEvent.includes('tool')
    || gatewayEvent.includes('function')
    || lifecycle.includes('tool')
    || lifecycle.includes('function')
  )

  if (!hasToolSignal) {
    return undefined
  }

  const inferredStatus = inferToolStatus(payload)
  const status = options?.chatPhase
    ? normalizeToolStatusFromChatPhase(options.chatPhase, inferredStatus)
    : inferredStatus

  const stableResult = status === 'running'
    ? undefined
    : result

  return {
    toolCallId,
    toolName: toolNameRaw ?? 'Tool',
    command,
    argumentsText,
    result: stableResult,
    error,
    status,
  }
}

const upsertToolPatch = (
  sessionKey: string,
  nodeId: string | undefined,
  nodeOrder: number | undefined,
  runId: string | undefined,
  updatedAt: string,
  seq: number | undefined,
  patch: ToolPatch,
) => {
  const store = useChatStore.getState()
  store.upsertToolInvocation(sessionKey, {
    id: patch.toolCallId ? `tool:${sessionKey}:${patch.toolCallId}` : `tool:${sessionKey}:${patch.toolName}:${updatedAt}`,
    nodeId,
    nodeOrder,
    runId,
    toolCallId: patch.toolCallId,
    toolName: patch.toolName,
    command: patch.command,
    arguments: patch.argumentsText,
    result: patch.result,
    status: patch.status,
    error: patch.error,
    createdAt: updatedAt,
    updatedAt,
    seq,
  })
}

const mergeStreamingText = (
  currentText: string,
  payload: Record<string, unknown>,
): string => {
  const fullText = asString(payload.fullText) ?? asString(payload.text) ?? asString(payload.message)
  const deltaText = asString(payload.delta)

  if (fullText) {
    if (!currentText) {
      return fullText
    }

    if (fullText === currentText) {
      return currentText
    }

    if (fullText.length >= currentText.length && fullText.startsWith(currentText)) {
      return fullText
    }

    if (currentText.length > fullText.length && currentText.includes(fullText)) {
      return currentText
    }

    return fullText
  }

  if (!deltaText) {
    return currentText
  }

  if (!currentText) {
    return deltaText
  }

  if (currentText.endsWith(deltaText)) {
    return currentText
  }

  return `${currentText}${deltaText}`
}

const resolveRunOwnership = (
  sessionKey: string,
): { liveRunId?: string; pendingAcceptedRunId?: string } => {
  const store = useChatStore.getState()
  const liveSegments = store.liveChatBySession[sessionKey] ?? []
  const pendingAcceptedRunId = (store.pendingComposerBySession[sessionKey] ?? [])
    .find((message) => message.status === 'accepted' && message.runId)
    ?.runId

  return {
    liveRunId: liveSegments[liveSegments.length - 1]?.runId,
    pendingAcceptedRunId,
  }
}

const shouldIgnoreRunMismatchedEvent = (
  sessionKey: string,
  incomingRunId?: string,
): boolean => {
  if (!incomingRunId) {
    return false
  }

  const ownership = resolveRunOwnership(sessionKey)

  // Once we already entered live streaming for a run, reject late events from other runs.
  if (ownership.liveRunId) {
    return ownership.liveRunId !== incomingRunId
  }

  // Before streaming starts, ack runId may be absent or non-authoritative; accept the first stream run.
  return false
}

export function applyChatFlowEvent(event: EventEnvelope) {
  const payload = asRecord(event.payload)
  if (!payload) {
    return
  }

  const store = useChatStore.getState()
  const sessionKey = event.sessionKey ?? asString(payload.sessionKey) ?? asString(payload.sessionId)
  const runId = event.runId ?? asString(payload.runId)
  const updatedAt = event.at ?? asString(payload.updatedAt) ?? new Date().toISOString()
  const eventSeq = asFiniteNumber(payload.proxySessionSeq)
  const proxyNodeId = asString(payload.proxyNodeId)
  const proxyNodeOrder = asFiniteNumber(payload.proxyNodeOrder)
  const proxyNodeKind = asString(payload.proxyNodeKind)

  if (event.event === 'system.connection') {
    const connected = payload.connected === true
    if (!connected) {
      const message = asString(payload.message) ?? 'Gateway disconnected'
      store.failAllLiveChats(message)
    }
    return
  }

  if (event.event === 'gateway.session') {
    const session = toChatSession(payload)
    if (session) {
      store.touchAgentSession(session)
    }
    return
  }

  if (!sessionKey) {
    return
  }

  if (event.event === 'gateway.chat') {
    const phase = inferChatPhase(payload)

    if (shouldIgnoreRunMismatchedEvent(sessionKey, runId)) {
      return
    }

    const liveSegments = store.liveChatBySession[sessionKey] ?? []
    const currentSegment = proxyNodeId
      ? liveSegments.find((segment) => segment.nodeId === proxyNodeId)
      : liveSegments[liveSegments.length - 1]
    const currentLiveText = currentSegment?.text ?? ''
    const nextText = mergeStreamingText(currentLiveText, payload)

    store.markSessionOpened(sessionKey, updatedAt)

    if (phase === 'error') {
      const errorMessage = asString(payload.errorMessage)
        ?? asString(asRecord(payload.error)?.message)
        ?? 'Generation failed'
      store.failLiveChat(sessionKey, { runId, error: errorMessage, updatedAt })
      return
    }

    if (phase === 'aborted') {
      const errorMessage = asString(payload.errorMessage)
        ?? asString(asRecord(payload.error)?.message)
        ?? 'Stopped'
      store.failLiveChat(sessionKey, { runId, error: errorMessage, aborted: true, updatedAt })
      return
    }

    if (phase === 'done') {
      store.commitLiveChat(sessionKey, {
        runId,
        text: nextText,
        updatedAt,
        messageId: asString(payload.messageId) ?? asString(payload.finalMessageId),
      })
      return
    }

    store.setLiveChat(sessionKey, {
      nodeId: proxyNodeId,
      nodeOrder: proxyNodeOrder,
      runId,
      text: nextText,
      updatedAt,
      startedAt: asString(payload.startedAt) ?? updatedAt,
      seq: eventSeq,
    })
    return
  }

  if (event.event === 'gateway.tool') {
    if (shouldIgnoreRunMismatchedEvent(sessionKey, runId)) {
      return
    }

    const toolPatch = extractToolPatch(payload)
    if (!toolPatch) {
      return
    }

    if (!toolPatch.result && toolPatch.status !== 'running') {
      toolPatch.result = asString(payload.text)
    }

    store.markSessionOpened(sessionKey, updatedAt)
    if (proxyNodeKind && proxyNodeKind !== 'tool') {
      return
    }

    upsertToolPatch(
      sessionKey,
      proxyNodeId,
      proxyNodeOrder,
      runId,
      asString(payload.createdAt) ?? updatedAt,
      eventSeq,
      toolPatch,
    )
  }
}
