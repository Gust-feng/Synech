import { type ReactNode } from 'react'
import type { ChatInputProps } from '../../../../contracts/composer'
import { ConversationComposer } from './ConversationComposer'
import { ConversationScrollArea } from './ConversationScrollArea'
import { FocusModeHeader, type FocusModeHeaderProps } from './FocusMode'
import './conversation-page.css'

export interface ConversationPageProps {
  readonly scrollKey: string
  readonly content?: ReactNode
  readonly input: ChatInputProps
  readonly focus?: FocusModeHeaderProps
}

export function ConversationPage(props: ConversationPageProps) {
  const focused = props.focus !== undefined

  return (
    <section
      className={`aa-conversation-surface flex min-h-0 flex-1 flex-col overflow-hidden${focused ? ' aa-conversation-surface--focus' : ''}`}
      aria-label={focused ? '专注阅读' : '对话工作台'}
      role="region"
    >
      {props.focus !== undefined && <FocusModeHeader key="focus-header" {...props.focus} />}

      <div key="conversation-body" className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ConversationScrollArea
          scrollKey={props.scrollKey}
          contentClassName="aa-conversation-transcript reading-prose mx-auto px-6 pb-24 pt-8"
        >
          {props.content}
        </ConversationScrollArea>

        <div className="shrink-0 px-6 pb-3">
          <div className="aa-conversation-composer-frame mx-auto" style={{ maxWidth: 'var(--reading-width)' }}>
            <ConversationComposer input={props.input} />
          </div>
        </div>
      </div>
    </section>
  )
}