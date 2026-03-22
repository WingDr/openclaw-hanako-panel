"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.gatewayLogsClient = exports.GatewayLogsClient = void 0;
exports.parseGatewayLogLine = parseGatewayLogLine;
exports.bootstrap = bootstrap;
exports.fetchAgents = fetchAgents;
exports.fetchAgentSessions = fetchAgentSessions;
exports.addSession = addSession;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_tls_1 = __importDefault(require("node:tls"));
const node_url_1 = require("node:url");
const openClawConfigPath = node_path_1.default.join(node_os_1.default.homedir(), '.openclaw', 'openclaw.json');
const defaultGatewayPort = 18789;
const defaultLogsPollMs = 1000;
const defaultLogsLimit = 200;
const defaultLogsMaxBytes = 250000;
const gatewayRequestTimeoutMs = 10000;
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
const trimToUndefined = (value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
};
const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const isLoopbackHost = (hostname) => {
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
};
const readLocalOpenClawConfig = () => {
    try {
        const raw = node_fs_1.default.readFileSync(openClawConfigPath, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
};
const resolveGatewayUrlFromConfig = (config) => {
    const port = config?.gateway?.port ?? defaultGatewayPort;
    const tlsEnabled = config?.gateway?.tls?.enabled === true;
    const protocol = tlsEnabled ? 'wss' : 'ws';
    return `${protocol}://127.0.0.1:${port}`;
};
async function resolveTlsFingerprint(url) {
    const configured = trimToUndefined(process.env.OPENCLAW_GATEWAY_TLS_FINGERPRINT);
    if (configured) {
        return configured;
    }
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:' || !isLoopbackHost(parsed.hostname)) {
        return undefined;
    }
    return await new Promise((resolve, reject) => {
        const socket = node_tls_1.default.connect({
            host: parsed.hostname,
            port: Number(parsed.port || '443'),
            servername: parsed.hostname,
            rejectUnauthorized: false,
        }, () => {
            const fingerprint = socket.getPeerCertificate()?.fingerprint256;
            socket.end();
            if (typeof fingerprint === 'string' && fingerprint.trim()) {
                resolve(fingerprint);
                return;
            }
            reject(new Error('Failed to resolve Gateway TLS fingerprint'));
        });
        socket.on('error', (error) => {
            reject(error);
        });
    });
}
async function resolveGatewayConfig() {
    const localConfig = readLocalOpenClawConfig();
    const url = trimToUndefined(process.env.OPENCLAW_GATEWAY_WS_URL) || resolveGatewayUrlFromConfig(localConfig);
    return {
        url,
        token: trimToUndefined(process.env.OPENCLAW_GATEWAY_AUTH_TOKEN)
            || trimToUndefined(localConfig?.gateway?.auth?.mode === 'token' ? localConfig.gateway.auth.token : undefined),
        logsPollMs: parsePositiveInt(process.env.OPENCLAW_LOGS_POLL_MS, defaultLogsPollMs),
        logsLimit: parsePositiveInt(process.env.OPENCLAW_LOGS_LIMIT, defaultLogsLimit),
        logsMaxBytes: parsePositiveInt(process.env.OPENCLAW_LOGS_MAX_BYTES, defaultLogsMaxBytes),
        tlsFingerprint: await resolveTlsFingerprint(url),
    };
}
function makeConnectionPayload(connected, message) {
    return {
        source: 'gateway',
        connected,
        at: new Date().toISOString(),
        message,
    };
}
let authProfilesModulePromise;
function resolveAuthProfilesModulePath() {
    const binaryPath = (0, node_child_process_1.execFileSync)('which', ['openclaw'], { encoding: 'utf8' }).trim();
    const packageEntrypoint = node_fs_1.default.realpathSync(binaryPath);
    const distDir = node_path_1.default.join(node_path_1.default.dirname(packageEntrypoint), 'dist');
    const gatewayRpcModule = node_fs_1.default.readdirSync(distDir).find((entry) => /^gateway-rpc-.*\.js$/.test(entry));
    if (!gatewayRpcModule) {
        throw new Error('Failed to resolve OpenClaw gateway-rpc module');
    }
    const gatewayRpcSource = node_fs_1.default.readFileSync(node_path_1.default.join(distDir, gatewayRpcModule), 'utf8');
    const matchedImport = gatewayRpcSource.match(/from "\.\/(auth-profiles-[^"]+\.js)"/);
    if (!matchedImport) {
        throw new Error('Failed to resolve OpenClaw auth-profiles import');
    }
    return node_path_1.default.join(distDir, matchedImport[1]);
}
async function loadAuthProfilesModule() {
    if (!authProfilesModulePromise) {
        authProfilesModulePromise = Promise.resolve(`${(0, node_url_1.pathToFileURL)(resolveAuthProfilesModulePath()).href}`).then(s => __importStar(require(s)));
    }
    return authProfilesModulePromise;
}
function normalizeLogLevel(value) {
    if (value === 'error' || value === 'fatal') {
        return 'error';
    }
    if (value === 'warn' || value === 'warning') {
        return 'warn';
    }
    return 'info';
}
function extractStructuredMessage(payload) {
    return Object.keys(payload)
        .filter((key) => /^\d+$/.test(key))
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => {
        const item = payload[key];
        return typeof item === 'string' ? item : JSON.stringify(item);
    })
        .join(' ')
        .trim();
}
function parseGatewayLogLine(raw) {
    try {
        const payload = JSON.parse(raw);
        const meta = payload._meta ?? {};
        const ts = typeof payload.time === 'string'
            ? payload.time
            : typeof meta.date === 'string'
                ? meta.date
                : new Date().toISOString();
        const level = normalizeLogLevel(typeof meta.logLevelName === 'string' ? meta.logLevelName.toLowerCase() : undefined);
        const text = extractStructuredMessage(payload) || raw;
        return { ts, level, text };
    }
    catch {
        return { ts: new Date().toISOString(), level: 'info', text: raw };
    }
}
class GatewayLogsClient {
    constructor() {
        this.connection = makeConnectionPayload(false, 'Gateway logs client idle');
        this.listeners = new Set();
    }
    onConnectionChange(listener) {
        this.listeners.add(listener);
        listener(this.connection);
        return () => {
            this.listeners.delete(listener);
        };
    }
    getConnectionSnapshot() {
        return this.connection;
    }
    async getResolvedConfig() {
        return resolveGatewayConfig();
    }
    async logsTail(params) {
        const [config, authProfilesModule] = await Promise.all([resolveGatewayConfig(), loadAuthProfilesModule()]);
        try {
            const payload = await authProfilesModule.Ks({
                url: config.url,
                token: config.token,
                method: 'logs.tail',
                params: params,
                timeoutMs: gatewayRequestTimeoutMs,
                clientName: 'gateway-client',
                clientDisplayName: 'openclaw-hanako-panel proxy',
                mode: 'backend',
                tlsFingerprint: config.tlsFingerprint,
            });
            if (!payload || typeof payload !== 'object') {
                throw new Error('Unexpected logs.tail response');
            }
            this.setConnection(true, `Connected to ${config.url}`);
            const parsed = payload;
            return {
                file: typeof parsed.file === 'string' ? parsed.file : '',
                cursor: typeof parsed.cursor === 'number' ? parsed.cursor : 0,
                size: typeof parsed.size === 'number' ? parsed.size : 0,
                lines: Array.isArray(parsed.lines) ? parsed.lines.filter((line) => typeof line === 'string') : [],
                truncated: parsed.truncated === true,
                reset: parsed.reset === true,
            };
        }
        catch (error) {
            const nextError = error instanceof Error ? error : new Error(String(error));
            this.setConnection(false, nextError.message);
            throw nextError;
        }
    }
    setConnection(connected, message) {
        this.connection = makeConnectionPayload(connected, message);
        for (const listener of this.listeners) {
            listener(this.connection);
        }
    }
}
exports.GatewayLogsClient = GatewayLogsClient;
exports.gatewayLogsClient = new GatewayLogsClient();
async function bootstrap() {
    const connection = exports.gatewayLogsClient.getConnectionSnapshot();
    return {
        proxyVersion: '0.1.0',
        gateway: { connected: connection.connected, mode: 'proxy' },
        defaultAgentId: 'main',
        features: { chat: true, logs: true, status: true },
    };
}
async function fetchAgents() {
    return mockAgents;
}
async function fetchAgentSessions(agentId) {
    return mockSessions.filter((session) => session.agentId === agentId);
}
function addSession(agentId, slug, status = 'pending') {
    const session = {
        sessionKey: `agent:${agentId}:panel:${slug}`,
        agentId,
        updatedAt: new Date().toISOString(),
        preview: 'New panel session',
        status,
    };
    mockSessions.push(session);
    return session;
}
