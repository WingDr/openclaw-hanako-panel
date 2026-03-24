import React from 'react'
import type { TranscriptItem, ToolInvocation } from '../api/client'
import type { LiveChatState, PendingComposerMessage, ToolInvocationCard } from '../store'
import { MessageMarkdown } from './MessageMarkdown'

type ToolCardMeta = {
  key: string
  timestamp?: string
  defaultOpen?: boolean
  tone?: 'history' | 'live'
}

type StructuredValue = null | boolean | number | string | StructuredValue[] | { [key: string]: StructuredValue }

type StructuredDisplay = {
  kind: 'structured'
  value: StructuredValue
} | {
  kind: 'text'
  text: string
}

const TOOL_PREVIEW_LIMIT = 120

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`
}

function buildToolPreview(tool: ToolInvocation | ToolInvocationCard): string {
  const previewSource = tool.command || tool.arguments || tool.result || tool.error || 'No details yet'
  return truncateText(collapseWhitespace(previewSource), TOOL_PREVIEW_LIMIT)
}

function formatLabel(value: string): string {
  if (!value) {
    return ''
  }

  return value.charAt(0).toUpperCase() + value.slice(1)
}

function normalizeStructuredValue(value: unknown): StructuredValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeStructuredValue(entry))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeStructuredValue(entry)]),
    )
  }

  return String(value)
}

function parseStructuredDisplay(raw?: string): StructuredDisplay | null {
  const text = raw?.trim()
  if (!text) {
    return null
  }

  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object') {
      return {
        kind: 'structured',
        value: normalizeStructuredValue(parsed),
      }
    }
  } catch {
    return {
      kind: 'text',
      text,
    }
  }

  return {
    kind: 'text',
    text,
  }
}

function renderPrimitiveValue(value: null | boolean | number | string) {
  if (value === null) {
    return <span className="pw-structured-primitive is-null">null</span>
  }

  if (typeof value === 'boolean') {
    return <span className="pw-structured-primitive is-boolean">{value ? 'true' : 'false'}</span>
  }

  if (typeof value === 'number') {
    return <span className="pw-structured-primitive is-number">{String(value)}</span>
  }

  return <div className="pw-tool-text-block is-inline">{value}</div>
}

function StructuredValueView(props: { value: StructuredValue; nested?: boolean }) {
  const { nested = false, value } = props

  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'number'
    || typeof value === 'string'
  ) {
    return renderPrimitiveValue(value)
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <div className="pw-structured-empty">[]</div>
    }

    return (
      <div className={`pw-structured-grid is-array ${nested ? 'is-nested' : ''}`}>
        {value.map((entry, index) => (
          <React.Fragment key={`${index}`}>
            <div className="pw-structured-key">[{index}]</div>
            <div className="pw-structured-value">
              <StructuredValueView value={entry} nested={true} />
            </div>
          </React.Fragment>
        ))}
      </div>
    )
  }

  const entries = Object.entries(value)
  if (entries.length === 0) {
    return <div className="pw-structured-empty">{'{}'}</div>
  }

  return (
    <div className={`pw-structured-grid ${nested ? 'is-nested' : ''}`}>
      {entries.map(([key, entry]) => (
        <React.Fragment key={key}>
          <div className="pw-structured-key">{key}</div>
          <div className="pw-structured-value">
            <StructuredValueView value={entry} nested={true} />
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}

function ToolSectionContent(props: { display: StructuredDisplay }) {
  const { display } = props

  if (display.kind === 'structured') {
    return <StructuredValueView value={display.value} />
  }

  return <pre className="pw-tool-text-block">{display.text}</pre>
}

function ToolField(props: { label: string; raw: string }) {
  const display = parseStructuredDisplay(props.raw)
  if (!display) {
    return null
  }

  return (
    <div className="pw-tool-field">
      <div className="pw-tool-field-label">{props.label}</div>
      <div className="pw-tool-field-value">
        <ToolSectionContent display={display} />
      </div>
    </div>
  )
}

function ToolSection(props: { label: string; raw: string; tone?: 'default' | 'error' }) {
  const display = parseStructuredDisplay(props.raw)
  if (!display) {
    return null
  }

  return (
    <section className={`pw-tool-section ${props.tone === 'error' ? 'is-error' : ''}`}>
      <div className="pw-tool-section-label">{props.label}</div>
      <div className="pw-tool-section-body">
        <ToolSectionContent display={display} />
      </div>
    </section>
  )
}

function MessageBubble(props: {
  alignment: 'user' | 'agent'
  author: string
  timestamp: string
  text?: string
  footerItems?: string[]
  tone?: 'default' | 'system' | 'streaming'
}) {
  const footerItems = props.footerItems?.filter(Boolean) ?? []

  return (
    <div className={`pw-message-row is-${props.alignment}`}>
      <article
        className={[
          'pw-message-bubble',
          `is-${props.alignment}`,
          props.tone === 'system' ? 'is-system' : '',
          props.tone === 'streaming' ? 'is-streaming' : '',
        ].filter(Boolean).join(' ')}
      >
        <div className="pw-message-header">
          <span className="pw-message-author">{props.author}</span>
          <span className="pw-message-time">{props.timestamp}</span>
        </div>
        {props.text && (
          <div className="pw-message-text">
            <MessageMarkdown text={props.text} />
          </div>
        )}
        {footerItems.length > 0 && (
          <div className="pw-message-footer">
            {footerItems.map((item, index) => (
              <span key={`${item}-${index}`} className="pw-message-footnote">{item}</span>
            ))}
          </div>
        )}
      </article>
    </div>
  )
}

export function renderToolCard(
  tool: ToolInvocation | ToolInvocationCard,
  meta: ToolCardMeta,
) {
  const headerTimestamp = meta.timestamp || 'tool'
  const statusLabel = tool.status === 'running' ? 'Running' : tool.status === 'done' ? 'Done' : tool.status === 'error' ? 'Error' : 'Pending'
  const previewText = buildToolPreview(tool)
  const command = tool.command?.trim()
  const argumentsText = tool.arguments?.trim()
  const result = tool.result?.trim()
  const error = tool.error?.trim()
  const hasParameters = Boolean(command || argumentsText)
  const hasBody = hasParameters || Boolean(result || error)

  return (
    <div key={meta.key} className="pw-message-row is-agent">
      <article className={`pw-message-bubble is-agent pw-tool-card ${meta.tone === 'live' ? 'is-live' : ''}`}>
        <details open={meta.defaultOpen} className="pw-tool-details">
          <summary className="pw-tool-summary">
            <div className="pw-tool-summary-main">
              <span className={`pw-tool-status-pill is-${tool.status}`}>
                <span className="pw-tool-status-dot" aria-hidden="true" />
                <span>{statusLabel}</span>
              </span>
              <span className="pw-tool-summary-name">{tool.toolName}</span>
              <span className="pw-tool-summary-preview">{previewText}</span>
            </div>
            <div className="pw-tool-summary-side">
              <span className="pw-tool-summary-time">{tool.status === 'running' ? 'Running' : headerTimestamp}</span>
              <span className="pw-tool-summary-caret" aria-hidden="true" />
            </div>
          </summary>
          {hasBody && (
            <div className="pw-tool-body">
              {hasParameters && (
                <section className="pw-tool-section">
                  <div className="pw-tool-section-label">Parameters</div>
                  <div className="pw-tool-fields">
                    {command && <ToolField label="Command" raw={command} />}
                    {argumentsText && <ToolField label="Arguments" raw={argumentsText} />}
                  </div>
                </section>
              )}
              {result && <ToolSection label="Result" raw={result} />}
              {error && <ToolSection label="Error" raw={error} tone="error" />}
            </div>
          )}
        </details>
      </article>
    </div>
  )
}

export function renderTranscriptItem(item: TranscriptItem, agentName?: string) {
  if (item.kind === 'tool' && item.toolInvocation) {
    return renderToolCard(item.toolInvocation, {
      key: item.messageId,
      timestamp: item.timestamp,
      defaultOpen: false,
      tone: 'history',
    })
  }

  const isUser = item.kind === 'user'
  const isSystem = item.kind === 'system' || item.kind === 'error'
  const footerItems = item.status === 'error' || item.status === 'aborted'
    ? [formatLabel(item.status)]
    : []

  return (
    <MessageBubble
      key={item.messageId}
      alignment={isUser ? 'user' : 'agent'}
      author={isUser ? 'You' : isSystem ? 'System' : agentName || 'Agent'}
      timestamp={item.timestamp}
      text={item.text}
      footerItems={footerItems}
      tone={isSystem ? 'system' : 'default'}
    />
  )
}

export function renderPendingComposerMessage(message: PendingComposerMessage) {
  return (
    <MessageBubble
      key={message.id}
      alignment="user"
      author="You"
      timestamp={message.timestamp}
      text={message.text}
      footerItems={[formatLabel(message.status), message.error || ''].filter(Boolean)}
    />
  )
}

export function renderLiveChat(
  liveChat: LiveChatState,
  agentName?: string,
  options?: { key?: string; text?: string; allowEmpty?: boolean },
) {
  const text = options?.text ?? liveChat.text
  if (!options?.allowEmpty && !text.trim()) {
    return null
  }

  return (
    <MessageBubble
      key={options?.key ?? `live:${liveChat.sessionId}`}
      alignment="agent"
      author={agentName || 'Agent'}
      timestamp={new Date(liveChat.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      text={text || '...'}
      footerItems={['Streaming']}
      tone="streaming"
    />
  )
}
