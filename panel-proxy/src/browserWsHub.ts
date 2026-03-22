import type WebSocket from 'ws'

export class BrowserWsHub {
  private clients: Set<WebSocket> = new Set()

  addClient(ws: WebSocket) {
    this.clients.add(ws)
  }

  removeClient(ws: WebSocket) {
    this.clients.delete(ws)
  }

  broadcast(message: string | Record<string, unknown>) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message)
    for (const ws of Array.from(this.clients)) {
      try {
        ws.send(payload)
      } catch {
        // ignore and let caller cleanup on error
      }
    }
  }
}

// Export a singleton instance for simplicity
export const browserWsHub = new BrowserWsHub()
