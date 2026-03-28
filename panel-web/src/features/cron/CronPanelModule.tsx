import React, { useEffect, useState } from 'react'
import { Clock3, Pencil, Play, RefreshCw, ToggleLeft, ToggleRight } from 'lucide-react'
import {
  fetchCronJobs,
  formatDateTime,
  runCronDefinition,
  toggleCronDefinition,
  type CronJobSummary,
} from '../../api/client'
import { IconButton } from '../../components/IconButton'
import { CronConfigDialog } from './CronConfigDialog'

type CronPanelModuleProps = {
  agentId: string
}

export function CronPanelModule(props: CronPanelModuleProps) {
  const { agentId } = props
  const [jobs, setJobs] = useState<CronJobSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingJob, setEditingJob] = useState<CronJobSummary | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    void fetchCronJobs(agentId)
      .then((nextJobs) => {
        if (!cancelled) {
          setJobs(nextJobs)
          setError(null)
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : 'Failed to load cron jobs')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [agentId, refreshToken])

  const refreshJobs = async () => {
    setRefreshToken((value) => value + 1)
  }

  return (
    <section className="pw-right-rail-panel">
      <header className="pw-right-rail-panel-header">
        <div>
          <p className="pw-section-kicker">Cron</p>
          <h2>Scheduled runs</h2>
        </div>
        <div className="pw-right-rail-actions">
          <IconButton
            className="pw-secondary-button"
            icon={RefreshCw}
            label="Refresh cron jobs"
            onClick={() => void refreshJobs()}
            spin={loading}
          />
          <IconButton
            className="pw-primary-button"
            icon={Clock3}
            label="New cron"
            data-testid="cron-new-button"
            onClick={() => {
              setEditingJob(null)
              setDialogOpen(true)
            }}
          />
        </div>
      </header>

      {error && <div className="pw-inline-note">{error}</div>}

      <div className="pw-right-rail-body">
        {loading && <div className="pw-empty-state small">Loading cron jobs...</div>}
        {!loading && jobs.length === 0 && (
          <div className="pw-empty-state small">No cron jobs are configured for this agent yet.</div>
        )}
        {!loading && jobs.length > 0 && (
          <div className="pw-rail-list">
            {jobs.map((job) => (
              <article key={job.id} className="pw-rail-card" data-testid={`cron-card-${job.id}`}>
                <div className="pw-rail-card-header">
                  <div>
                    <div className="pw-rail-card-title">{job.name}</div>
                    <div className="pw-rail-card-meta">{job.scheduleLabel}</div>
                  </div>
                  <span className={`pw-badge ${job.enabled ? 'tone-good' : 'tone-muted'}`}>
                    {job.enabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
                <div className="pw-rail-card-meta">
                  {job.sessionTarget || 'isolated'} · {job.payloadKind}
                </div>
                {job.message && <div className="pw-rail-card-copy">{job.message}</div>}
                <div className="pw-rail-card-grid">
                  <span>Next</span>
                  <span>{formatDateTime(job.nextRunAt) || '--'}</span>
                  <span>Last</span>
                  <span>{formatDateTime(job.lastRunAt) || '--'}</span>
                  <span>Status</span>
                  <span>{job.lastStatus || '--'}</span>
                </div>
                <div className="pw-right-rail-actions">
                  <IconButton
                    className="pw-secondary-button"
                    icon={Play}
                    label="Run now"
                    onClick={async () => {
                      try {
                        await runCronDefinition(job.id)
                        await refreshJobs()
                      } catch (nextError) {
                        setError(nextError instanceof Error ? nextError.message : 'Failed to run cron job')
                      }
                    }}
                  />
                  <IconButton
                    className="pw-secondary-button"
                    icon={job.enabled ? ToggleLeft : ToggleRight}
                    label={job.enabled ? 'Disable' : 'Enable'}
                    onClick={async () => {
                      try {
                        await toggleCronDefinition(job.id, !job.enabled)
                        await refreshJobs()
                      } catch (nextError) {
                        setError(nextError instanceof Error ? nextError.message : 'Failed to toggle cron job')
                      }
                    }}
                  />
                  <IconButton
                    className="pw-primary-button"
                    icon={Pencil}
                    label="Edit"
                    onClick={() => {
                      setEditingJob(job)
                      setDialogOpen(true)
                    }}
                  />
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      <CronConfigDialog
        open={dialogOpen}
        agentId={agentId}
        initialJob={editingJob}
        onClose={() => setDialogOpen(false)}
        onSaved={refreshJobs}
      />
    </section>
  )
}
