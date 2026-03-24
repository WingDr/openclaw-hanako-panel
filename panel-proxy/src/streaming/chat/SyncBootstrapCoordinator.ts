import type { Agent, ChatHistoryItem, Session } from '../../types'

type RuntimeSnapshot = {
  sessionKey: string
  lastSeq?: number
  watermark?: string
}

type SessionSnapshotResult = {
  sessionKey: string
  transcript: ChatHistoryItem[]
  lastSeq?: number
  watermark?: string
  error?: string
}

type CatalogSnapshotResult = {
  agents: Agent[]
  sessions: Session[]
}

const defaultSnapshotTimeoutMs = 8_000

const asErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
)

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    promise
      .then((value) => resolve(value))
      .catch((error) => reject(error))
      .finally(() => {
        clearTimeout(timeoutId)
      })
  })
}

export class SyncBootstrapCoordinator {
  private readonly sessionInFlight = new Map<string, Promise<SessionSnapshotResult>>()
  private catalogInFlight?: Promise<CatalogSnapshotResult>

  constructor(private readonly timeoutMs = defaultSnapshotTimeoutMs) {}

  async resolveCatalogSnapshot(
    includeCatalog: boolean,
    fetchCatalog: () => Promise<CatalogSnapshotResult>,
  ): Promise<CatalogSnapshotResult | undefined> {
    if (!includeCatalog) {
      return undefined
    }

    if (!this.catalogInFlight) {
      this.catalogInFlight = withTimeout(fetchCatalog(), this.timeoutMs, 'sync.bootstrap catalog')
        .finally(() => {
          this.catalogInFlight = undefined
        })
    }

    return this.catalogInFlight
  }

  async resolveSessionSnapshots(
    sessionKeys: string[],
    getRuntimeSnapshot: (sessionKey: string) => RuntimeSnapshot,
    fetchHistory: (sessionKey: string) => Promise<ChatHistoryItem[]>,
  ): Promise<SessionSnapshotResult[]> {
    return await Promise.all(
      sessionKeys.map(async (sessionKey) => {
        const runtime = getRuntimeSnapshot(sessionKey)

        if (!this.sessionInFlight.has(sessionKey)) {
          const inFlight = withTimeout(
            fetchHistory(sessionKey),
            this.timeoutMs,
            `sync.bootstrap session ${sessionKey}`,
          )
            .then((transcript) => ({
              sessionKey,
              transcript,
              lastSeq: runtime.lastSeq,
              watermark: runtime.watermark,
            } satisfies SessionSnapshotResult))
            .catch((error) => ({
              sessionKey,
              transcript: [],
              lastSeq: runtime.lastSeq,
              watermark: runtime.watermark,
              error: asErrorMessage(error),
            } satisfies SessionSnapshotResult))
            .finally(() => {
              this.sessionInFlight.delete(sessionKey)
            })

          this.sessionInFlight.set(sessionKey, inFlight)
        }

        return await this.sessionInFlight.get(sessionKey) as SessionSnapshotResult
      }),
    )
  }
}

export const syncBootstrapCoordinator = new SyncBootstrapCoordinator()
