import React, { useEffect, useMemo, useState } from 'react'
import {
  ControlledTreeEnvironment,
  Tree,
  type TreeItem,
} from 'react-complex-tree'
import {
  fetchChatHistory,
  fetchWorkspaceFile,
  fetchWorkspaceTree,
  saveWorkspaceFile,
  type WorkspaceFileDocument,
  type WorkspaceTreeNode,
} from '../../api/client'
import { panelRealtime } from '../../realtime/ws'
import { useChatStore } from '../../store'
import { WorkspaceEditorDialog } from './WorkspaceEditorDialog'

type WorkspacePanelModuleProps = {
  agentId: string
  sessionKey: string
}

type TreeItemMap = Record<string, TreeItem<string>>

function flattenTree(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
  return nodes.flatMap((node) => [node, ...(node.children ? flattenTree(node.children) : [])])
}

function buildTreeItems(nodes: WorkspaceTreeNode[]): TreeItemMap {
  const items: TreeItemMap = {
    root: {
      index: 'root',
      data: 'Workspace',
      isFolder: true,
      canMove: false,
      canRename: false,
      children: nodes.map((node) => node.id),
    },
  }

  const visit = (node: WorkspaceTreeNode) => {
    items[node.id] = {
      index: node.id,
      data: node.name,
      isFolder: node.kind === 'directory',
      canMove: false,
      canRename: false,
      children: node.children?.map((child) => child.id),
    }

    node.children?.forEach(visit)
  }

  nodes.forEach(visit)
  return items
}

function buildWorkspaceInjectionMessage(path: string, content: string): string {
  return `File: ${path}\n\n${content}`
}

function getWorkspaceName(rootPath: string): string {
  const normalizedPath = rootPath.trim().replace(/[\\/]+$/, '')
  if (!normalizedPath) {
    return 'Workspace'
  }

  const segments = normalizedPath.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] || normalizedPath
}

