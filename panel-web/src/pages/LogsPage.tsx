import React from 'react'
import { LogsStreamModule } from '../features/logs/LogsStreamModule'
import { useRealtimeLogs } from '../features/logs/useRealtimeLogs'

export default function LogsPage() {
  const logsController = useRealtimeLogs()
  return <LogsStreamModule controller={logsController} variant="page" />
}
