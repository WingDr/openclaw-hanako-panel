import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { createApp, handleEnvelope } from './app'

type GatewayState = {
  jobs: Array<Record<string, unknown>>
  injectedMessages: Array<{ sessionKey: string; message: string }>
}

const gatewayState: GatewayState = {
  jobs: [],
  injectedMessages: [],
}

const gatewayClientMock = vi.hoisted(() => ({
  bootstrap: vi.fn(async () => ({
    proxyVersion: '0.1.0',
    gateway: { connected: true, mode: 'proxy' as const },
    defaultAgentId: 'mon3tr',
    features: { chat: true, logs: true, status: true, workspace: true, cron: true },
  })),
  fetchAgents: vi.fn(async () => [
    { agentId: 'mon3tr', label: 'Mon3tr', status: 'online', capabilities: ['chat'] },
  ]),
  fetchAgentSessions: vi.fn(async () => [
    {
      sessionKey: 'agent:mon3tr:hanako-panel:test-session',
      agentId: 'mon3tr',
      updatedAt: new Date().toISOString(),
      preview: 'Panel session',
      status: 'opened',
    },
  ]),
  fetchChatHistory: vi.fn(async () => []),
  fetchSessions: vi.fn(async () => [
    {
      sessionKey: 'agent:mon3tr:hanako-panel:test-session',
      agentId: 'mon3tr',
      updatedAt: new Date().toISOString(),
      preview: 'Panel session',
      status: 'opened',
    },
  ]),
  sendChatMessage: vi.fn(async () => ({ accepted: true, sessionKey: 'agent:mon3tr:hanako-panel:test-session', runId: 'run-1' })),
  sendChatInjection: vi.fn(async ({ sessionKey, message }: { sessionKey: string; message: string }) => {
    gatewayState.injectedMessages.push({ sessionKey, message })
    return { accepted: true, sessionKey }
  }),
  abortChatRun: vi.fn(async () => ({ accepted: true })),
  createPanelSession: vi.fn(async (agentId: string) => ({
    accepted: true,
    created: true,
    sessionKey: `agent:${agentId}:hanako-panel:test`,
    session: {
      sessionKey: `agent:${agentId}:hanako-panel:test`,
      agentId,
      updatedAt: new Date().toISOString(),
      preview: 'New session',
      status: 'pending',
    },
  })),
  fetchGatewayAgentCatalog: vi.fn(async () => [
    { agentId: 'mon3tr', label: 'Mon3tr', workspace: undefined },
  ]),
  listCronJobs: vi.fn(async () => ({ jobs: gatewayState.jobs })),
  createCronJob: vi.fn(async (job: Record<string, unknown>) => {
    const created = {
      id: `job-${gatewayState.jobs.length + 1}`,
      enabled: true,
      ...job,
    }
    gatewayState.jobs.push(created)
    return created
  }),
  updateCronJob: vi.fn(async (jobId: string, patch: Record<string, unknown>) => {
    gatewayState.jobs = gatewayState.jobs.map((job) => (
      String(job.id) === jobId ? { ...job, ...patch } : job
    ))
    return gatewayState.jobs.find((job) => String(job.id) === jobId)
  }),
  deleteCronJob: vi.fn(async (jobId: string) => {
    gatewayState.jobs = gatewayState.jobs.filter((job) => String(job.id) !== jobId)
    return { accepted: true, jobId }
  }),
  runCronJob: vi.fn(async (jobId: string) => ({ accepted: true, jobId })),
}))

vi.mock('./gatewayClient', () => gatewayClientMock)
vi.mock('./logsService', () => ({
  getGatewayConnectionSnapshot: () => ({ source: 'gateway', connected: true, at: new Date().toISOString(), message: 'ok' }),
  getLogsStatus: () => ({ connected: true, cursor: 0, lastPollAt: new Date().toISOString(), lastError: null }),
  getLogsSnapshot: async () => ({ cursor: 0, lines: [] }),
  subscribeSubscriber: async () => undefined,
  unsubscribeSubscriber: () => undefined,
}))

