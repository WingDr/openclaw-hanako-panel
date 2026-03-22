import { Agent, Session } from './types'

export function snapshotStatus(
  agents: Agent[],
  sessions: Session[],
  options?: {
    gatewayConnected?: boolean
    logsConnected?: boolean
    lastUpdatedAt?: string
    logsMessage?: string
  },
) {
  const recent = sessions.slice().sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1)).slice(0, 3)
  const gatewayConnected = options?.gatewayConnected === true
  const logsConnected = options?.logsConnected === true
  const lastUpdatedAt = options?.lastUpdatedAt || new Date().toISOString()

  return {
    gateway: {
      connected: gatewayConnected,
      lastUpdatedAt,
    },
    agents,
    channels: [
      {
        channelKey: 'gateway',
        status: gatewayConnected ? 'connected' as const : 'disconnected' as const,
        summary: gatewayConnected ? 'Primary control link' : 'Gateway not connected',
      },
      {
        channelKey: 'logs',
        status: logsConnected ? 'connected' as const : 'disconnected' as const,
        summary: options?.logsMessage || (logsConnected ? 'Live tail available' : 'Logs tail unavailable'),
      },
    ],
    recentSessions: recent,
  }
}
