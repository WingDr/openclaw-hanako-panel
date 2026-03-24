"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureLogsInitialized = ensureLogsInitialized;
exports.getGatewayConnectionSnapshot = getGatewayConnectionSnapshot;
exports.getLogsStatus = getLogsStatus;
exports.getLogsSnapshot = getLogsSnapshot;
exports.subscribeSubscriber = subscribeSubscriber;
exports.unsubscribeSubscriber = unsubscribeSubscriber;
const browserWsHub_1 = require("./browserWsHub");
const gatewayClient_1 = require("./gatewayClient");
const maxBufferedLines = 1000;
const logsTopic = 'logs:gateway';
const state = {
    cursor: null,
    lines: [],
    subscribers: new Set(),
    polling: false,
    initialized: false,
};
gatewayClient_1.gatewayLogsClient.onConnectionChange((payload) => {
    const envelope = {
        type: 'event',
        event: 'system.connection',
        kind: 'system',
        topic: 'gateway',
        at: payload.at,
        payload,
    };
    browserWsHub_1.browserWsHub.broadcast(envelope);
});
function appendLines(lines) {
    if (lines.length === 0) {
        return;
    }
    state.lines.push(...lines);
    if (state.lines.length > maxBufferedLines) {
        state.lines.splice(0, state.lines.length - maxBufferedLines);
    }
}
function sendEvent(target, envelope) {
    try {
        target.send(JSON.stringify(envelope));
    }
    catch {
    }
}
function broadcastToSubscribers(envelope) {
    for (const subscriber of state.subscribers) {
        sendEvent(subscriber, envelope);
    }
}
function emitLogsReset(reason) {
    const payload = { reason };
    const envelope = {
        type: 'event',
        event: 'logs.reset',
        kind: 'logs',
        topic: logsTopic,
        at: new Date().toISOString(),
        payload,
    };
    broadcastToSubscribers(envelope);
}
function emitLogsAppend(lines) {
    const payload = {
        cursor: state.cursor ?? 0,
        lines,
    };
    const envelope = {
        type: 'event',
        event: 'logs.append',
        kind: 'logs',
        topic: logsTopic,
        at: new Date().toISOString(),
        payload,
    };
    broadcastToSubscribers(envelope);
}
async function loadSnapshot(cursor) {
    const config = await gatewayClient_1.gatewayLogsClient.getResolvedConfig();
    const result = await gatewayClient_1.gatewayLogsClient.logsTail({
        cursor,
        limit: config.logsLimit,
        maxBytes: config.logsMaxBytes,
    });
    const nextLines = result.lines.map(gatewayClient_1.parseGatewayLogLine);
    state.lastPollAt = new Date().toISOString();
    state.lastError = undefined;
    const reset = result.reset === true;
    if (reset) {
        state.lines = [];
        state.cursor = null;
        emitLogsReset('cursor-invalid');
    }
    appendLines(nextLines);
    state.cursor = result.cursor;
    return { appendedLines: nextLines, reset };
}
async function ensureLogsInitialized() {
    if (state.initialized) {
        return;
    }
    if (state.initializingPromise) {
        return state.initializingPromise;
    }
    state.initializingPromise = (async () => {
        try {
            await loadSnapshot();
            state.initialized = true;
        }
        catch (error) {
            state.lastError = error instanceof Error ? error.message : String(error);
            throw error;
        }
        finally {
            state.initializingPromise = undefined;
        }
    })();
    return state.initializingPromise;
}
async function pollLogs() {
    try {
        await ensureLogsInitialized();
        const previousCursor = state.cursor ?? undefined;
        const { appendedLines } = await loadSnapshot(previousCursor);
        if (appendedLines.length > 0) {
            emitLogsAppend(appendedLines);
        }
    }
    catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
    }
}
function stopPolling() {
    state.polling = false;
    if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = undefined;
    }
}
function startPolling() {
    if (state.polling) {
        return;
    }
    state.polling = true;
    void (async () => {
        const intervalMs = (await gatewayClient_1.gatewayLogsClient.getResolvedConfig()).logsPollMs;
        void pollLogs();
        state.pollTimer = setInterval(() => {
            void pollLogs();
        }, intervalMs);
    })();
}
function getGatewayConnectionSnapshot() {
    return gatewayClient_1.gatewayLogsClient.getConnectionSnapshot();
}
function getLogsStatus() {
    const liveTailAvailable = state.initialized && !state.lastError;
    return {
        polling: state.polling,
        initialized: state.initialized,
        lastError: state.lastError,
        lastPollAt: state.lastPollAt,
        connected: liveTailAvailable,
    };
}
async function getLogsSnapshot(limit = 100) {
    await ensureLogsInitialized();
    return {
        cursor: state.cursor ?? 0,
        lines: state.lines.slice(-limit),
    };
}
async function subscribeSubscriber(ws) {
    state.subscribers.add(ws);
    await ensureLogsInitialized();
    sendEvent(ws, {
        type: 'event',
        event: 'logs.reset',
        kind: 'logs',
        topic: logsTopic,
        at: new Date().toISOString(),
        payload: { reason: 'subscribed' },
    });
    sendEvent(ws, {
        type: 'event',
        event: 'logs.append',
        kind: 'logs',
        topic: logsTopic,
        at: new Date().toISOString(),
        payload: {
            cursor: state.cursor ?? 0,
            lines: state.lines,
        },
    });
    sendEvent(ws, {
        type: 'event',
        event: 'system.connection',
        kind: 'system',
        topic: 'gateway',
        at: gatewayClient_1.gatewayLogsClient.getConnectionSnapshot().at,
        payload: gatewayClient_1.gatewayLogsClient.getConnectionSnapshot(),
    });
    startPolling();
}
function unsubscribeSubscriber(ws) {
    state.subscribers.delete(ws);
    if (state.subscribers.size === 0) {
        stopPolling();
    }
}
