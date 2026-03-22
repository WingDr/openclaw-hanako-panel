const defaultApiBaseUrl = 'http://localhost:22846'
const defaultWsUrl = 'ws://localhost:22846/ws'

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

export const panelApiBaseUrl = stripTrailingSlash(
  import.meta.env.VITE_PANEL_API_BASE_URL || defaultApiBaseUrl,
)

export const panelWsUrl = import.meta.env.VITE_PANEL_WS_URL || defaultWsUrl

export function createPanelApiUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith('/') ? pathname.slice(1) : pathname
  return new URL(normalizedPath, `${panelApiBaseUrl}/`).toString()
}
