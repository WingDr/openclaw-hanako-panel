import type { EventEnvelope, RealtimeClient } from '../../../realtime/ws'

type ProxyChatHistoryItem = {
  messageId: string
  sessionKey: string
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'error'
  createdAt: string
  text?: string
  status?: 'complete' | 'error' | 'aborted'
  toolInvocation?: {
    toolName: string
    command?: string
    arguments?: string
    result?: string
    error?: string
    status: 'running' | 'done' | 'error'
  }
}

export type SyncBootstrapResult = {
  accepted?: boolean
  at?: string
  sessionSnapshots?: Array<{
    sessionKey?: string
    transcript?: ProxyChatHistoryItem[]
    lastSeq?: number
    watermark?: string
    error?: string
  }>
}

type SyncSessionsOptions = {
  silent?: boolean
  reason?: string
}

type SyncStateChange = {
  phase: 'start' | 'done' | 'error'
  sessionKey: string
  silent: boolean
  error?: string
}

type RealtimeLike = Pick<RealtimeClient, 'connect' | 'sendCommand' | 'subscribe'>

type ChatFlowConnectionLayerParams = {
  realtime: RealtimeLike
  getCurrentSessionKey: () => string
  applyEvent: (event: EventEnvelope) => void
  applySessionSnapshots: (sessionSnapshots: SyncBootstrapResult['sessionSnapshots']) => void
  onSyncStateChange?: (change: SyncStateChange) => void
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

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

const asString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
)

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

export class ChatFlowConnectionLayer {
  private unsubscribe?: () => void
  private readonly sessionSeqByKey = new Map<string, number>()
  private readonly syncingSessionKeys = new Set<string>()
  private readonly queuedSessionKeys = new Set<string>()
  private started = false

  constructor(private readonly params: ChatFlowConnectionLayerParams) {}

  start() {
    if (this.started) {
      return
    }

    this.started = true
    this.unsubscribe = this.params.realtime.subscribe((event) => {
      void this.handleEvent(event)
    })

    void this.params.realtime.connect().catch(() => {})
  }

  stop() {
    if (!this.started) {
      return
    }

    this.started = false
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = undefined
    }
  }

  async openSession(sessionKey: string): Promise<void> {
    const normalizedKey = sessionKey.trim()
    if (!normalizedKey) {
      return
    }

    await this.params.realtime.sendCommand('session.open', { sessionKey: normalizedKey })
  }

  async syncSessions(sessionKeys: string[], options?: SyncSessionsOptions): Promise<void> {
    const normalizedSessionKeys = [...new Set(
      sessionKeys
        .map((value) => value.trim())
        .filter(Boolean),
    )]

    if (normalizedSessionKeys.length === 0) {
      return
    }

    const targetSessionKeys: string[] = []
    for (const sessionKey of normalizedSessionKeys) {
      if (this.syncingSessionKeys.has(sessionKey)) {
        this.queuedSessionKeys.add(sessionKey)
        continue
      }

      this.syncingSessionKeys.add(sessionKey)
      targetSessionKeys.push(sessionKey)
    }

    if (targetSessionKeys.length === 0) {
      return
    }

    for (const sessionKey of targetSessionKeys) {
      this.params.onSyncStateChange?.({
        phase: 'start',
        sessionKey,
        silent: options?.silent === true,
      })
    }

    try {
      const response = await this.params.realtime.sendCommand<SyncBootstrapResult>('sync.bootstrap', {
        sessionKeys: targetSessionKeys,
        reason: options?.reason,
        includeCatalog: false,
      })

      this.params.applySessionSnapshots(response.result?.sessionSnapshots)
      this.updateSessionSequence(response.result?.sessionSnapshots)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to bootstrap session sync'
      for (const sessionKey of targetSessionKeys) {
        this.params.onSyncStateChange?.({
          phase: 'error',
          sessionKey,
          silent: options?.silent === true,
          error: message,
        })
      }
    } finally {
      for (const sessionKey of targetSessionKeys) {
        this.syncingSessionKeys.delete(sessionKey)
        this.params.onSyncStateChange?.({
          phase: 'done',
          sessionKey,
          silent: options?.silent === true,
        })

        if (this.queuedSessionKeys.has(sessionKey)) {
          this.queuedSessionKeys.delete(sessionKey)
          void this.syncSessions([sessionKey], {
            silent: true,
            reason: 'sync-coalesced',
          })
        }
      }
    }
  }

  private updateSessionSequence(sessionSnapshots: SyncBootstrapResult['sessionSnapshots']) {
    if (!Array.isArray(sessionSnapshots)) {
      return
    }

    for (const snapshot of sessionSnapshots) {
      const sessionKey = asString(snapshot?.sessionKey)
      const nextSeq = asFiniteNumber(snapshot?.lastSeq)
      if (!sessionKey || nextSeq === undefined) {
        continue
      }

      this.sessionSeqByKey.set(sessionKey, nextSeq)
    }
  }

  private async handleEvent(event: EventEnvelope): Promise<void> {
    const payload = asRecord(event.payload) ?? {}
    const sessionKey = event.sessionKey ?? asString(payload.sessionKey) ?? asString(payload.sessionId)
    const isCurrentSession = Boolean(sessionKey && sessionKey === this.params.getCurrentSessionKey())
    let shouldReconcileAfterApply = false

    if ((event.event === 'gateway.chat' || event.event === 'gateway.tool') && sessionKey) {
      const nextSeq = asFiniteNumber(payload.proxySessionSeq)
      if (nextSeq !== undefined) {
        const previousSeq = this.sessionSeqByKey.get(sessionKey)
        if (previousSeq !== undefined) {
          if (nextSeq <= previousSeq) {
            return
          }

          if (nextSeq > previousSeq + 1) {
            void this.syncSessions([sessionKey], {
              silent: sessionKey !== this.params.getCurrentSessionKey(),
              reason: 'sequence-gap',
            })
          }
        }

        this.sessionSeqByKey.set(sessionKey, nextSeq)
      }
    }

    if (event.event === 'gateway.chat' && sessionKey) {
      const phase = inferChatPhase(payload)
      shouldReconcileAfterApply = phase !== 'streaming'
    }

    if (event.event === 'chat.sync.required' && sessionKey) {
      void this.syncSessions([sessionKey], {
        silent: !isCurrentSession,
        reason: 'proxy-sync-required',
      })
    }

    if (event.event === 'system.connection' && payload.connected === true) {
      const currentSessionKey = this.params.getCurrentSessionKey().trim()
      if (currentSessionKey) {
        void this.syncSessions([currentSessionKey], {
          silent: true,
          reason: 'connection-restored',
        })
      }
    }

    this.params.applyEvent(event)

    if (shouldReconcileAfterApply && sessionKey) {
      void this.syncSessions([sessionKey], {
        silent: !isCurrentSession,
        reason: 'chat-terminal-reconcile',
      })
    }
  }
}
