"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const websocket_1 = __importDefault(require("@fastify/websocket"));
const gatewayClient_1 = require("./gatewayClient");
const logsService_1 = require("./logsService");
const logsService_2 = require("./logsService");
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
    app.get('/api/status', async () => {
        const agents = await (0, gatewayClient_1.fetchAgents)();
        const allSessions = [];
        for (const a of agents) {
            const s = await (0, gatewayClient_1.fetchAgentSessions)(a.agentId);
            allSessions.push(...s);
        }
        const data = (0, statusService_1.snapshotStatus)(agents, allSessions);
        const response = { ok: true, data };
        return response;
    });
    app.get('/api/logs/snapshot', async () => {
        const data = (0, logsService_1.getLogsSnapshot)(100);
        const response = { ok: true, data };
        return response;
    });
    app.get('/ws', { websocket: true }, (socket, _request) => {
        const ws = socket;
        browserWsHub_1.browserWsHub.addClient(ws);
        ws.on('message', (raw) => {
            let message;
            try {
                message = JSON.parse(decodeWsMessage(raw));
            }
            catch {
                ws.send(JSON.stringify(ackError('chat.send', undefined, 'invalid_json', 'Invalid command envelope')));
                return;
            }
            handleEnvelope(ws, message);
        });
        ws.on('close', () => {
            (0, logsService_2.unsubscribeSubscriber)(ws);
            browserWsHub_1.browserWsHub.removeClient(ws);
        });
    });
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`panel-proxy listening on http://0.0.0.0:${port}`);
}
function handleEnvelope(ws, envelope) {
    switch (envelope.cmd) {
        case 'chat.send': {
            const text = typeof envelope.payload?.text === 'string'
                ? envelope.payload.text
                : typeof envelope.payload?.message === 'string'
                    ? envelope.payload.message
                    : '';
            (0, logsService_2.appendLog)({ ts: new Date().toISOString(), level: 'info', text: `chat.send: ${text}` });
            ws.send(JSON.stringify(ack('chat.send', envelope.id, { accepted: true, echo: text })));
            break;
        }
        case 'chat.abort': {
            ws.send(JSON.stringify(ack('chat.abort', envelope.id, { accepted: true })));
            break;
        }
        case 'session.create': {
            const agentId = typeof envelope.payload?.agentId === 'string' ? envelope.payload.agentId : 'main';
            const slug = typeof envelope.payload?.slug === 'string' ? envelope.payload.slug : `session-${Date.now()}`;
            const session = (0, gatewayClient_1.addSession)(agentId, slug);
            ws.send(JSON.stringify(ack('session.create', envelope.id, { accepted: true, session })));
            break;
        }
        case 'session.open': {
            const sessionKey = typeof envelope.payload?.sessionKey === 'string'
                ? envelope.payload.sessionKey
                : typeof envelope.payload?.sessionId === 'string'
                    ? envelope.payload.sessionId
                    : '';
            ws.send(JSON.stringify(ack('session.open', envelope.id, { accepted: true, sessionKey })));
            break;
        }
        case 'logs.subscribe': {
            (0, logsService_2.subscribeSubscriber)(ws);
            ws.send(JSON.stringify(ack('logs.subscribe', envelope.id, { accepted: true, topic: 'logs:gateway' })));
            break;
        }
        case 'logs.unsubscribe': {
            (0, logsService_2.unsubscribeSubscriber)(ws);
            ws.send(JSON.stringify(ack('logs.unsubscribe', envelope.id, { accepted: true })));
            break;
        }
        default:
            ws.send(JSON.stringify(ackError('chat.send', envelope.id, 'unknown_command', 'Unknown command')));
    }
}
main().catch((err) => {
    console.error('panel-proxy failed to start', err);
    process.exit(1);
});