export function WorkspacePanelModule(props: WorkspacePanelModuleProps) {
  const { agentId, sessionKey } = props
  const setSessionHistory = useChatStore((state) => state.setSessionHistory)
  const [treeNodes, setTreeNodes] = useState<WorkspaceTreeNode[]>([])
  const [rootPath, setRootPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [expandedItems, setExpandedItems] = useState<string[]>([])
  const [activeDocument, setActiveDocument] = useState<WorkspaceFileDocument | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    void fetchWorkspaceTree(agentId)
      .then((snapshot) => {
        if (cancelled) {
          return
        }

        setTreeNodes(snapshot.nodes)
        setRootPath(snapshot.rootPath)
        setSelectedPath((current) => current || snapshot.nodes[0]?.id || '')
        setExpandedItems(['root', ...snapshot.nodes.filter((node) => node.kind === 'directory').slice(0, 4).map((node) => node.id)])
        setError(null)
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : 'Failed to load workspace tree')
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

  const flatNodes = useMemo(() => flattenTree(treeNodes), [treeNodes])
  const treeItems = useMemo(() => buildTreeItems(treeNodes), [treeNodes])
  const workspaceName = useMemo(() => getWorkspaceName(rootPath), [rootPath])
  const selectedNode = flatNodes.find((node) => node.id === selectedPath)
  const searchResults = useMemo(() => {
    if (!query.trim()) {
      return []
    }

    const normalizedQuery = query.trim().toLowerCase()
    return flatNodes.filter((node) => (
      `${node.name} ${node.path}`.toLowerCase().includes(normalizedQuery)
    ))
  }, [flatNodes, query])

  const openFile = async (requestedPath: string) => {
    try {
      const document = await fetchWorkspaceFile(agentId, requestedPath)
      setActiveDocument(document)
      setEditorOpen(true)
      setError(null)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to open workspace file')
    }
  }

  const refreshHistoryAfterInjection = async () => {
    if (!sessionKey) {
      return
    }

    const messages = await fetchChatHistory(sessionKey)
    setSessionHistory(sessionKey, messages)
  }

  const injectWorkspaceContent = async (path: string, content: string) => {
    if (!sessionKey) {
      throw new Error('Select a session before adding workspace context to chat')
    }

    await panelRealtime.sendCommand('chat.inject', {
      sessionKey,
      message: buildWorkspaceInjectionMessage(path, content),
      source: {
        kind: 'workspace-file',
        agentId,
        path,
      },
    })

    await refreshHistoryAfterInjection()
  }

  const openSelectedFile = async () => {
    if (!selectedNode || selectedNode.kind !== 'file') {
      return
    }

    await openFile(selectedNode.path)
  }

  const injectSelectedFile = async () => {
    if (!selectedNode || selectedNode.kind !== 'file') {
      return
    }

    const document = await fetchWorkspaceFile(agentId, selectedNode.path)
    await injectWorkspaceContent(document.path, document.content)
  }

  return (
    <section className="pw-right-rail-panel">
      <header className="pw-right-rail-panel-header">
        <div>
          <p className="pw-section-kicker">Workspace</p>
          <h2>{workspaceName}</h2>
        </div>
        <button className="pw-secondary-button" type="button" onClick={() => setRefreshToken((value) => value + 1)}>
          Refresh
        </button>
      </header>

      <div className="pw-right-rail-toolbar">
        <input
          className="pw-rail-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search paths"
        />
      </div>

      {error && <div className="pw-inline-note">{error}</div>}

      <div className="pw-right-rail-body">
        {loading && <div className="pw-empty-state small">Loading workspace...</div>}
        {!loading && query.trim() && (
          <div className="pw-rail-search-results">
            {searchResults.length === 0 && <div className="pw-empty-state small">No files match the current search.</div>}
            {searchResults.map((node) => (
              <button
                key={node.id}
                className={`pw-rail-list-row ${node.id === selectedPath ? 'is-active' : ''}`}
                onClick={() => {
                  setSelectedPath(node.id)
                  if (node.kind === 'file') {
                    void openFile(node.path)
                  }
                }}
              >
                <span className="pw-rail-list-title">{node.name}</span>
                <span className="pw-rail-list-meta">{node.path}</span>
              </button>
            ))}
          </div>
        )}

        {!loading && !query.trim() && (
          <div className="pw-tree-shell">
            <ControlledTreeEnvironment
              items={treeItems}
              getItemTitle={(item) => item.data}
              viewState={{
                'workspace-tree': {
                  expandedItems,
                  selectedItems: selectedPath ? [selectedPath] : [],
                },
              }}
              onExpandItem={(item) => setExpandedItems((current) => current.includes(String(item.index)) ? current : [...current, String(item.index)])}
              onCollapseItem={(item) => setExpandedItems((current) => current.filter((entry) => entry !== String(item.index)))}
              onSelectItems={(items) => setSelectedPath(String(items[0] ?? ''))}
              canDragAndDrop={false}
              canDropOnFolder={false}
              canReorderItems={false}
            >
              <Tree treeId="workspace-tree" rootItem="root" treeLabel="Agent workspace tree" />
            </ControlledTreeEnvironment>
          </div>
        )}
      </div>

      <footer className="pw-right-rail-footer is-actions-only">
        <div className="pw-right-rail-actions">
          <button
            className="pw-secondary-button"
            type="button"
            data-testid="workspace-add-to-chat"
            onClick={() => void injectSelectedFile()}
            disabled={!selectedNode || selectedNode.kind !== 'file' || !sessionKey}
          >
            Add to chat
          </button>
          <button
            className="pw-primary-button"
            type="button"
            data-testid="workspace-open-file"
            onClick={() => void openSelectedFile()}
            disabled={!selectedNode || selectedNode.kind !== 'file'}
          >
            Open file
          </button>
        </div>
      </footer>

      <WorkspaceEditorDialog
        open={editorOpen}
        agentId={agentId}
        sessionKey={sessionKey}
        document={activeDocument}
        onClose={() => setEditorOpen(false)}
        onSave={async (content) => {
          if (!activeDocument) {
            return
          }

          const nextDocument = await saveWorkspaceFile(agentId, activeDocument.path, content)
          setActiveDocument(nextDocument)
          setRefreshToken((value) => value + 1)
        }}
        onInject={async (content) => {
          if (!activeDocument) {
            return
          }

          await injectWorkspaceContent(activeDocument.path, content)
        }}
      />
    </section>
  )
}