describe('panel-proxy app', () => {
  let tempDir: string
  let openClawDir: string

  beforeEach(async () => {
    gatewayState.jobs = [
      {
        id: 'job-1',
        name: 'Main status ping',
        enabled: true,
        agentId: 'mon3tr',
        schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
        sessionTarget: 'main',
        sessionKey: 'agent:mon3tr:main',
        wakeMode: 'now',
        payload: { kind: 'systemEvent', text: 'Daily status check.' },
        delivery: { mode: 'none' },
      },
      {
        id: 'job-2',
        name: 'Isolated report',
        enabled: false,
        agentId: 'mon3tr',
        schedule: { kind: 'every', everyMs: 3_600_000 },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: { kind: 'agentTurn', message: 'Collect workspace summary.' },
        delivery: { mode: 'announce', channel: 'discord', to: 'ops-room' },
      },
    ]
    gatewayState.injectedMessages = []

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hanako-panel-proxy-'))
    openClawDir = path.join(tempDir, '.openclaw')
    const workspaceDir = path.join(openClawDir, 'workspace-mon3tr')
    await fs.mkdir(path.join(workspaceDir, 'nested'), { recursive: true })
    await fs.writeFile(path.join(workspaceDir, 'README.md'), '# Workspace\n', 'utf8')
    await fs.writeFile(path.join(workspaceDir, 'nested', 'note.json'), '{"ok":true}\n', 'utf8')
    await fs.writeFile(path.join(workspaceDir, 'binary.bin'), Buffer.from([0, 255, 17, 0]))
    await fs.writeFile(path.join(openClawDir, 'openclaw.json'), JSON.stringify({
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        list: [
          {
            id: 'mon3tr',
            workspace: workspaceDir,
          },
        ],
      },
    }, null, 2))
    process.env.OPENCLAW_CONFIG_DIR = openClawDir
  })

  afterEach(async () => {
    delete process.env.OPENCLAW_CONFIG_DIR
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('reads workspace tree and file content', async () => {
    const app = await createApp()
    await app.ready()

    const treeResponse = await app.inject({
      method: 'GET',
      url: '/api/workspace/mon3tr/tree',
    })
    expect(treeResponse.statusCode).toBe(200)
    const treePayload = treeResponse.json() as { ok: boolean; data: { nodes: Array<{ path: string }> } }
    expect(treePayload.ok).toBe(true)
    expect(treePayload.data.nodes.some((node) => node.path === 'README.md')).toBe(true)

    const fileResponse = await app.inject({
      method: 'GET',
      url: '/api/workspace/mon3tr/file?path=README.md',
    })
    expect(fileResponse.statusCode).toBe(200)
    const filePayload = fileResponse.json() as { ok: boolean; data: { content: string } }
    expect(filePayload.data.content).toContain('# Workspace')

    await app.close()
  })

  it('saves workspace files and blocks traversal/binary access', async () => {
    const app = await createApp()
    await app.ready()

    const saveResponse = await app.inject({
      method: 'PUT',
      url: '/api/workspace/mon3tr/file',
      payload: {
        path: 'nested/note.json',
        content: '{"ok":false,"saved":true}\n',
      },
    })
    expect(saveResponse.statusCode).toBe(200)
    const savedContent = await fs.readFile(path.join(openClawDir, 'workspace-mon3tr', 'nested', 'note.json'), 'utf8')
    expect(savedContent).toContain('"saved":true')

    const traversalResponse = await app.inject({
      method: 'GET',
      url: '/api/workspace/mon3tr/file?path=../secret.txt',
    })
    expect(traversalResponse.statusCode).toBe(400)

    const binaryResponse = await app.inject({
      method: 'GET',
      url: '/api/workspace/mon3tr/file?path=binary.bin',
    })
    expect(binaryResponse.statusCode).toBe(415)

    await app.close()
  })

  it('lists cron jobs and supports create/update/toggle/run/delete', async () => {
    const app = await createApp()
    await app.ready()

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/cron?agentId=mon3tr',
    })
    expect(listResponse.statusCode).toBe(200)
    const listPayload = listResponse.json() as { ok: boolean; data: { jobs: Array<{ id: string }> } }
    expect(listPayload.data.jobs).toHaveLength(2)

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/cron',
      payload: {
        job: {
          name: 'Created job',
          agentId: 'mon3tr',
          schedule: { kind: 'every', everyMs: 600000 },
          sessionTarget: 'main',
          sessionKey: 'agent:mon3tr:main',
          wakeMode: 'now',
          payload: { kind: 'systemEvent', text: 'hello' },
          delivery: { mode: 'none' },
        },
      },
    })
    expect(createResponse.statusCode).toBe(200)
    expect(gatewayState.jobs.some((job) => job.name === 'Created job')).toBe(true)

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: '/api/cron/job-1',
      payload: {
        patch: {
          sessionTarget: 'isolated',
          payload: { kind: 'agentTurn', message: 'Inspect logs', lightContext: true },
        },
      },
    })
    expect(updateResponse.statusCode).toBe(200)
    expect(gatewayState.jobs.find((job) => String(job.id) === 'job-1')?.sessionTarget).toBe('isolated')

    const toggleResponse = await app.inject({
      method: 'POST',
      url: '/api/cron/job-1/toggle',
      payload: { enabled: false },
    })
    expect(toggleResponse.statusCode).toBe(200)
    expect(gatewayState.jobs.find((job) => String(job.id) === 'job-1')?.enabled).toBe(false)

    const runResponse = await app.inject({
      method: 'POST',
      url: '/api/cron/job-1/run',
    })
    expect(runResponse.statusCode).toBe(200)
    expect(gatewayClientMock.runCronJob).toHaveBeenCalledWith('job-1')

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/api/cron/job-2',
    })
    expect(deleteResponse.statusCode).toBe(200)
    expect(gatewayState.jobs.some((job) => String(job.id) === 'job-2')).toBe(false)

    await app.close()
  })

  it('validates advanced cron JSON payloads for current/session/webhook fields', async () => {
    const app = await createApp()
    await app.ready()

    const validateResponse = await app.inject({
      method: 'POST',
      url: '/api/cron/validate',
      payload: {
        job: {
          name: 'Advanced',
          agentId: 'mon3tr',
          schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'Asia/Shanghai', staggerMs: 30_000 },
          sessionTarget: 'session:custom-main',
          payload: { kind: 'systemEvent', text: 'advanced event' },
          delivery: { mode: 'webhook', url: 'https://example.com/hook' },
          deleteAfterRun: true,
        },
      },
    })
    expect(validateResponse.statusCode).toBe(200)

    const invalidResponse = await app.inject({
      method: 'POST',
      url: '/api/cron/validate',
      payload: {
        patch: {
          schedule: { kind: 'at' },
        },
      },
    })
    expect(invalidResponse.statusCode).toBe(400)

    await app.close()
  })

  it('handles chat.inject commands and records injected content', async () => {
    const sentMessages: string[] = []
    await handleEnvelope({
      send: (payload: string | Buffer) => {
        sentMessages.push(String(payload))
      },
    } as unknown as WebSocket, {
      id: 'inject-1',
      type: 'cmd',
      cmd: 'chat.inject',
      payload: {
        sessionKey: 'agent:mon3tr:hanako-panel:test-session',
        message: 'File: README.md\n\nhello',
      },
    })

    expect(sentMessages).toHaveLength(1)
    const parsedAck = JSON.parse(sentMessages[0]) as { ok: boolean; action: string }
    expect(parsedAck.ok).toBe(true)
    expect(parsedAck.action).toBe('chat.inject')
    expect(gatewayState.injectedMessages[0]?.message).toContain('File: README.md')
  })
})
