import { useState } from 'react'
import type { ChatInputProps } from '../../../../contracts/composer'
import type { PersonalWorkspaceProjection } from '../../../workspace'
import { ConversationComposer } from './ConversationComposer'
import { HomeAmbientCopy } from './HomeAmbientCopy'
import {
  homeAmbientCopyIdentity,
  type HomeAmbientCopyMemory,
  selectHomeAmbientCopy,
} from './home-ambient-copy'
import { HomeBackdrop } from './HomeBackdrop'
import { type HomeOwnerSelection, HomeOwnerPicker } from './HomeOwnerPicker'
import { panelStorageKey } from '../../../../app-local-preferences'
import './home-page.css'

const AMBIENT_COPY_MEMORY_KEY = panelStorageKey('home.ambient-copy-memory')

function readAmbientCopyMemory(): HomeAmbientCopyMemory | undefined {
  if (typeof window === 'undefined') return undefined
  const raw = window.localStorage.getItem(AMBIENT_COPY_MEMORY_KEY)
  if (raw === null) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<HomeAmbientCopyMemory>
    if (typeof parsed.key === 'string' && typeof parsed.copy === 'string') {
      return { key: parsed.key, copy: parsed.copy }
    }
  } catch {
    // 损坏的记忆直接忽略，重新选择
  }
  return undefined
}

function rememberAmbientCopyMemory(memory: HomeAmbientCopyMemory): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(AMBIENT_COPY_MEMORY_KEY, JSON.stringify(memory))
}

interface HomePageProps {
  spaces?: readonly { readonly spaceId: string; readonly title: string }[]
  workspaces?: readonly PersonalWorkspaceProjection[]
  ownerSelection?: HomeOwnerSelection | null
  onOwnerChange?: (owner: HomeOwnerSelection | null) => void
  input: ChatInputProps
  focusRequest: number
}

export function HomePage({
  spaces = [],
  workspaces = [],
  ownerSelection = null,
  onOwnerChange,
  input,
  focusRequest,
}: HomePageProps) {
  const [ambientCopy] = useState(() => {
    const selection = selectHomeAmbientCopy(new Date(), readAmbientCopyMemory())
    rememberAmbientCopyMemory({ key: selection.key, copy: homeAmbientCopyIdentity(selection.copy) })
    return selection.copy
  })
  const [compositionBaseValue, setCompositionBaseValue] = useState<string | null>(null)
  const ambientDraftValue = compositionBaseValue ?? input.value
  const hasDraft = ambientDraftValue.trim().length > 0
  const homeInput = input.contextUsage === undefined
    ? input
    : { ...input, contextUsage: undefined }

  const handleCompositionChange = (composing: boolean): void => {
    setCompositionBaseValue(composing ? input.value : null)
  }

  return (
    <div className="aa-agent-home">
      <HomeBackdrop />
      <section className="aa-agent-home__stage" aria-label="开始任务">
        <div className="aa-agent-home__field">
          <HomeAmbientCopy copy={ambientCopy} hasDraft={hasDraft} />

          <div className="aa-agent-home__composer">
            <ConversationComposer
              key={focusRequest}
              input={homeInput}
              onCompositionChange={handleCompositionChange}
            />
          </div>

          <div className="aa-agent-home__context">
            <HomeOwnerPicker
              spaces={spaces}
              workspaces={workspaces}
              value={ownerSelection}
              onChange={(owner) => onOwnerChange?.(owner)}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
