import React from 'react'
import type { LucideIcon } from 'lucide-react'

type IconButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: LucideIcon
  label: string
  size?: number
  spin?: boolean
}

function joinClassNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

export function IconButton(props: IconButtonProps) {
  const {
    icon: Icon,
    label,
    size = 18,
    spin = false,
    className,
    title,
    type = 'button',
    ...buttonProps
  } = props

  return (
    <button
      {...buttonProps}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={joinClassNames(className, 'pw-icon-only-button')}
    >
      <Icon
        aria-hidden="true"
        size={size}
        strokeWidth={1.85}
        className={joinClassNames('pw-button-icon', spin && 'is-spinning')}
      />
    </button>
  )
}
