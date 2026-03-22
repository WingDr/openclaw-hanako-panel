"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrap = bootstrap;
exports.fetchAgents = fetchAgents;
exports.fetchAgentSessions = fetchAgentSessions;
exports.fetchStatus = fetchStatus;
exports.fetchLogsSnapshot = fetchLogsSnapshot;
exports.appendLog = appendLog;
exports.addSession = addSession;
const mockAgents = [
    { agentId: 'main', label: 'Main', status: 'online', capabilities: ['chat', 'session'] },
    { agentId: 'research', label: 'Research', status: 'online', capabilities: ['chat'] },
    { agentId: 'design', label: 'Design', status: 'idle', capabilities: ['session'] },
];
let mockSessions = [
    { sessionKey: 'agent:main:panel:daily-review', agentId: 'main', updatedAt: new Date().toISOString(), preview: 'Continue panel review', status: 'opened' },
    { sessionKey: 'agent:main:panel:debug-stream', agentId: 'main', updatedAt: new Date().toISOString(), preview: 'Check live events', status: 'pending' },
    { sessionKey: 'agent:research:panel:notes', agentId: 'research', updatedAt: new Date().toISOString(), preview: 'Research notes thread', status: 'opened' },
];
let mockLogs = [
    { ts: new Date().toISOString(), level: 'info', text: 'Gateway initialized' },
    { ts: new Date().toISOString(), level: 'info', text: 'Agents discovered' },
];
let logCursor = mockLogs.length;
async function bootstrap() {
    return {
        proxyVersion: '0.1.0',
        gateway: { connected: true, mode: 'proxy' },
        defaultAgentId: 'main',
        features: { chat: true, logs: true, status: true },
    };
}
async function fetchAgents() {
    return mockAgents;
}
async function fetchAgentSessions(agentId) {
    return mockSessions.filter((s) => s.agentId === agentId);
}
async function fetchStatus() {
    const recent = mockSessions.slice().sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1)).slice(0, 3);
    return {
        gateway: {
            connected: true,
            lastUpdatedAt: new Date().toISOString(),
        },
        agents: mockAgents,
        channels: [
            { channelKey: 'gateway', status: 'connected', summary: 'Primary control link' },
            { channelKey: 'logs', status: 'connected', summary: 'Live tail available' },
        ],
        recentSessions: recent,
    };
}
async function fetchLogsSnapshot() {
    return { cursor: logCursor, lines: mockLogs.slice(-50) };
}
function appendLog(message, level = 'info') {
    const entry = { ts: new Date().toISOString(), level, text: message };
    mockLogs.push(entry);
    logCursor += 1;
    return entry;
}
function addSession(agentId, slug, status = 'pending') {
    const sess = {
        sessionKey: `agent:${agentId}:panel:${slug}`,
        agentId,
        updatedAt: new Date().toISOString(),
        preview: 'New panel session',
        status,
    };
    mockSessions.push(sess);
    return sess;
}
