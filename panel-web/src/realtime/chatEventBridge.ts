import type { ChatSession } from '../api/client'
import { useChatStore } from '../store'
import type { EventEnvelope } from './ws'

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

const asString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
)

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

export function handleChatRealtimeEvent(event: EventEnvelope) {
  const payload = asRecord(event.payload)
  if (!payload) {
    return
  }

  const store = useChatStore.getState()
  const sessionKey = event.sessionKey ?? asString(payload.sessionKey) ?? asString(payload.sessionId)
  const runId = event.runId ?? asString(payload.runId)
  const updatedAt = event.at ?? asString(payload.updatedAt) ?? new Date().toISOString()

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
    const currentLiveText = store.liveChatBySession[sessionKey]?.text ?? ''
    const nextText = mergeStreamingText(currentLiveText, payload)
    const phase = inferChatPhase(payload)

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
      runId,
      text: nextText,
      updatedAt,
      startedAt: asString(payload.startedAt) ?? updatedAt,
    })
    return
  }

  if (event.event === 'gateway.tool') {
    const toolCallId = asString(payload.toolCallId) ?? asString(payload.toolId) ?? asString(payload.callId)
    const toolName = asString(payload.toolName) ?? asString(payload.tool) ?? asString(payload.name) ?? 'Tool'
    const result = asString(payload.toolResult) ?? asString(payload.result) ?? asString(payload.output) ?? asString(payload.text)
    const command = asString(payload.toolCommand) ?? asString(payload.command) ?? asString(payload.cmd)
    const argumentsText = asString(payload.toolArguments) ?? asString(payload.arguments) ?? asString(payload.args)
    const status = inferToolStatus(payload)
    const error = asString(payload.errorMessage) ?? asString(asRecord(payload.error)?.message)

    store.markSessionOpened(sessionKey, updatedAt)
    store.upsertToolInvocation(sessionKey, {
      id: toolCallId ? `tool:${sessionKey}:${toolCallId}` : `tool:${sessionKey}:${toolName}:${updatedAt}`,
      runId,
      toolCallId,
      toolName,
      command,
      arguments: argumentsText,
      result,
      status,
      error,
      createdAt: asString(payload.createdAt) ?? updatedAt,
      updatedAt,
    })
  }
}
