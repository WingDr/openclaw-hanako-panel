// Lightweight WebSocket wrapper to be wired to panel-proxy later.
export type MessagePayload = unknown
export type MessageHandler = (payload: MessagePayload) => void

export class RealtimeClient {
  private ws?: WebSocket
  private onMessage?: MessageHandler

  constructor(private url: string) {}

  connect() {
    // In a mock environment, don't require real WS
    try {
    this.ws = new WebSocket(this.url)
      this.ws.onmessage = (ev) => {
        this.onMessage?.(JSON.parse(ev.data) as MessagePayload)
      }
    } catch {
      // fallback: no-op
    }
  }

  onPayload(cb: MessageHandler) {
    this.onMessage = cb
  }

  send(payload: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }
}

// Quick mock: expose a factory for tests to subscribe to fake messages
export function createMockRealtime(url: string = 'ws://localhost') {
  const client = new RealtimeClient(url)
  // no real connection; in test/mocking, you can trigger messages via setTimeout
  return client
}
