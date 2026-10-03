import { type ReactNode } from 'react'
import type { ChatInputProps } from '@ui/contracts/composer'
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
      className={`ui-conversation-surface flex min-h-0 flex-1 flex-col overflow-hidden${focused ? ' ui-conversation-surface--focus' : ''}`}
      aria-label={focused ? '专注阅读' : '对话工作台'}
      role="region"
    >
      {props.focus !== undefined && <FocusModeHeader key="focus-header" {...props.focus} />}

      <div key="conversation-body" className="ui-conversation-body flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ConversationScrollArea
          scrollKey={props.scrollKey}
          contentClassName="ui-conversation-transcript ui-conversation-transcript-frame reading-prose mx-auto"
        >
          {props.content}
        </ConversationScrollArea>

        <div className="ui-conversation-composer-dock">
          <div className="ui-conversation-composer-frame">
            <ConversationComposer input={props.input} />
          </div>
        </div>
      </div>
    </section>
  )
}
