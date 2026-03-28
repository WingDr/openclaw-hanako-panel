import React, { useEffect, useMemo, useState } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { MessageSquarePlus, Save, X } from 'lucide-react'
import { WorkspaceFileDocument } from '../../api/client'
import { IconButton } from '../../components/IconButton'

type WorkspaceEditorDialogProps = {
  open: boolean
  agentId: string
  sessionKey: string
  document: WorkspaceFileDocument | null
  onClose: () => void
  onSave: (content: string) => Promise<void>
  onInject: (content: string) => Promise<void>
}

const emptyExtensions: Extension[] = []
const workspaceEditorLayout = EditorView.theme({
  '&': {
    height: '100%',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
})

async function loadExtensionsForPath(filePath: string): Promise<Extension[]> {
  const lowerPath = filePath.toLowerCase()
  if (lowerPath.endsWith('.json') || lowerPath.endsWith('.jsonc')) {
    const [{ json }] = await Promise.all([
      import('@codemirror/lang-json'),
    ])
    return [json()]
  }

  if (lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown')) {
    const [{ markdown }] = await Promise.all([
      import('@codemirror/lang-markdown'),
    ])
    return [markdown()]
  }

  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lowerPath)) {
    const [{ javascript }] = await Promise.all([
      import('@codemirror/lang-javascript'),
    ])
    return [javascript({ jsx: lowerPath.endsWith('x'), typescript: lowerPath.includes('.ts') })]
  }

  if (lowerPath.endsWith('.css')) {
    const [{ css }] = await Promise.all([
      import('@codemirror/lang-css'),
    ])
    return [css()]
  }

  if (lowerPath.endsWith('.html') || lowerPath.endsWith('.htm')) {
    const [{ html }] = await Promise.all([
      import('@codemirror/lang-html'),
    ])
    return [html()]
  }

  if (lowerPath.endsWith('.yaml') || lowerPath.endsWith('.yml')) {
    const [{ yaml }] = await Promise.all([
      import('@codemirror/lang-yaml'),
    ])
    return [yaml()]
  }

  if (lowerPath.endsWith('.sh') || lowerPath.endsWith('.bash') || lowerPath.endsWith('.zsh')) {
    const [{ StreamLanguage }, shellModule] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell'),
    ])
    return [StreamLanguage.define(shellModule.shell)]
  }

  return emptyExtensions
}

export function WorkspaceEditorDialog(props: WorkspaceEditorDialogProps) {
  const { open, agentId, sessionKey, document, onClose, onSave, onInject } = props
  const editorRef = React.useRef<ReactCodeMirrorRef | null>(null)
  const [value, setValue] = useState('')
  const [selectionText, setSelectionText] = useState('')
  const [extensions, setExtensions] = useState<Extension[]>(emptyExtensions)
  const [pendingSave, setPendingSave] = useState(false)
  const [pendingInject, setPendingInject] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setValue(document?.content ?? '')
    setSelectionText('')
    setError(null)
  }, [document])

  useEffect(() => {
    let cancelled = false

    if (!open || !document?.path) {
      setExtensions(emptyExtensions)
      return
    }

    void loadExtensionsForPath(document.path)
      .then((nextExtensions) => {
        if (!cancelled) {
          setExtensions(nextExtensions)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExtensions(emptyExtensions)
        }
      })

    return () => {
      cancelled = true
    }
  }, [document?.path, open])

  useEffect(() => {
    if (!open) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!pendingSave) {
          void handleSave()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, pendingSave, value])

  const selectedOrWholeText = useMemo(
    () => selectionText.trim() || value,
    [selectionText, value],
  )
  const editorExtensions = useMemo(
    () => [workspaceEditorLayout, ...extensions],
    [extensions],
  )

  async function handleSave() {
    if (!document) {
      return
    }

    setPendingSave(true)
    setError(null)

    try {
      await onSave(value)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to save workspace file')
    } finally {
      setPendingSave(false)
    }
  }

  async function handleInjectSelected() {
    if (!selectedOrWholeText.trim()) {
      return
    }

    setPendingInject(true)
    setError(null)

    try {
      await onInject(selectedOrWholeText)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to inject workspace content')
    } finally {
      setPendingInject(false)
    }
  }

  if (!open || !document) {
    return null
  }

  return (
    <div className="pw-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="pw-modal pw-editor-modal" role="dialog" aria-modal="true" data-testid="workspace-editor-dialog" onClick={(event) => event.stopPropagation()}>
        <header className="pw-modal-header">
          <div>
            <p className="pw-section-kicker">Workspace Editor</p>
            <h2>{document.path}</h2>
            <p className="pw-muted-copy">
              Agent <strong>{agentId || 'unknown'}</strong> · {document.size} bytes · {sessionKey ? 'ready for chat injection' : 'no session selected'}
            </p>
          </div>
          <IconButton
            className="pw-secondary-button"
            icon={X}
            label="Close"
            onClick={onClose}
          />
        </header>

        <div className="pw-editor-shell">
          <CodeMirror
            data-testid="workspace-editor"
            ref={editorRef}
            value={value}
            height="100%"
            basicSetup={{
              autocompletion: true,
              bracketMatching: true,
              closeBrackets: true,
              highlightSelectionMatches: true,
              lineNumbers: true,
              foldGutter: true,
            }}
            extensions={editorExtensions}
            onCreateEditor={(view) => {
              if (typeof window !== 'undefined') {
                ;(window as Window & { __HANAKO_TEST_EDITORS__?: Record<string, unknown> }).__HANAKO_TEST_EDITORS__ = {
                  ...((window as Window & { __HANAKO_TEST_EDITORS__?: Record<string, unknown> }).__HANAKO_TEST_EDITORS__ ?? {}),
                  workspace: view,
                }
              }
            }}
            onChange={(nextValue) => setValue(nextValue)}
            onUpdate={(update) => {
              const ranges = update.state.selection.ranges
              const nextSelection = ranges
                .map((range) => update.state.sliceDoc(range.from, range.to))
                .join('\n')
                .trim()
              setSelectionText(nextSelection)
            }}
          />
        </div>

        {error && <div className="pw-inline-note">{error}</div>}

        <footer className="pw-modal-footer">
          <div className="pw-muted-copy">
            {selectionText.trim()
              ? `Selected ${selectionText.length} chars for injection`
              : 'No selection. Inject will use the whole file.'}
          </div>
          <div className="pw-modal-actions">
            <IconButton
              className="pw-secondary-button"
              icon={MessageSquarePlus}
              label={pendingInject ? 'Injecting workspace content into chat' : 'Add to chat'}
              onClick={() => void handleInjectSelected()}
              disabled={!sessionKey || pendingInject}
              spin={pendingInject}
            />
            <IconButton
              className="pw-primary-button"
              icon={Save}
              label={pendingSave ? 'Saving file' : 'Save file'}
              onClick={() => void handleSave()}
              disabled={pendingSave}
              spin={pendingSave}
            />
          </div>
        </footer>
      </div>
    </div>
  )
}
