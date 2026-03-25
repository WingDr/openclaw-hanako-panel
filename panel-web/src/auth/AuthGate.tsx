import React, { useEffect, useState } from 'react'
import { fetchAuthStatus, loginPanel, type AuthStatus } from '../api/client'
import { panelRealtime } from '../realtime/ws'
import { subscribeAuthRequired } from './events'

type AuthGateProps = {
  children: React.ReactNode
}

function LoadingScreen() {
  return (
    <div className="pw-auth-screen">
      <div className="pw-auth-card">
        <div className="pw-auth-header">
          <p className="pw-section-kicker">Hanako Panel</p>
          <h1>Checking proxy access...</h1>
          <p className="pw-auth-copy">The panel is confirming whether the current browser session is already trusted.</p>
        </div>
      </div>
    </div>
  )
}

export function AuthGate({ children }: AuthGateProps) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshStatus = React.useCallback(async () => {
    setLoading(true)

    try {
      const nextStatus = await fetchAuthStatus()
      setStatus(nextStatus)
      setError(null)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to load proxy auth status')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    const unsubscribe = subscribeAuthRequired(() => {
      setStatus((current) => current ? { ...current, authenticated: false, requiresAuth: true } : {
        enabled: true,
        requiresAuth: true,
        authenticated: false,
        loginEnabled: true,
        apiTokenEnabled: false,
      })
      setError('Panel session expired. Please sign in again.')
      panelRealtime.disconnect()
    })

    return () => {
      unsubscribe()
    }
  }, [refreshStatus])

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending || !password.trim()) {
      return
    }

    setPending(true)
    setError(null)

    try {
      const nextStatus = await loginPanel(password)
      setStatus(nextStatus)
      setPassword('')
      panelRealtime.disconnect()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to sign in to panel-proxy')
    } finally {
      setPending(false)
    }
  }

  if (loading) {
    return <LoadingScreen />
  }

  if (!status) {
    return (
      <div className="pw-auth-screen">
        <div className="pw-auth-card">
          <div className="pw-auth-header">
            <p className="pw-section-kicker">Hanako Panel</p>
            <h1>Unable to reach panel-proxy</h1>
            <p className="pw-auth-copy">{error || 'Failed to load proxy auth status.'}</p>
          </div>
          <button className="pw-primary-button" type="button" onClick={() => void refreshStatus()}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!status.requiresAuth || status.authenticated) {
    return <>{children}</>
  }

  if (!status.loginEnabled) {
    return (
      <div className="pw-auth-screen">
        <div className="pw-auth-card">
          <div className="pw-auth-header">
            <p className="pw-section-kicker">Hanako Panel</p>
            <h1>Panel login is unavailable</h1>
            <p className="pw-auth-copy">
              <code>panel-proxy</code> is protected, but browser login is not configured. Set{' '}
              <code>PANEL_LOGIN_PASSWORD_HASH</code> on the proxy, or use the Bearer API token only for script-based
              access.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="pw-auth-screen">
      <form className="pw-auth-card" onSubmit={onSubmit}>
        <div className="pw-auth-header">
          <p className="pw-section-kicker">Panel Sign-In</p>
          <h1>Enter the panel password</h1>
          <p className="pw-auth-copy">
            After successful sign-in, <code>panel-proxy</code> will issue a short-lived trusted session cookie for this
            browser.
          </p>
        </div>
        <label className="pw-auth-field">
          <span>Panel password</span>
          <input
            className="pw-auth-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder="Enter panel password"
            disabled={pending}
          />
        </label>
        {error && <div className="pw-inline-note">{error}</div>}
        <div className="pw-auth-actions">
          <button className="pw-primary-button" type="submit" disabled={pending || !password.trim()}>
            {pending ? 'Signing in...' : 'Enter panel'}
          </button>
        </div>
      </form>
    </div>
  )
}
