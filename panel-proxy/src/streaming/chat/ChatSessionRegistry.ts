import type WebSocket from 'ws'

export type SessionRuntimePhase = 'idle' | 'awaiting_stream' | 'streaming' | 'aborting' | 'reconciling' | 'failed'

export type SessionRuntimeEntry = {
  sessionKey: string
  activeRunId?: string
  phase: SessionRuntimePhase
  lastSeq?: number
  watermark?: string
  lastEventAt?: string
}

const nowIso = (): string => new Date().toISOString()

export class ChatSessionRegistry {
  private runtimeBySession = new Map<string, SessionRuntimeEntry>()
  private subscriptionsByClient = new Map<WebSocket, Set<string>>()
  private runToSession = new Map<string, string>()

  registerClient(ws: WebSocket) {
    if (!this.subscriptionsByClient.has(ws)) {
      this.subscriptionsByClient.set(ws, new Set())
    }
  }

  unregisterClient(ws: WebSocket) {
    this.subscriptionsByClient.delete(ws)
  }

  getSubscribedSessions(ws: WebSocket): string[] {
    return [...(this.subscriptionsByClient.get(ws) ?? new Set<string>())]
  }

  subscribeSession(ws: WebSocket, sessionKey: string) {
    this.registerClient(ws)
    this.subscriptionsByClient.get(ws)?.add(sessionKey)
  }

  getSubscribedClients(sessionKey: string): WebSocket[] {
    const subscribers: WebSocket[] = []

    for (const [ws, sessions] of this.subscriptionsByClient.entries()) {
      if (sessions.has(sessionKey)) {
        subscribers.push(ws)
      }
    }

    return subscribers
  }

  hasSubscribers(sessionKey: string): boolean {
    for (const sessions of this.subscriptionsByClient.values()) {
      if (sessions.has(sessionKey)) {
        return true
      }
    }

    return false
  }

  getRuntime(sessionKey: string): SessionRuntimeEntry {
    const existing = this.runtimeBySession.get(sessionKey)
    if (existing) {
      return existing
    }

    const created: SessionRuntimeEntry = {
      sessionKey,
      phase: 'idle',
    }
    this.runtimeBySession.set(sessionKey, created)
    return created
  }

  setAwaitingStream(sessionKey: string) {
    const runtime = this.getRuntime(sessionKey)
    runtime.phase = 'awaiting_stream'
    runtime.lastEventAt = nowIso()
  }

  setStreaming(sessionKey: string, runId?: string, eventAt?: string) {
    const runtime = this.getRuntime(sessionKey)
    runtime.phase = 'streaming'
    runtime.lastEventAt = eventAt || nowIso()
    if (runId) {
      runtime.activeRunId = runId
      this.runToSession.set(runId, sessionKey)
    }
  }

  setAborting(sessionKey: string, runId?: string) {
    const runtime = this.getRuntime(sessionKey)
    runtime.phase = 'aborting'
    runtime.lastEventAt = nowIso()
    if (runId) {
      runtime.activeRunId = runId
      this.runToSession.set(runId, sessionKey)
    }
  }

  setFailed(sessionKey: string) {
    const runtime = this.getRuntime(sessionKey)
    runtime.phase = 'failed'
    runtime.lastEventAt = nowIso()
  }

  clearRun(sessionKey: string, runId?: string) {
    const runtime = this.getRuntime(sessionKey)
    if (runId && runtime.activeRunId && runtime.activeRunId !== runId) {
      return
    }

    if (runtime.activeRunId) {
      this.runToSession.delete(runtime.activeRunId)
    }

    runtime.activeRunId = undefined
    runtime.phase = 'idle'
    runtime.lastEventAt = nowIso()
  }

  markReconcile(sessionKey: string, eventAt?: string) {
    const runtime = this.getRuntime(sessionKey)
    runtime.phase = 'reconciling'
    runtime.lastEventAt = eventAt || nowIso()
  }

  bindRun(sessionKey: string, runId?: string) {
    if (!runId) {
      return
    }

    const runtime = this.getRuntime(sessionKey)
    runtime.activeRunId = runId
    this.runToSession.set(runId, sessionKey)
  }

  resolveSessionByRunId(runId: string): string | undefined {
    return this.runToSession.get(runId)
  }

  hasActiveRun(sessionKey: string): boolean {
    const runtime = this.runtimeBySession.get(sessionKey)
    if (!runtime) {
      return false
    }

    return Boolean(runtime.activeRunId) || ['awaiting_stream', 'streaming', 'aborting'].includes(runtime.phase)
  }

  bumpSessionSeq(sessionKey: string, eventAt?: string): { seq: number; watermark: string } {
    const runtime = this.getRuntime(sessionKey)
    const nextSeq = (runtime.lastSeq ?? 0) + 1
    const nextWatermark = `${sessionKey}:${nextSeq}`

    runtime.lastSeq = nextSeq
    runtime.watermark = nextWatermark
    runtime.lastEventAt = eventAt || nowIso()

    return {
      seq: nextSeq,
      watermark: nextWatermark,
    }
  }

  getRuntimeSnapshot(sessionKey: string): {
    sessionKey: string
    activeRunId?: string
    phase: SessionRuntimePhase
    lastSeq?: number
    watermark?: string
    lastEventAt?: string
  } {
    const runtime = this.getRuntime(sessionKey)
    return {
      sessionKey,
      activeRunId: runtime.activeRunId,
      phase: runtime.phase,
      lastSeq: runtime.lastSeq,
      watermark: runtime.watermark,
      lastEventAt: runtime.lastEventAt,
    }
  }
}
