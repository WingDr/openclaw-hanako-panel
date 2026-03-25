import React from 'react'
import { CronPanelModule } from '../cron/CronPanelModule'
import { WorkspacePanelModule } from '../workspace/WorkspacePanelModule'

type RightRailModulesHostProps = {
  agentId: string
  sessionKey: string
}

export function RightRailModulesHost(props: RightRailModulesHostProps) {
  const { agentId, sessionKey } = props

  return (
    <aside className="pw-right-rail" aria-label="Workspace and cron side panel">
      <div className="pw-right-rail-stack">
        <WorkspacePanelModule agentId={agentId} sessionKey={sessionKey} />
        <CronPanelModule agentId={agentId} />
      </div>
    </aside>
  )
}
