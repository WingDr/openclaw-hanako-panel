"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetLogs = resetLogs;
exports.getLogsSnapshot = getLogsSnapshot;
exports.appendLog = appendLog;
exports.subscribeSubscriber = subscribeSubscriber;
exports.unsubscribeSubscriber = unsubscribeSubscriber;
let logs = [];
const subscribers = new Set();
function resetLogs() {
    logs = [];
}
function getLogsSnapshot(limit = 100) {
    return { cursor: logs.length, lines: logs.slice(-limit) };
}
function appendLog(entry) {
    logs.push(entry);
    notifySubscribers(entry);
}
function subscribeSubscriber(ws) {
    subscribers.add(ws);
    try {
        const envelope = { type: 'event', event: 'logs.init', topic: 'logs:gateway', payload: getLogsSnapshot() };
        ws.send(JSON.stringify(envelope));
    }
    catch {
    }
}
function unsubscribeSubscriber(ws) {
    subscribers.delete(ws);
}
function notifySubscribers(entry) {
    const envelope = { type: 'event', event: 'logs.update', topic: 'logs:gateway', payload: entry };
    for (const ws of subscribers) {
        try {
            ws.send(JSON.stringify(envelope));
        }
        catch {
        }
    }
}
