"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.snapshotStatus = snapshotStatus;
function snapshotStatus(agents, sessions) {
    const recent = sessions.slice().sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1)).slice(0, 3);
    return {
        gateway: {
            connected: true,
            lastUpdatedAt: new Date().toISOString(),
        },
        agents,
        channels: [
            { channelKey: 'gateway', status: 'connected', summary: 'Primary control link' },
            { channelKey: 'logs', status: 'connected', summary: 'Live tail available' },
        ],
        recentSessions: recent,
    };
}
