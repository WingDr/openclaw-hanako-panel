import type WebSocket from 'ws'
import { logsStreamCoordinator } from './streaming/logs/LogsStreamCoordinator'

export const getGatewayConnectionSnapshot = () => logsStreamCoordinator.getGatewayConnectionSnapshot()

export const getLogsStatus = () => logsStreamCoordinator.getLogsStatus()

export const getLogsSnapshot = async (limit = 100) => await logsStreamCoordinator.getLogsSnapshot(limit)

export const subscribeSubscriber = async (ws: WebSocket) => await logsStreamCoordinator.subscribe(ws)

export const unsubscribeSubscriber = (ws: WebSocket) => logsStreamCoordinator.unsubscribe(ws)
