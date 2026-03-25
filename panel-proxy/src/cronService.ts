import { z } from 'zod'
import { createCronJob, deleteCronJob, listCronJobs, runCronJob, updateCronJob } from './gatewayClient'

const cronSessionTargetSchema = z.union([
  z.literal('main'),
  z.literal('isolated'),
  z.literal('current'),
  z.string().regex(/^session:.+/, 'sessionTarget must be session:<id>'),
])

const cronScheduleSchema = z.union([
  z.object({
    kind: z.literal('at'),
    at: z.string().optional(),
    atMs: z.number().optional(),
  }).passthrough(),
  z.object({
    kind: z.literal('every'),
    everyMs: z.number(),
    anchorMs: z.number().optional(),
  }).passthrough(),
  z.object({
    kind: z.literal('cron'),
    expr: z.string(),
    tz: z.string().optional(),
    staggerMs: z.number().optional(),
  }).passthrough(),
]).superRefine((value, ctx) => {
  if (value.kind === 'at' && !value.at && value.atMs === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'at schedule requires at or atMs',
      path: ['at'],
    })
  }
})

const cronPayloadSchema = z.union([
  z.object({
    kind: z.literal('systemEvent'),
    text: z.string(),
  }).passthrough(),
  z.object({
    kind: z.literal('agentTurn'),
    message: z.string(),
    model: z.string().optional(),
    thinking: z.string().optional(),
    timeoutSeconds: z.number().optional(),
    lightContext: z.boolean().optional(),
  }).passthrough(),
])

const cronDeliverySchema = z.object({
  mode: z.union([z.literal('none'), z.literal('announce'), z.literal('webhook')]).optional(),
  channel: z.string().optional(),
  to: z.string().optional(),
  accountId: z.string().optional(),
  bestEffort: z.boolean().optional(),
}).passthrough()

export const cronJobSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  agentId: z.string().max(200).optional(),
  schedule: cronScheduleSchema.optional(),
  payload: cronPayloadSchema.optional(),
  delivery: cronDeliverySchema.optional(),
  sessionTarget: cronSessionTargetSchema.optional(),
  sessionKey: z.string().max(200).optional(),
  wakeMode: z.union([z.literal('now'), z.literal('next-heartbeat')]).optional(),
  deleteAfterRun: z.boolean().optional(),
  keepAfterRun: z.boolean().optional(),
  notify: z.boolean().optional(),
  staggerMs: z.number().optional(),
  failureAlert: z.boolean().optional(),
  failureAlertAfter: z.number().optional(),
  failureAlertChannel: z.string().optional(),
  failureAlertTo: z.string().optional(),
}).passthrough()

export type CronJobInput = z.infer<typeof cronJobSchema>

export class CronServiceError extends Error {
  readonly code: string
  readonly statusCode: number
  readonly details?: unknown

  constructor(code: string, message: string, statusCode = 400, details?: unknown) {
    super(message)
    this.name = 'CronServiceError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
)

function extractJobList(payload: unknown): Record<string, unknown>[] {
  const record = asRecord(payload)
  if (Array.isArray(record?.jobs)) {
    return record.jobs.flatMap((job) => {
      const next = asRecord(job)
      return next ? [next] : []
    })
  }

  if (Array.isArray(payload)) {
    return payload.flatMap((job) => {
      const next = asRecord(job)
      return next ? [next] : []
    })
  }

  return []
}

function extractJobId(job: Record<string, unknown>): string {
  const direct = typeof job.id === 'string'
    ? job.id
    : typeof job.jobId === 'string'
      ? job.jobId
      : ''

  return direct.trim()
}

function validateOrThrow(input: unknown): CronJobInput {
  const result = cronJobSchema.safeParse(input)
  if (result.success) {
    return result.data
  }

  throw new CronServiceError(
    'cron_validation_failed',
    result.error.issues[0]?.message ?? 'Invalid cron payload',
    400,
    result.error.issues,
  )
}

export function validateCronJob(input: unknown): CronJobInput {
  return validateOrThrow(input)
}

export async function getCronJobs(agentId?: string): Promise<Record<string, unknown>[]> {
  const payload = await listCronJobs()
  const jobs = extractJobList(payload)

  if (!agentId) {
    return jobs
  }

  return jobs.filter((job) => {
    const jobAgentId = typeof job.agentId === 'string' ? job.agentId.trim() : ''
    return jobAgentId === agentId
  })
}

export async function createValidatedCronJob(job: unknown): Promise<unknown> {
  const parsedJob = validateOrThrow(job)
  return await createCronJob(parsedJob as Record<string, unknown>)
}

export async function updateValidatedCronJob(jobId: string, patch: unknown): Promise<unknown> {
  const normalizedJobId = jobId.trim()
  if (!normalizedJobId) {
    throw new CronServiceError('cron_id_required', 'Cron job id is required', 400)
  }

  const parsedPatch = validateOrThrow(patch)
  return await updateCronJob(normalizedJobId, parsedPatch as Record<string, unknown>)
}

export async function toggleCronJob(jobId: string, enabled: boolean): Promise<unknown> {
  return await updateValidatedCronJob(jobId, { enabled })
}

export async function removeCronJob(jobId: string): Promise<unknown> {
  const normalizedJobId = jobId.trim()
  if (!normalizedJobId) {
    throw new CronServiceError('cron_id_required', 'Cron job id is required', 400)
  }

  return await deleteCronJob(normalizedJobId)
}

export async function triggerCronJob(jobId: string): Promise<unknown> {
  const normalizedJobId = jobId.trim()
  if (!normalizedJobId) {
    throw new CronServiceError('cron_id_required', 'Cron job id is required', 400)
  }

  return await runCronJob(normalizedJobId)
}

export function findCronJobById(jobs: Record<string, unknown>[], jobId: string): Record<string, unknown> | undefined {
  return jobs.find((job) => extractJobId(job) === jobId)
}
