"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.snapshotStatus = snapshotStatus;
function snapshotStatus(agents, sessions, options) {
    const recent = sessions.slice().sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1)).slice(0, 3);
    const gatewayConnected = options?.gatewayConnected === true;
    const logsConnected = options?.logsConnected === true;
    const lastUpdatedAt = options?.lastUpdatedAt || new Date().toISOString();
    return {
        gateway: {
            connected: gatewayConnected,
            lastUpdatedAt,
        },
        agents,
        channels: [
            {
                channelKey: 'gateway',
                status: gatewayConnected ? 'connected' : 'disconnected',
                summary: gatewayConnected ? 'Primary control link' : 'Gateway not connected',
            },
            {
                channelKey: 'logs',
                status: logsConnected ? 'connected' : 'disconnected',
                summary: options?.logsMessage || (logsConnected ? 'Live tail available' : 'Logs tail unavailable'),
            },
        ],
        recentSessions: recent,
    };
}
