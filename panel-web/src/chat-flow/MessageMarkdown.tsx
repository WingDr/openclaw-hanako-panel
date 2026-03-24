import React from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

type MessageMarkdownProps = {
  text: string
}

export function MessageMarkdown(props: MessageMarkdownProps) {
  return (
    <div className="pw-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ node: _node, ...anchorProps }) => (
            <a
              {...anchorProps}
              target="_blank"
              rel="noreferrer"
            />
          ),
          code: ({ node: _node, className, children, ...codeProps }) => {
            const value = String(children).replace(/\n$/, '')
            const isBlock = className?.includes('language-') || value.includes('\n')

            if (isBlock) {
              return (
                <pre className="pw-markdown-pre">
                  <code {...codeProps} className={className}>
                    {value}
                  </code>
                </pre>
              )
            }

            return (
              <code {...codeProps} className={className}>
                {children}
              </code>
            )
          },
        }}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  )
}
