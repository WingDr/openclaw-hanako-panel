"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.browserWsHub = exports.BrowserWsHub = void 0;
class BrowserWsHub {
    constructor() {
        this.clients = new Set();
    }
    addClient(ws) {
        this.clients.add(ws);
    }
    removeClient(ws) {
        this.clients.delete(ws);
    }
    broadcast(message) {
        const payload = typeof message === 'string' ? message : JSON.stringify(message);
        for (const ws of Array.from(this.clients)) {
            try {
                ws.send(payload);
            }
            catch {
                // ignore and let caller cleanup on error
            }
        }
    }
}
exports.BrowserWsHub = BrowserWsHub;
// Export a singleton instance for simplicity
exports.browserWsHub = new BrowserWsHub();
