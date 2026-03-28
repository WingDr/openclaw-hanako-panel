import React, { useEffect, useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { Braces, Save, SlidersHorizontal, ToggleLeft, ToggleRight, Trash2, X } from 'lucide-react'
import {
  createCronDefinition,
  deleteCronDefinition,
  toggleCronDefinition,
  updateCronDefinition,
  validateCronDefinition,
  type CronJobSummary,
} from '../../api/client'
import { IconButton } from '../../components/IconButton'

type CronConfigDialogProps = {
  open: boolean
  agentId: string
  initialJob?: CronJobSummary | null
  onClose: () => void
  onSaved: () => Promise<void>
}

type FormMode = 'structured' | 'json'
type ScheduleKind = 'at' | 'every' | 'cron'
type ExecutionTarget = 'main' | 'isolated'

type StructuredCronState = {
  name: string
  enabled: boolean
  agentId: string
  scheduleKind: ScheduleKind
  atValue: string
  everyMs: string
  cronExpr: string
  cronTz: string
  executionTarget: ExecutionTarget
  wakeMode: 'now' | 'next-heartbeat'
  message: string
  deliveryMode: 'none' | 'announce'
  deliveryChannel: string
  deliveryTo: string
  deliveryAccountId: string
  deliveryBestEffort: boolean
  model: string
  thinking: string
  timeoutSeconds: string
  lightContext: boolean
}

function toDatetimeLocal(value?: string): string {
  if (!value) {
    return ''
  }

  const date = new Date(value)
  const pad = (input: number): string => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function buildStructuredState(agentId: string, job?: CronJobSummary | null): StructuredCronState {
  const schedule = job?.raw.schedule ?? {}
  const payload = job?.raw.payload ?? {}
  const atValue = typeof schedule.at === 'string'
    ? toDatetimeLocal(schedule.at)
    : typeof schedule.atMs === 'number'
      ? toDatetimeLocal(new Date(schedule.atMs).toISOString())
      : ''

  return {
    name: job?.name ?? '',
    enabled: job?.enabled ?? true,
    agentId: job?.agentId ?? agentId,
    scheduleKind: job?.scheduleKind ?? 'every',
    atValue,
    everyMs: typeof schedule.everyMs === 'number' ? String(schedule.everyMs) : '3600000',
    cronExpr: typeof schedule.expr === 'string' ? schedule.expr : '0 9 * * *',
    cronTz: typeof schedule.tz === 'string' ? schedule.tz : '',
    executionTarget: job?.sessionTarget === 'main' ? 'main' : 'isolated',
    wakeMode: job?.wakeMode === 'next-heartbeat' ? 'next-heartbeat' : 'now',
    message: job?.message ?? '',
    deliveryMode: job?.delivery?.mode === 'announce' ? 'announce' : 'none',
    deliveryChannel: typeof job?.delivery?.channel === 'string' ? job.delivery.channel : '',
    deliveryTo: typeof job?.delivery?.to === 'string' ? job.delivery.to : '',
    deliveryAccountId: typeof job?.delivery?.accountId === 'string' ? job.delivery.accountId : '',
    deliveryBestEffort: job?.delivery?.bestEffort === true,
    model: typeof payload.model === 'string' ? payload.model : '',
    thinking: typeof payload.thinking === 'string' ? payload.thinking : '',
    timeoutSeconds: typeof payload.timeoutSeconds === 'number' ? String(payload.timeoutSeconds) : '',
    lightContext: payload.lightContext === true,
  }
}

function buildStructuredJobPayload(state: StructuredCronState): Record<string, unknown> {
  const schedule = state.scheduleKind === 'at'
    ? { kind: 'at', at: new Date(state.atValue).toISOString() }
    : state.scheduleKind === 'cron'
      ? {
          kind: 'cron',
          expr: state.cronExpr.trim(),
          ...(state.cronTz.trim() ? { tz: state.cronTz.trim() } : {}),
        }
      : {
          kind: 'every',
          everyMs: Number(state.everyMs || '0') || 3_600_000,
        }

  const delivery = state.deliveryMode === 'announce'
    ? {
        mode: 'announce',
        ...(state.deliveryChannel.trim() ? { channel: state.deliveryChannel.trim() } : {}),
        ...(state.deliveryTo.trim() ? { to: state.deliveryTo.trim() } : {}),
        ...(state.deliveryAccountId.trim() ? { accountId: state.deliveryAccountId.trim() } : {}),
        ...(state.deliveryBestEffort ? { bestEffort: true } : {}),
      }
    : { mode: 'none' }

  const payload = state.executionTarget === 'main'
    ? {
        kind: 'systemEvent',
        text: state.message.trim(),
      }
    : {
        kind: 'agentTurn',
        message: state.message.trim(),
        ...(state.model.trim() ? { model: state.model.trim() } : {}),
        ...(state.thinking.trim() ? { thinking: state.thinking.trim() } : {}),
        ...(state.timeoutSeconds.trim() ? { timeoutSeconds: Number(state.timeoutSeconds) } : {}),
        ...(state.lightContext ? { lightContext: true } : {}),
      }

  return {
    name: state.name.trim() || undefined,
    enabled: state.enabled,
    agentId: state.agentId.trim() || undefined,
    schedule,
    payload,
    delivery,
    sessionTarget: state.executionTarget,
    sessionKey: state.executionTarget === 'main' ? `agent:${state.agentId.trim() || 'main'}:main` : undefined,
    wakeMode: state.wakeMode,
  }
}

function stringifyJob(rawJob?: Record<string, unknown>): string {
  return JSON.stringify(rawJob ?? {}, null, 2)
}

export function CronConfigDialog(props: CronConfigDialogProps) {
  const { open, agentId, initialJob, onClose, onSaved } = props
  const isEdit = Boolean(initialJob)
  const [formMode, setFormMode] = useState<FormMode>('structured')
  const [structuredState, setStructuredState] = useState<StructuredCronState>(() => buildStructuredState(agentId, initialJob))
  const [jsonValue, setJsonValue] = useState(() => stringifyJob(initialJob?.raw))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const nextStructured = buildStructuredState(agentId, initialJob)
    setStructuredState(nextStructured)
    setJsonValue(stringifyJob(initialJob?.raw ?? buildStructuredJobPayload(nextStructured)))
    setFormMode('structured')
    setError(null)
  }, [agentId, initialJob, open])

  const structuredPreview = useMemo(
    () => stringifyJob(buildStructuredJobPayload(structuredState)),
    [structuredState],
  )

  async function handleValidateJson(rawValue: string): Promise<Record<string, unknown>> {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(rawValue) as Record<string, unknown>
    } catch (nextError) {
      throw new Error(nextError instanceof Error ? nextError.message : 'Invalid JSON')
    }

    await validateCronDefinition(isEdit ? { patch: parsed } : { job: parsed })
    return parsed
  }

  async function handleSubmit() {
    setPending(true)
    setError(null)

    try {
      if (formMode === 'json') {
        const parsed = await handleValidateJson(jsonValue)
        if (isEdit && initialJob) {
          await updateCronDefinition(initialJob.id, parsed)
        } else {
          await createCronDefinition(parsed)
        }
      } else {
        const payload = buildStructuredJobPayload(structuredState)
        await validateCronDefinition(isEdit ? { patch: payload } : { job: payload })
        if (isEdit && initialJob) {
          await updateCronDefinition(initialJob.id, payload)
        } else {
          await createCronDefinition(payload)
        }
      }

      await onSaved()
      onClose()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to save cron job')
    } finally {
      setPending(false)
    }
  }

  async function handleDelete() {
    if (!initialJob) {
      return
    }

    setPending(true)
    setError(null)
    try {
      await deleteCronDefinition(initialJob.id)
      await onSaved()
      onClose()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to delete cron job')
    } finally {
      setPending(false)
    }
  }

  if (!open) {
    return null
  }

  return (
    <div className="pw-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="pw-modal pw-cron-modal" role="dialog" aria-modal="true" data-testid="cron-config-dialog" onClick={(event) => event.stopPropagation()}>
        <header className="pw-modal-header">
          <div>
            <p className="pw-section-kicker">Cron</p>
            <h2>{isEdit ? 'Edit cron job' : 'Create cron job'}</h2>
            <p className="pw-muted-copy">
              {'Structured mode only generates `main -> systemEvent` and `isolated -> agentTurn`. Advanced targets stay available in JSON mode.'}
            </p>
          </div>
          <div className="pw-modal-actions">
            <IconButton
              className={`pw-secondary-button ${formMode === 'structured' ? 'is-selected' : ''}`}
              icon={SlidersHorizontal}
              label="Structured"
              data-testid="cron-mode-structured"
              aria-pressed={formMode === 'structured'}
              onClick={() => {
                setFormMode('structured')
                setError(null)
              }}
            />
            <IconButton
              className={`pw-secondary-button ${formMode === 'json' ? 'is-selected' : ''}`}
              icon={Braces}
              label="JSON"
              data-testid="cron-mode-json"
              aria-pressed={formMode === 'json'}
              onClick={() => {
                setJsonValue(structuredPreview)
                setFormMode('json')
                setError(null)
              }}
            />
            <IconButton
              className="pw-secondary-button"
              icon={X}
              label="Close cron dialog"
              onClick={onClose}
            />
          </div>
        </header>

        <div className="pw-modal-content">
          {formMode === 'structured' ? (
            <div className="pw-cron-grid">
              <label className="pw-rail-field">
                <span>Name</span>
                <input data-testid="cron-name-input" className="pw-rail-input" value={structuredState.name} onChange={(event) => setStructuredState((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label className="pw-rail-field">
                <span>Agent</span>
                <input data-testid="cron-agent-input" className="pw-rail-input" value={structuredState.agentId} onChange={(event) => setStructuredState((current) => ({ ...current, agentId: event.target.value }))} />
              </label>
              <label className="pw-rail-field">
                <span>Schedule</span>
                <select data-testid="cron-schedule-select" className="pw-rail-select" value={structuredState.scheduleKind} onChange={(event) => setStructuredState((current) => ({ ...current, scheduleKind: event.target.value as ScheduleKind }))}>
                  <option value="every">Every</option>
                  <option value="cron">Cron</option>
                  <option value="at">At</option>
                </select>
              </label>
              <label className="pw-rail-field">
                <span>Execution</span>
                <select data-testid="cron-execution-select" className="pw-rail-select" value={structuredState.executionTarget} onChange={(event) => setStructuredState((current) => ({ ...current, executionTarget: event.target.value as ExecutionTarget }))}>
                  <option value="isolated">Isolated</option>
                  <option value="main">Main</option>
                </select>
              </label>
              {structuredState.scheduleKind === 'every' && (
                <label className="pw-rail-field">
                  <span>Every (ms)</span>
                    <input data-testid="cron-every-input" className="pw-rail-input" value={structuredState.everyMs} onChange={(event) => setStructuredState((current) => ({ ...current, everyMs: event.target.value }))} />
                </label>
              )}
              {structuredState.scheduleKind === 'cron' && (
                <>
                  <label className="pw-rail-field">
                    <span>Cron expr</span>
                    <input data-testid="cron-expr-input" className="pw-rail-input" value={structuredState.cronExpr} onChange={(event) => setStructuredState((current) => ({ ...current, cronExpr: event.target.value }))} />
                  </label>
                  <label className="pw-rail-field">
                    <span>Timezone</span>
                    <input data-testid="cron-tz-input" className="pw-rail-input" value={structuredState.cronTz} onChange={(event) => setStructuredState((current) => ({ ...current, cronTz: event.target.value }))} />
                  </label>
                </>
              )}
              {structuredState.scheduleKind === 'at' && (
                <label className="pw-rail-field">
                  <span>Run at</span>
                  <input data-testid="cron-at-input" className="pw-rail-input" type="datetime-local" value={structuredState.atValue} onChange={(event) => setStructuredState((current) => ({ ...current, atValue: event.target.value }))} />
                </label>
              )}
              <label className="pw-rail-field">
                <span>Wake mode</span>
                <select data-testid="cron-wake-select" className="pw-rail-select" value={structuredState.wakeMode} onChange={(event) => setStructuredState((current) => ({ ...current, wakeMode: event.target.value as StructuredCronState['wakeMode'] }))}>
                  <option value="now">now</option>
                  <option value="next-heartbeat">next-heartbeat</option>
                </select>
              </label>
              <label className="pw-rail-field is-checkbox">
                <input type="checkbox" checked={structuredState.enabled} onChange={(event) => setStructuredState((current) => ({ ...current, enabled: event.target.checked }))} />
                <span>Enabled</span>
              </label>
              <label className="pw-rail-field is-full-width">
                <span>{structuredState.executionTarget === 'main' ? 'Event text' : 'Agent message'}</span>
                <textarea data-testid="cron-message-input" className="pw-rail-textarea" rows={5} value={structuredState.message} onChange={(event) => setStructuredState((current) => ({ ...current, message: event.target.value }))} />
              </label>

              {structuredState.executionTarget === 'isolated' && (
                <>
                  <label className="pw-rail-field">
                    <span>Model</span>
                    <input data-testid="cron-model-input" className="pw-rail-input" value={structuredState.model} onChange={(event) => setStructuredState((current) => ({ ...current, model: event.target.value }))} />
                  </label>
                  <label className="pw-rail-field">
                    <span>Thinking</span>
                    <input data-testid="cron-thinking-input" className="pw-rail-input" value={structuredState.thinking} onChange={(event) => setStructuredState((current) => ({ ...current, thinking: event.target.value }))} />
                  </label>
                  <label className="pw-rail-field">
                    <span>Timeout (sec)</span>
                    <input data-testid="cron-timeout-input" className="pw-rail-input" value={structuredState.timeoutSeconds} onChange={(event) => setStructuredState((current) => ({ ...current, timeoutSeconds: event.target.value }))} />
                  </label>
                  <label className="pw-rail-field is-checkbox">
                    <input type="checkbox" checked={structuredState.lightContext} onChange={(event) => setStructuredState((current) => ({ ...current, lightContext: event.target.checked }))} />
                    <span>Light context</span>
                  </label>
                </>
              )}

              <label className="pw-rail-field">
                <span>Delivery</span>
                <select data-testid="cron-delivery-select" className="pw-rail-select" value={structuredState.deliveryMode} onChange={(event) => setStructuredState((current) => ({ ...current, deliveryMode: event.target.value as StructuredCronState['deliveryMode'] }))}>
                  <option value="none">none</option>
                  <option value="announce">announce</option>
                </select>
              </label>
              {structuredState.deliveryMode === 'announce' && (
                <>
                  <label className="pw-rail-field">
                    <span>Channel</span>
                    <input data-testid="cron-delivery-channel-input" className="pw-rail-input" value={structuredState.deliveryChannel} onChange={(event) => setStructuredState((current) => ({ ...current, deliveryChannel: event.target.value }))} />
                  </label>
                  <label className="pw-rail-field">
                    <span>To</span>
                    <input data-testid="cron-delivery-to-input" className="pw-rail-input" value={structuredState.deliveryTo} onChange={(event) => setStructuredState((current) => ({ ...current, deliveryTo: event.target.value }))} />
                  </label>
                  <label className="pw-rail-field">
                    <span>Account</span>
                    <input data-testid="cron-delivery-account-input" className="pw-rail-input" value={structuredState.deliveryAccountId} onChange={(event) => setStructuredState((current) => ({ ...current, deliveryAccountId: event.target.value }))} />
                  </label>
                  <label className="pw-rail-field is-checkbox">
                    <input type="checkbox" checked={structuredState.deliveryBestEffort} onChange={(event) => setStructuredState((current) => ({ ...current, deliveryBestEffort: event.target.checked }))} />
                    <span>Best effort</span>
                  </label>
                </>
              )}
            </div>
          ) : (
            <div className="pw-json-editor-shell">
              <CodeMirror
                data-testid="cron-json-editor"
                value={jsonValue}
                height="56vh"
                extensions={[json()]}
                basicSetup={{
                  autocompletion: true,
                  lineNumbers: true,
                  bracketMatching: true,
                  highlightSelectionMatches: true,
                }}
                onCreateEditor={(view) => {
                  if (typeof window !== 'undefined') {
                    ;(window as Window & { __HANAKO_TEST_EDITORS__?: Record<string, unknown> }).__HANAKO_TEST_EDITORS__ = {
                      ...((window as Window & { __HANAKO_TEST_EDITORS__?: Record<string, unknown> }).__HANAKO_TEST_EDITORS__ ?? {}),
                      cronJson: view,
                    }
                  }
                }}
                onChange={(value) => setJsonValue(value)}
              />
            </div>
          )}
        </div>

        {error && <div className="pw-inline-note" data-testid="cron-error-note">{error}</div>}

        <footer className="pw-modal-footer">
          <div className="pw-muted-copy">
            {'JSON mode supports `current`, `session:*`, `webhook`, `deleteAfterRun`, `staggerMs`, and future fields without form changes.'}
          </div>
          <div className="pw-modal-actions">
            {isEdit && (
              <>
                <IconButton
                  className="pw-secondary-button"
                  icon={initialJob?.enabled ? ToggleLeft : ToggleRight}
                  label={initialJob?.enabled ? 'Disable' : 'Enable'}
                  onClick={async () => {
                    if (!initialJob) {
                      return
                    }
                    setPending(true)
                    setError(null)
                    try {
                      await toggleCronDefinition(initialJob.id, !initialJob.enabled)
                      await onSaved()
                      onClose()
                    } catch (nextError) {
                      setError(nextError instanceof Error ? nextError.message : 'Failed to toggle cron job')
                    } finally {
                      setPending(false)
                    }
                  }}
                  disabled={pending}
                />
                <IconButton
                  className="pw-secondary-button"
                  icon={Trash2}
                  label="Delete"
                  onClick={() => void handleDelete()}
                  disabled={pending}
                />
              </>
            )}
            <IconButton
              className="pw-primary-button"
              icon={Save}
              label={pending ? 'Saving cron job' : isEdit ? 'Save changes' : 'Create cron'}
              data-testid="cron-save-button"
              onClick={() => void handleSubmit()}
              disabled={pending}
              spin={pending}
            />
          </div>
        </footer>
      </div>
    </div>
  )
}
