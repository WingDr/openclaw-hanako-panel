import React from 'react'
import { Outlet, Link } from 'react-router-dom'

/* Shell layout: topbar + left navigation + content area + right panel */
export default function Shell({ children }: { children?: React.ReactNode }) {
  return (
    <div className="pw-shell">
      <div className="pw-topbar" aria-label="Top bar">
        <div className="pw-brand">Panel Studio</div>
        <div className="pw-user">◯</div>
      </div>
      <div className="pw-shell-body">
        <aside className="pw-sidebar" aria-label="Sidebar navigation">
          <nav>
            <Link to="/chat" className="pw-nav-item">Chat</Link>
            <Link to="/logs" className="pw-nav-item">Logs</Link>
            <Link to="/status" className="pw-nav-item">Status</Link>
          </nav>
        </aside>
        <main className="pw-content">
          {children ?? <Outlet />}
        </main>
      </div>
    </div>
  )
}
