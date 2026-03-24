import type WebSocket from 'ws'
import { ChatSessionRegistry } from './ChatSessionRegistry'

export type GateResult = {
  ok: true
} | {
  ok: false
  code: string
  message: string
}

const ok = (): GateResult => ({ ok: true })

const fail = (code: string, message: string): GateResult => ({ ok: false, code, message })

export class ChatCommandGate {
  constructor(private readonly registry: ChatSessionRegistry) {}

  beforeSessionOpen(ws: WebSocket, sessionKey: string): GateResult {
    if (!sessionKey.trim()) {
      return fail('invalid_params', 'session.open requires sessionKey')
    }

    this.registry.subscribeSession(ws, sessionKey)
    return ok()
  }

  beforeChatSend(ws: WebSocket, sessionKey: string, message: string): GateResult {
    if (!sessionKey.trim() || !message.trim()) {
      return fail('invalid_params', 'chat.send requires sessionKey and message')
    }

    this.registry.subscribeSession(ws, sessionKey)

    if (this.registry.hasActiveRun(sessionKey)) {
      return fail('active_run_exists', `Session ${sessionKey} already has an active run`)
    }

    this.registry.setAwaitingStream(sessionKey)
    return ok()
  }

  onChatSendAck(sessionKey: string, runId?: string) {
    this.registry.setAwaitingStream(sessionKey)
    this.registry.bindRun(sessionKey, runId)
  }

  onChatSendFailure(sessionKey: string) {
    this.registry.setFailed(sessionKey)
    this.registry.clearRun(sessionKey)
  }

  beforeChatAbort(ws: WebSocket, params: { sessionKey?: string; runId?: string }): GateResult {
    const sessionKey = params.sessionKey?.trim()
    const runId = params.runId?.trim()

    if (!sessionKey && !runId) {
      return fail('invalid_params', 'chat.abort requires runId or sessionKey')
    }

    const resolvedSessionKey = sessionKey || (runId ? this.registry.resolveSessionByRunId(runId) : undefined)
    if (resolvedSessionKey) {
      this.registry.subscribeSession(ws, resolvedSessionKey)
      this.registry.setAborting(resolvedSessionKey, runId)
    }

    return ok()
  }

  onChatAbortAck(params: { sessionKey?: string; runId?: string }) {
    const sessionKey = params.sessionKey || (params.runId ? this.registry.resolveSessionByRunId(params.runId) : undefined)
    if (!sessionKey) {
      return
    }

    this.registry.setAborting(sessionKey, params.runId)
  }
}
