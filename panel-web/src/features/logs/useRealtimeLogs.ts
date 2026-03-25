import React, { useEffect, useMemo, useRef, useState } from 'react'
import { fetchLogs, mapProxyLogLine, type LogEntry } from '../../api/client'
import { panelRealtime } from '../../realtime/ws'

type RealtimeLogsAppendPayload = {
  cursor: number
  lines: Array<{
    ts: string
    level: 'info' | 'warn' | 'error'
    text: string
  }>
}

type RealtimeLogsResetPayload = {
  reason: string
}

type SystemConnectionPayload = {
  source: 'gateway'
  connected: boolean
  at: string
  message?: string
}

const autoFollowThresholdPx = 32

function isNearBottom(element: HTMLDivElement): boolean {
  const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
  return distanceFromBottom <= autoFollowThresholdPx
}

export type RealtimeLogsController = {
  filteredLogs: LogEntry[]
  search: string
  setSearch: React.Dispatch<React.SetStateAction<string>>
  loading: boolean
  error: string | null
  live: boolean
  connectionMessage: string | null
  autoFollow: boolean
  setAutoFollow: React.Dispatch<React.SetStateAction<boolean>>
  logListRef: React.MutableRefObject<HTMLDivElement | null>
  scrollToBottom: () => void
  updateAutoFollow: () => void
}

export function useRealtimeLogs(): RealtimeLogsController {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null)
  const [autoFollow, setAutoFollow] = useState(true)
  const logListRef = useRef<HTMLDivElement | null>(null)
  const scrollIgnoreUntilRef = useRef(0)
  const scrollFrameRef = useRef<number | null>(null)

  const scrollToBottom = () => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current)
    }

    scrollFrameRef.current = window.requestAnimationFrame(() => {
      const element = logListRef.current
      if (!element) {
        return
      }

      scrollIgnoreUntilRef.current = Date.now() + 180
      element.scrollTop = element.scrollHeight

      window.requestAnimationFrame(() => {
        const nextElement = logListRef.current
        if (!nextElement) {
          return
        }

        if (isNearBottom(nextElement)) {
          setAutoFollow(true)
        }
      })
    })
  }

  const updateAutoFollow = () => {
    const element = logListRef.current
    if (!element) {
      return
    }

    if (Date.now() < scrollIgnoreUntilRef.current) {
      return
    }

    setAutoFollow(isNearBottom(element))
  }

  useEffect(() => {
    let cancelled = false
    const unsubscribe = panelRealtime.subscribe((event) => {
      if (cancelled) {
        return
      }

      if (event.event === 'logs.reset') {
        const payload = event.payload as RealtimeLogsResetPayload
        setLogs([])
        setConnectionMessage(payload.reason === 'subscribed' ? null : `Logs reset: ${payload.reason}`)
      }

      if (event.event === 'logs.append') {
        const payload = event.payload as RealtimeLogsAppendPayload
        setLogs((current) => [
          ...current,
          ...payload.lines.map((line, index) => mapProxyLogLine(line, current.length + index)),
        ])
      }

      if (event.event === 'system.connection') {
        const payload = event.payload as SystemConnectionPayload
        setLive(payload.connected)
        setConnectionMessage(payload.message || null)
      }
    })

    const loadLogs = async () => {
      setLoading(true)
      setError(null)

      try {
        const snapshot = await fetchLogs()
        if (!cancelled) {
          setLogs(snapshot)
        }

        await panelRealtime.sendCommand('logs.subscribe', {})
        if (!cancelled) {
          setConnectionMessage(null)
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : 'Failed to load logs')
          setLive(false)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadLogs()

    return () => {
      cancelled = true
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current)
      }
      unsubscribe()
      void panelRealtime.sendCommand('logs.unsubscribe', {}).catch(() => {})
    }
  }, [])

  const filteredLogs = useMemo(
    () => logs.filter((log) => {
      if (!search.trim()) {
        return true
      }

      const query = search.trim().toLowerCase()
      return `${log.level} ${log.message} ${log.timestamp}`.toLowerCase().includes(query)
    }),
    [logs, search],
  )

  useEffect(() => {
    if (!autoFollow) {
      return
    }

    scrollToBottom()
  }, [autoFollow, filteredLogs.length])

  return {
    filteredLogs,
    search,
    setSearch,
    loading,
    error,
    live,
    connectionMessage,
    autoFollow,
    setAutoFollow,
    logListRef,
    scrollToBottom,
    updateAutoFollow,
  }
}
