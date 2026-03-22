const defaultProxyPort = '22846'

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '')
const localHostnames = new Set(['localhost', '127.0.0.1', '::1'])

const runtimeLocation = typeof window !== 'undefined' ? window.location : undefined
const runtimeHostname = runtimeLocation?.hostname || 'localhost'
const runtimeHttpProtocol = runtimeLocation?.protocol === 'https:' ? 'https:' : 'http:'
const runtimeWsProtocol = runtimeLocation?.protocol === 'https:' ? 'wss:' : 'ws:'

const defaultApiBaseUrl = `${runtimeHttpProtocol}//${runtimeHostname}:${defaultProxyPort}`
const defaultWsUrl = `${runtimeWsProtocol}//${runtimeHostname}:${defaultProxyPort}/ws`

const rewriteLocalhostTarget = (value: string): string => {
  if (!runtimeLocation || localHostnames.has(runtimeHostname)) {
    return value
  }

  try {
    const parsed = new URL(value)
    if (!localHostnames.has(parsed.hostname)) {
      return value
    }

    parsed.hostname = runtimeHostname
    return parsed.toString()
  } catch {
    return value
  }
}

export const panelApiBaseUrl = stripTrailingSlash(
  rewriteLocalhostTarget(import.meta.env.VITE_PANEL_API_BASE_URL || defaultApiBaseUrl),
)

export const panelWsUrl = rewriteLocalhostTarget(import.meta.env.VITE_PANEL_WS_URL || defaultWsUrl)

export function createPanelApiUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith('/') ? pathname.slice(1) : pathname
  return new URL(normalizedPath, `${panelApiBaseUrl}/`).toString()
}
