import { Agent, Session } from './types'

export function snapshotStatus(agents: Agent[], sessions: Session[]) {
  const recent = sessions.slice().sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1)).slice(0, 3)
  return {
    gateway: {
      connected: true,
      lastUpdatedAt: new Date().toISOString(),
    },
    agents,
    channels: [
      { channelKey: 'gateway', status: 'connected' as const, summary: 'Primary control link' },
      { channelKey: 'logs', status: 'connected' as const, summary: 'Live tail available' },
    ],
    recentSessions: recent,
  }
}
