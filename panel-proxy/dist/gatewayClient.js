"use strict";
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
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_tls_1 = __importDefault(require("node:tls"));
const ws_1 = __importDefault(require("ws"));
const openClawConfigPath = node_path_1.default.join(node_os_1.default.homedir(), '.openclaw', 'openclaw.json');
const openClawDeviceIdentityPath = node_path_1.default.join(node_os_1.default.homedir(), '.openclaw', 'identity', 'device.json');
const panelProxyIdentityPath = node_path_1.default.join(node_os_1.default.homedir(), '.openclaw-hanako-panel', 'device-identity.json');
const defaultGatewayPort = 18789;
const defaultLogsPollMs = 1000;
const defaultLogsLimit = 200;
const defaultLogsMaxBytes = 250000;
const gatewayRequestTimeoutMs = 10000;
const gatewayChallengeTimeoutMs = 5000;
const gatewayClientId = 'gateway-client';
const gatewayClientMode = 'backend';
const gatewayDeviceScopes = ['operator.read', 'operator.write'];
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
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
function base64UrlEncode(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function derivePublicKeyRaw(publicKeyPem) {
    const spki = node_crypto_1.default.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    if (spki.length === ed25519SpkiPrefix.length + 32 && spki.subarray(0, ed25519SpkiPrefix.length).equals(ed25519SpkiPrefix)) {
        return spki.subarray(ed25519SpkiPrefix.length);
    }
    return spki;
}
function fingerprintPublicKey(publicKeyPem) {
    return node_crypto_1.default.createHash('sha256').update(derivePublicKeyRaw(publicKeyPem)).digest('hex');
}
function loadIdentityFromPath(filePath) {
    try {
        const raw = node_fs_1.default.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.deviceId === 'string'
            && typeof parsed.publicKeyPem === 'string'
            && typeof parsed.privateKeyPem === 'string') {
            return {
                deviceId: parsed.deviceId,
                publicKeyPem: parsed.publicKeyPem,
                privateKeyPem: parsed.privateKeyPem,
            };
        }
    }
    catch {
    }
    return undefined;
}
function storeIdentity(filePath, identity) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(filePath), { recursive: true, mode: 0o700 });
    const stored = {
        version: 1,
        deviceId: identity.deviceId,
        publicKeyPem: identity.publicKeyPem,
        privateKeyPem: identity.privateKeyPem,
        createdAtMs: Date.now(),
    };
    node_fs_1.default.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
}
function generateDeviceIdentity() {
    const { publicKey, privateKey } = node_crypto_1.default.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    return {
        deviceId: fingerprintPublicKey(publicKeyPem),
        publicKeyPem,
        privateKeyPem,
    };
}
let cachedDeviceIdentity;
function resolveDeviceIdentity() {
    if (cachedDeviceIdentity) {
        return cachedDeviceIdentity;
    }
    const explicitPath = trimToUndefined(process.env.PANEL_PROXY_DEVICE_IDENTITY_PATH);
    const candidatePaths = [
        explicitPath,
        node_fs_1.default.existsSync(openClawDeviceIdentityPath) ? openClawDeviceIdentityPath : undefined,
        panelProxyIdentityPath,
    ].filter((entry) => typeof entry === 'string' && entry.length > 0);
    for (const candidate of candidatePaths) {
        const identity = loadIdentityFromPath(candidate);
        if (identity) {
            cachedDeviceIdentity = identity;
            return identity;
        }
    }
    const generated = generateDeviceIdentity();
    storeIdentity(panelProxyIdentityPath, generated);
    cachedDeviceIdentity = generated;
    return generated;
}
function buildDeviceSignaturePayload(params) {
    return [
        'v3',
        params.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        params.scopes.join(','),
        String(params.signedAtMs),
        params.token,
        params.nonce,
        params.platform,
        params.deviceFamily ?? '',
    ].join('|');
}
function createDeviceBlock(token, nonce) {
    const identity = resolveDeviceIdentity();
    const signedAt = Date.now();
    const payload = buildDeviceSignaturePayload({
        deviceId: identity.deviceId,
        clientId: gatewayClientId,
        clientMode: gatewayClientMode,
        role: 'operator',
        scopes: [...gatewayDeviceScopes],
        signedAtMs: signedAt,
        token,
        nonce,
        platform: process.platform,
        deviceFamily: '',
    });
    const signature = base64UrlEncode(node_crypto_1.default.sign(null, Buffer.from(payload, 'utf8'), node_crypto_1.default.createPrivateKey(identity.privateKeyPem)));
    return {
        id: identity.deviceId,
        publicKey: base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem)),
        signature,
        signedAt,
        nonce,
    };
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
function isGatewayEventFrame(payload) {
    return payload.type === 'event';
}
function isGatewayResponseFrame(payload) {
    return payload.type === 'res';
}
function normalizeTlsFingerprint(value) {
    return (value ?? '').trim().replace(/^sha-?256\s*:?\s*/i, '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}
function buildGatewayWsOptions(config) {
    const parsed = new URL(config.url);
    const options = {
        maxPayload: 25 * 1024 * 1024,
    };
    if (parsed.protocol !== 'wss:') {
        return options;
    }
    if (config.tlsFingerprint) {
        options.rejectUnauthorized = false;
        options.checkServerIdentity = (_host, cert) => {
            const fingerprintValue = typeof cert === 'object' && cert && 'fingerprint256' in cert ? cert.fingerprint256 ?? '' : '';
            const fingerprint = normalizeTlsFingerprint(typeof fingerprintValue === 'string' ? fingerprintValue : '');
            const expected = normalizeTlsFingerprint(config.tlsFingerprint);
            return Boolean(expected) && Boolean(fingerprint) && fingerprint === expected;
        };
        return options;
    }
    if (isLoopbackHost(parsed.hostname)) {
        options.rejectUnauthorized = false;
    }
    return options;
}
function makeGatewayError(method, error) {
    const code = trimToUndefined(error?.code);
    const message = trimToUndefined(error?.message) || `${method} failed`;
    return new Error(code ? `${message} (${code})` : message);
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
        this.pending = new Map();
        this.listeners = new Set();
        this.connection = makeConnectionPayload(false, 'Gateway logs client idle');
        this.requestSeq = 0;
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
        const payload = await this.request('logs.tail', params);
        if (!payload || typeof payload !== 'object') {
            throw new Error('Unexpected logs.tail response');
        }
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
    nextRequestId(prefix) {
        this.requestSeq += 1;
        return `${prefix}-${this.requestSeq}`;
    }
    setConnection(connected, message) {
        this.connection = makeConnectionPayload(connected, message);
        for (const listener of this.listeners) {
            listener(this.connection);
        }
    }
    clearChallengeTimer() {
        if (this.challengeTimer) {
            clearTimeout(this.challengeTimer);
            this.challengeTimer = undefined;
        }
    }
    rejectPending(error) {
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timeoutId);
            pending.reject(error);
            this.pending.delete(id);
        }
    }
    failConnect(error) {
        this.clearChallengeTimer();
        this.connectRequestId = undefined;
        if (this.connectReject) {
            this.connectReject(error);
        }
        this.connectResolve = undefined;
        this.connectReject = undefined;
        this.setConnection(false, error.message);
    }
    finalizeConnected() {
        this.clearChallengeTimer();
        this.connectRequestId = undefined;
        if (this.connectResolve) {
            this.connectResolve();
        }
        this.connectResolve = undefined;
        this.connectReject = undefined;
        this.setConnection(true, `Connected to ${this.config?.url ?? 'Gateway'}`);
    }
    cleanupSocket(error) {
        const socket = this.ws;
        this.ws = undefined;
        if (socket) {
            socket.removeAllListeners();
            try {
                socket.close();
            }
            catch {
            }
        }
        this.config = undefined;
        if (error) {
            this.failConnect(error);
            this.rejectPending(error);
        }
        else {
            this.clearChallengeTimer();
            this.connectResolve = undefined;
            this.connectReject = undefined;
            this.connectRequestId = undefined;
        }
    }
    handleGatewayMessage(raw) {
        let payload;
        try {
            payload = JSON.parse(raw.toString());
        }
        catch {
            return;
        }
        if (isGatewayEventFrame(payload)) {
            if (payload.event === 'connect.challenge') {
                void this.sendConnectChallengeResponse(payload.payload);
            }
            return;
        }
        if (!isGatewayResponseFrame(payload) || !payload.id) {
            return;
        }
        if (payload.id === this.connectRequestId) {
            if (payload.ok) {
                this.finalizeConnected();
                return;
            }
            const error = makeGatewayError('connect', payload.error);
            this.cleanupSocket(error);
            return;
        }
        const pending = this.pending.get(payload.id);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timeoutId);
        this.pending.delete(payload.id);
        if (!payload.ok) {
            const error = makeGatewayError('request', payload.error);
            if (payload.error?.message?.includes('missing scope')) {
                this.setConnection(false, payload.error.message);
            }
            pending.reject(error);
            return;
        }
        pending.resolve(payload.payload);
    }
    async sendConnectChallengeResponse(payload) {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN || this.connectRequestId) {
            return;
        }
        const nonce = typeof payload?.nonce === 'string' ? payload.nonce.trim() : '';
        if (!nonce) {
            this.cleanupSocket(new Error('Gateway connect challenge missing nonce'));
            return;
        }
        const token = this.config?.token ?? '';
        const connectId = this.nextRequestId('connect');
        this.connectRequestId = connectId;
        const message = {
            type: 'req',
            id: connectId,
            method: 'connect',
            params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                    id: gatewayClientId,
                    displayName: 'openclaw-hanako-panel proxy',
                    version: '0.1.0',
                    platform: process.platform,
                    mode: gatewayClientMode,
                },
                role: 'operator',
                scopes: [...gatewayDeviceScopes],
                ...(token ? { auth: { token } } : {}),
                device: createDeviceBlock(token, nonce),
            },
        };
        this.ws.send(JSON.stringify(message));
    }
    async ensureConnected() {
        if (this.ws?.readyState === ws_1.default.OPEN && !this.connectPromise && !this.connectRequestId) {
            return;
        }
        if (this.connectPromise) {
            return this.connectPromise;
        }
        this.connectPromise = (async () => {
            const config = await resolveGatewayConfig();
            this.config = config;
            await new Promise((resolve, reject) => {
                const ws = new ws_1.default(config.url, buildGatewayWsOptions(config));
                this.ws = ws;
                this.connectResolve = resolve;
                this.connectReject = reject;
                this.setConnection(false, `Connecting to ${config.url}`);
                this.challengeTimer = setTimeout(() => {
                    this.cleanupSocket(new Error('Timed out waiting for Gateway connect challenge'));
                }, gatewayChallengeTimeoutMs);
                ws.on('message', (data) => {
                    this.handleGatewayMessage(data);
                });
                ws.on('close', (code, reason) => {
                    const reasonText = reason.toString().trim();
                    const message = `gateway closed (${code}): ${reasonText || 'no reason provided'}`;
                    this.cleanupSocket(new Error(message));
                });
                ws.on('error', (error) => {
                    this.cleanupSocket(error instanceof Error ? error : new Error(String(error)));
                });
            });
        })().finally(() => {
            this.connectPromise = undefined;
        });
        return this.connectPromise;
    }
    async request(method, params) {
        await this.ensureConnected();
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
            throw new Error('Gateway WebSocket is not connected');
        }
        const id = this.nextRequestId(method.replace(/\./g, '-'));
        return await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${gatewayRequestTimeoutMs}ms`));
            }, gatewayRequestTimeoutMs);
            this.pending.set(id, { resolve, reject, timeoutId });
            this.ws?.send(JSON.stringify({
                type: 'req',
                id,
                method,
                params,
            }));
        });
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
