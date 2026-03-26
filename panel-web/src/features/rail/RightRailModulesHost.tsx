import React, { useState } from 'react'
import { CronPanelModule } from '../cron/CronPanelModule'
import { WorkspacePanelModule } from '../workspace/WorkspacePanelModule'

type RightRailModulesHostProps = {
  agentId: string
  sessionKey: string
}

export function RightRailModulesHost(props: RightRailModulesHostProps) {
  const { agentId, sessionKey } = props
  const [openSection, setOpenSection] = useState<'workspace' | 'cron' | null>('workspace')

  const toggleSection = (section: 'workspace' | 'cron') => {
    setOpenSection(openSection === section ? null : section)
  }

  return (
    <aside className="pw-right-rail" aria-label="Workspace and cron side panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      
      {/* Workspace Section */}
      <div 
        onClick={() => toggleSection('workspace')}
        style={{ 
          padding: '12px 16px', cursor: 'pointer', background: 'var(--paper)', borderBottom: '1px solid var(--line-strong)', 
          display: 'flex', justifyContent: 'space-between', alignItems: 'center' 
        }}
      >
        <span style={{ fontWeight: 'bold' }}>📁 Workspace</span>
        <span style={{ fontSize: '0.8em', color: 'var(--muted)' }}>{openSection === 'workspace' ? '↑' : '↓'}</span>
      </div>
      
      {openSection === 'workspace' && (
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', borderBottom: '1px solid var(--line-strong)', padding: '16px' }}>
          <WorkspacePanelModule agentId={agentId} sessionKey={sessionKey} />
        </div>
      )}

      {/* Cron Section */}
      <div 
        onClick={() => toggleSection('cron')}
        style={{ 
          padding: '12px 16px', cursor: 'pointer', background: 'var(--paper)', borderBottom: openSection === 'cron' ? '1px solid var(--line-strong)' : 'none', 
          display: 'flex', justifyContent: 'space-between', alignItems: 'center' 
        }}
      >
        <span style={{ fontWeight: 'bold' }}>⏱️ Cron Tasks</span>
        <span style={{ fontSize: '0.8em', color: 'var(--muted)' }}>{openSection === 'cron' ? '↑' : '↓'}</span>
      </div>
      
      {openSection === 'cron' && (
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '16px' }}>
          <CronPanelModule agentId={agentId} />
        </div>
      )}

      {/* When none are open, let it occupy space but remain empty visually at the bottom */}
      {!openSection && <div style={{ flex: 1, background: 'var(--bg-soft)' }} />}
    </aside>
  )
}
