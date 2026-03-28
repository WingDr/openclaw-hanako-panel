import React, { useState } from 'react'
import { ChevronDown, ChevronUp, Clock3, FolderTree } from 'lucide-react'
import { CronPanelModule } from '../cron/CronPanelModule'
import { WorkspacePanelModule } from '../workspace/WorkspacePanelModule'

type RightRailModulesHostProps = {
  agentId: string
  sessionKey: string
}

export function RightRailModulesHost(props: RightRailModulesHostProps) {
  const { agentId, sessionKey } = props
  const [openSectionMap, setOpenSectionMap] = useState({
    workspace: true,
    cron: true,
  })

  const toggleSection = (section: 'workspace' | 'cron') => {
    setOpenSectionMap((current) => ({
      ...current,
      [section]: !current[section],
    }))
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
        <span style={{ fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <FolderTree aria-hidden="true" size={16} strokeWidth={1.85} />
          Workspace
        </span>
        <span style={{ fontSize: '0.8em', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center' }}>
          {openSectionMap.workspace
            ? <ChevronUp aria-hidden="true" size={14} strokeWidth={1.85} />
            : <ChevronDown aria-hidden="true" size={14} strokeWidth={1.85} />}
        </span>
      </div>
      
      {openSectionMap.workspace && (
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', borderBottom: '1px solid var(--line-strong)', padding: '16px' }}>
          <WorkspacePanelModule agentId={agentId} sessionKey={sessionKey} />
        </div>
      )}

      {/* Cron Section */}
      <div 
        onClick={() => toggleSection('cron')}
        style={{ 
          padding: '12px 16px', cursor: 'pointer', background: 'var(--paper)', borderBottom: openSectionMap.cron ? '1px solid var(--line-strong)' : 'none', 
          display: 'flex', justifyContent: 'space-between', alignItems: 'center' 
        }}
      >
        <span style={{ fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Clock3 aria-hidden="true" size={16} strokeWidth={1.85} />
          Cron Tasks
        </span>
        <span style={{ fontSize: '0.8em', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center' }}>
          {openSectionMap.cron
            ? <ChevronUp aria-hidden="true" size={14} strokeWidth={1.85} />
            : <ChevronDown aria-hidden="true" size={14} strokeWidth={1.85} />}
        </span>
      </div>
      
      {openSectionMap.cron && (
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '16px' }}>
          <CronPanelModule agentId={agentId} />
        </div>
      )}

      {/* When none are open, let it occupy space but remain empty visually at the bottom */}
      {!openSectionMap.workspace && !openSectionMap.cron && <div style={{ flex: 1, background: 'var(--bg-soft)' }} />}
    </aside>
  )
}
