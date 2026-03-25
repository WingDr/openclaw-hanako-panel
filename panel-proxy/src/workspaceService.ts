import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fetchGatewayAgentCatalog } from './gatewayClient'

const defaultOpenClawConfigDir = path.join(os.homedir(), '.openclaw')
const defaultMaxEditableFileBytes = 512 * 1024
const treeNodeBudget = 2_000
const binaryProbeBytes = 4_096

export type WorkspaceTreeNode = {
  id: string
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
  updatedAt?: string
  children?: WorkspaceTreeNode[]
}

export type WorkspaceTreeSnapshot = {
  agentId: string
  rootPath: string
  path: string
  nodes: WorkspaceTreeNode[]
  truncated: boolean
}

export type WorkspaceFileDocument = {
  agentId: string
  rootPath: string
  path: string
  content: string
  size: number
  updatedAt: string
}

export class WorkspaceServiceError extends Error {
  readonly code: string
  readonly statusCode: number

  constructor(code: string, message: string, statusCode = 400) {
    super(message)
    this.name = 'WorkspaceServiceError'
    this.code = code
    this.statusCode = statusCode
  }
}

type OpenClawAgentConfig = {
  id?: string
  workspace?: string
}

type OpenClawConfig = {
  agents?: {
    defaults?: {
      workspace?: string
    }
    list?: OpenClawAgentConfig[]
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
)

const asString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
)

const toPosixPath = (value: string): string => value.split(path.sep).join('/')

const fromPosixPath = (value: string): string => value.split('/').join(path.sep)

const getOpenClawConfigDir = (): string => {
  const configured = process.env.OPENCLAW_CONFIG_DIR?.trim()
  return configured || defaultOpenClawConfigDir
}

async function readOpenClawConfig(): Promise<OpenClawConfig | null> {
  const configPath = path.join(getOpenClawConfigDir(), 'openclaw.json')
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    return JSON.parse(raw) as OpenClawConfig
  } catch {
    return null
  }
}

async function resolveExistingDirectory(candidate: string | undefined): Promise<string | undefined> {
  if (!candidate) {
    return undefined
  }

  const resolved = path.resolve(candidate)

  try {
    const stats = await fs.stat(resolved)
    return stats.isDirectory() ? resolved : undefined
  } catch {
    return undefined
  }
}

async function resolveAgentWorkspaceRoot(agentId: string): Promise<string> {
  try {
    const gatewayAgents = await fetchGatewayAgentCatalog()
    const gatewayMatch = gatewayAgents.find((agent) => agent.agentId === agentId)
    const gatewayWorkspace = await resolveExistingDirectory(gatewayMatch?.workspace)
    if (gatewayWorkspace) {
      return gatewayWorkspace
    }
  } catch {
  }

  const config = await readOpenClawConfig()
  const configuredAgents = Array.isArray(config?.agents?.list) ? config?.agents?.list ?? [] : []
  const configMatch = configuredAgents.find((agent) => agent.id === agentId)
  const configWorkspace = await resolveExistingDirectory(configMatch?.workspace)
  if (configWorkspace) {
    return configWorkspace
  }

  const defaultWorkspace = await resolveExistingDirectory(config?.agents?.defaults?.workspace)
  if (defaultWorkspace) {
    return defaultWorkspace
  }

  throw new WorkspaceServiceError(
    'workspace_not_found',
    `Unable to resolve workspace root for agent "${agentId}"`,
    404,
  )
}

function resolveWorkspacePath(rootPath: string, requestedPath = ''): { absolutePath: string; relativePath: string } {
  const normalizedPath = requestedPath.trim().replace(/^\/+/, '')
  const relativePath = normalizedPath ? fromPosixPath(normalizedPath) : ''
  const absolutePath = path.resolve(rootPath, relativePath)
  const relativeToRoot = path.relative(rootPath, absolutePath)

  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new WorkspaceServiceError('workspace_path_invalid', 'Requested path is outside the workspace root', 400)
  }

  return {
    absolutePath,
    relativePath: relativeToRoot ? toPosixPath(relativeToRoot) : '',
  }
}

