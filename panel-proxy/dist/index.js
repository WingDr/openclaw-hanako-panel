"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const websocket_1 = __importDefault(require("@fastify/websocket"));
const gatewayClient_1 = require("./gatewayClient");
const logsService_1 = require("./logsService");
const browserWsHub_1 = require("./browserWsHub");
const statusService_1 = require("./statusService");
const defaultPort = 22846;
const parsePort = (...candidates) => {
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }
        const parsed = parseInt(candidate, 10);
        if (Number.isInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return defaultPort;
};
const port = parsePort(process.env.PANEL_PROXY_PORT, process.env.PORT);
const ack = (action, id, result) => ({
    id,
    type: 'ack',
    ok: true,
    action,
    result,
});
const ackError = (action, id, code, message) => ({
    id,
    type: 'ack',
    ok: false,
    action,
    error: { code, message },
});
const decodeWsMessage = (raw) => {
    if (typeof raw === 'string') {
        return raw;
    }
    if (Buffer.isBuffer(raw)) {
        return raw.toString();
    }
    if (raw instanceof ArrayBuffer) {
        return Buffer.from(raw).toString();
    }
    if (Array.isArray(raw)) {
        return Buffer.concat(raw.filter(Buffer.isBuffer)).toString();
    }
    return String(raw);
};
async function main() {
    const app = (0, fastify_1.default)({ logger: false });
    await app.register(websocket_1.default);
    app.addHook('onRequest', async (request, reply) => {
        const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '*';
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (request.method === 'OPTIONS') {
            reply.code(204);
            return reply.send();
        }
    });
    app.get('/api/bootstrap', async () => {
        const data = await (0, gatewayClient_1.bootstrap)();
        const response = { ok: true, data };
        return response;
    });
    app.get('/api/agents', async () => {
        const data = await (0, gatewayClient_1.fetchAgents)();
        const response = { ok: true, data };
        return response;
    });
    app.get('/api/agents/:agentId/sessions', async (req) => {
        const agentId = req.params.agentId;
        const data = await (0, gatewayClient_1.fetchAgentSessions)(agentId);
        const response = { ok: true, data };
        return response;
    });
    app.get('/api/chat/:sessionKey/history', async (req) => {
        const sessionKey = req.params.sessionKey;
        const data = await (0, gatewayClient_1.fetchChatHistory)(sessionKey);
        const response = { ok: true, data };
        return response;
    });
    app.get('/api/status', async () => {
        const logsStatus = (0, logsService_1.getLogsStatus)();
        let agents = [];
        let allSessions = [];
        let gatewayConnected = logsStatus.connected;
        let gatewayMessage = logsStatus.lastError || (logsStatus.connected ? 'Live tail available' : 'Logs tail unavailable');
        try {
            agents = await (0, gatewayClient_1.fetchAgents)();
            allSessions = await (0, gatewayClient_1.fetchSessions)();
            gatewayConnected = (0, logsService_1.getGatewayConnectionSnapshot)().connected || agents.length > 0;
        }
        catch (error) {
            gatewayConnected = (0, logsService_1.getGatewayConnectionSnapshot)().connected;
            gatewayMessage = error instanceof Error ? error.message : gatewayMessage;
        }
        const withGateway = (0, statusService_1.snapshotStatus)(agents, allSessions, {
            gatewayConnected,
            logsConnected: logsStatus.connected,
            lastUpdatedAt: logsStatus.lastPollAt || new Date().toISOString(),
            logsMessage: gatewayMessage,
        });
        const response = { ok: true, data: withGateway };
        return response;
    });
    app.get('/api/logs/snapshot', async () => {
        const data = await (0, logsService_1.getLogsSnapshot)(100);
        const response = { ok: true, data };
        return response;
    });
    app.get('/ws', { websocket: true }, (socket, _request) => {
        const ws = socket;
        browserWsHub_1.browserWsHub.addClient(ws);
        try {
            ws.send(JSON.stringify({
                type: 'event',
                event: 'system.connection',
                kind: 'system',
                topic: 'gateway',
                at: (0, logsService_1.getGatewayConnectionSnapshot)().at,
                payload: (0, logsService_1.getGatewayConnectionSnapshot)(),
            }));
        }
        catch {
        }
        ws.on('message', (raw) => {
            let message;
            try {
                message = JSON.parse(decodeWsMessage(raw));
            }
            catch {
                ws.send(JSON.stringify(ackError('chat.send', undefined, 'invalid_json', 'Invalid command envelope')));
                return;
            }
            void handleEnvelope(ws, message);
        });
        ws.on('close', () => {
            (0, logsService_1.unsubscribeSubscriber)(ws);
            browserWsHub_1.browserWsHub.removeClient(ws);
        });
    });
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`panel-proxy listening on http://0.0.0.0:${port}`);
}
async function handleEnvelope(ws, envelope) {
    switch (envelope.cmd) {
        case 'chat.send': {
            const message = typeof envelope.payload?.text === 'string'
                ? envelope.payload.text
                : typeof envelope.payload?.message === 'string'
                    ? envelope.payload.message
                    : '';
            const sessionKey = typeof envelope.payload?.sessionKey === 'string'
                ? envelope.payload.sessionKey
                : typeof envelope.payload?.sessionId === 'string'
                    ? envelope.payload.sessionId
                    : '';
            const idempotencyKey = typeof envelope.payload?.idempotencyKey === 'string'
                ? envelope.payload.idempotencyKey
                : undefined;
            if (!sessionKey || !message.trim()) {
                ws.send(JSON.stringify(ackError('chat.send', envelope.id, 'invalid_params', 'chat.send requires sessionKey and message')));
                break;
            }
            try {
                const result = await (0, gatewayClient_1.sendChatMessage)({ sessionKey, message, idempotencyKey });
                ws.send(JSON.stringify(ack('chat.send', envelope.id, result)));
            }
            catch (error) {
                ws.send(JSON.stringify(ackError('chat.send', envelope.id, 'gateway_error', error instanceof Error ? error.message : 'Failed to send chat message')));
            }
            break;
        }
        case 'chat.abort': {
            const runId = typeof envelope.payload?.runId === 'string' ? envelope.payload.runId : undefined;
            const sessionKey = typeof envelope.payload?.sessionKey === 'string'
                ? envelope.payload.sessionKey
                : typeof envelope.payload?.sessionId === 'string'
                    ? envelope.payload.sessionId
                    : undefined;
            if (!runId && !sessionKey) {
                ws.send(JSON.stringify(ackError('chat.abort', envelope.id, 'invalid_params', 'chat.abort requires runId or sessionKey')));
                break;
            }
            try {
                const result = await (0, gatewayClient_1.abortChatRun)({ runId, sessionKey });
                ws.send(JSON.stringify(ack('chat.abort', envelope.id, result)));
            }
            catch (error) {
                ws.send(JSON.stringify(ackError('chat.abort', envelope.id, 'gateway_error', error instanceof Error ? error.message : 'Failed to abort chat run')));
            }
            break;
        }
        case 'chat.inject': {
            ws.send(JSON.stringify(ackError('chat.inject', envelope.id, 'unsupported', 'chat.inject is not implemented yet')));
            break;
        }
        case 'session.create': {
            const agentId = typeof envelope.payload?.agentId === 'string' ? envelope.payload.agentId : 'main';
            const title = typeof envelope.payload?.title === 'string' ? envelope.payload.title : undefined;
            try {
                const result = await (0, gatewayClient_1.createPanelSession)(agentId, title);
                ws.send(JSON.stringify(ack('session.create', envelope.id, result)));
            }
            catch (error) {
                ws.send(JSON.stringify(ackError('session.create', envelope.id, 'gateway_error', error instanceof Error ? error.message : 'Failed to create session')));
            }
            break;
        }
        case 'session.open': {
            const sessionKey = typeof envelope.payload?.sessionKey === 'string'
                ? envelope.payload.sessionKey
                : typeof envelope.payload?.sessionId === 'string'
                    ? envelope.payload.sessionId
                    : '';
            if (!sessionKey) {
                ws.send(JSON.stringify(ackError('session.open', envelope.id, 'invalid_params', 'session.open requires sessionKey')));
                break;
            }
            ws.send(JSON.stringify(ack('session.open', envelope.id, { accepted: true, sessionKey })));
            break;
        }
        case 'logs.subscribe': {
            void (0, logsService_1.subscribeSubscriber)(ws)
                .then(() => {
                ws.send(JSON.stringify(ack('logs.subscribe', envelope.id, { accepted: true, topic: 'logs:gateway' })));
            })
                .catch((error) => {
                ws.send(JSON.stringify(ackError('logs.subscribe', envelope.id, 'gateway_error', error instanceof Error ? error.message : 'Failed to subscribe logs')));
            });
            return;
        }
        case 'logs.unsubscribe': {
            (0, logsService_1.unsubscribeSubscriber)(ws);
            ws.send(JSON.stringify(ack('logs.unsubscribe', envelope.id, { accepted: true })));
            break;
        }
        default:
            ws.send(JSON.stringify(ackError(envelope.cmd, envelope.id, 'unknown_command', 'Unknown command')));
    }
}
main().catch((err) => {
    console.error('panel-proxy failed to start', err);
    process.exit(1);
});