async function detectBinaryFile(filePath: string, size: number): Promise<boolean> {
  if (size === 0) {
    return false
  }

  const handle = await fs.open(filePath, 'r')
  try {
    const probeLength = Math.min(size, binaryProbeBytes)
    const buffer = Buffer.alloc(probeLength)
    const { bytesRead } = await handle.read(buffer, 0, probeLength, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

async function readDirectoryTree(
  rootPath: string,
  currentRelativePath: string,
  budget: { remaining: number; truncated: boolean },
): Promise<WorkspaceTreeNode[]> {
  const { absolutePath } = resolveWorkspacePath(rootPath, currentRelativePath)
  const entries = await fs.readdir(absolutePath, { withFileTypes: true })
  const sortedEntries = entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) {
      return left.isDirectory() ? -1 : 1
    }

    return left.name.localeCompare(right.name)
  })

  const nodes: WorkspaceTreeNode[] = []
  for (const entry of sortedEntries) {
    if (budget.remaining <= 0) {
      budget.truncated = true
      break
    }

    const nextRelativePath = currentRelativePath
      ? toPosixPath(path.join(fromPosixPath(currentRelativePath), entry.name))
      : entry.name
    const entryAbsolutePath = path.join(absolutePath, entry.name)
    const stats = await fs.stat(entryAbsolutePath)

    budget.remaining -= 1

    if (entry.isDirectory()) {
      const children = await readDirectoryTree(rootPath, nextRelativePath, budget)
      nodes.push({
        id: nextRelativePath,
        name: entry.name,
        path: nextRelativePath,
        kind: 'directory',
        updatedAt: stats.mtime.toISOString(),
        children,
      })
      continue
    }

    nodes.push({
      id: nextRelativePath,
      name: entry.name,
      path: nextRelativePath,
      kind: 'file',
      size: stats.size,
      updatedAt: stats.mtime.toISOString(),
    })
  }

  return nodes
}

export async function getWorkspaceTree(agentId: string, requestedPath = ''): Promise<WorkspaceTreeSnapshot> {
  const rootPath = await resolveAgentWorkspaceRoot(agentId)
  const { absolutePath, relativePath } = resolveWorkspacePath(rootPath, requestedPath)

  let stats
  try {
    stats = await fs.stat(absolutePath)
  } catch {
    throw new WorkspaceServiceError('workspace_path_missing', `Workspace path "${requestedPath}" does not exist`, 404)
  }

  if (!stats.isDirectory()) {
    throw new WorkspaceServiceError('workspace_not_directory', 'Requested workspace path is not a directory', 400)
  }

  const budget = { remaining: treeNodeBudget, truncated: false }
  const nodes = await readDirectoryTree(rootPath, relativePath, budget)

  return {
    agentId,
    rootPath,
    path: relativePath,
    nodes,
    truncated: budget.truncated,
  }
}

export async function readWorkspaceFile(agentId: string, requestedPath: string): Promise<WorkspaceFileDocument> {
  const rootPath = await resolveAgentWorkspaceRoot(agentId)
  const { absolutePath, relativePath } = resolveWorkspacePath(rootPath, requestedPath)

  let stats
  try {
    stats = await fs.stat(absolutePath)
  } catch {
    throw new WorkspaceServiceError('workspace_file_missing', `File "${requestedPath}" does not exist`, 404)
  }

  if (!stats.isFile()) {
    throw new WorkspaceServiceError('workspace_not_file', 'Requested path is not a file', 400)
  }

  if (stats.size > defaultMaxEditableFileBytes) {
    throw new WorkspaceServiceError(
      'workspace_file_too_large',
      `File exceeds ${defaultMaxEditableFileBytes} bytes and cannot be edited in-panel`,
      413,
    )
  }

  if (await detectBinaryFile(absolutePath, stats.size)) {
    throw new WorkspaceServiceError('workspace_file_binary', 'Binary files cannot be edited in-panel', 415)
  }

  const content = await fs.readFile(absolutePath, 'utf8')

  return {
    agentId,
    rootPath,
    path: relativePath,
    content,
    size: stats.size,
    updatedAt: stats.mtime.toISOString(),
  }
}

export async function writeWorkspaceFile(agentId: string, requestedPath: string, content: string): Promise<WorkspaceFileDocument> {
  const rootPath = await resolveAgentWorkspaceRoot(agentId)
  const { absolutePath, relativePath } = resolveWorkspacePath(rootPath, requestedPath)

  let stats
  try {
    stats = await fs.stat(absolutePath)
  } catch {
    throw new WorkspaceServiceError('workspace_file_missing', `File "${requestedPath}" does not exist`, 404)
  }

  if (!stats.isFile()) {
    throw new WorkspaceServiceError('workspace_not_file', 'Requested path is not a file', 400)
  }

  if (await detectBinaryFile(absolutePath, stats.size)) {
    throw new WorkspaceServiceError('workspace_file_binary', 'Binary files cannot be edited in-panel', 415)
  }

  const nextContent = typeof content === 'string' ? content : ''
  const nextSize = Buffer.byteLength(nextContent, 'utf8')
  if (nextSize > defaultMaxEditableFileBytes) {
    throw new WorkspaceServiceError(
      'workspace_file_too_large',
      `Edited content exceeds ${defaultMaxEditableFileBytes} bytes`,
      413,
    )
  }

  await fs.writeFile(absolutePath, nextContent, 'utf8')
  const nextStats = await fs.stat(absolutePath)

  return {
    agentId,
    rootPath,
    path: relativePath,
    content: nextContent,
    size: nextStats.size,
    updatedAt: nextStats.mtime.toISOString(),
  }
}
