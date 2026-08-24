import { useEffect, useState } from 'react'
import { CornerUpLeft, Link2, Plus, Trash2, X } from 'lucide-react'
import { MarkdownDocumentSurface } from '../MarkdownDocumentSurface'
import { getNote } from '../notesStore'
import { useBrain, type ResolvedPage } from '../brainStore'
import { knowledgePageIcon } from '../knowledge-view-projection'
import { ReferencePreview } from '../ReferencePreview'

export function KnowledgeReader({
  page,
  resolved,
  brain,
  onBack,
  onOpen,
}: {
  page: ResolvedPage
  resolved: ResolvedPage[]
  brain: ReturnType<typeof useBrain>
  onBack: () => void
  onOpen: (id: string) => void
}) {
  const [linkPickerOpen, setLinkPickerOpen] = useState(false)
  const outIds = brain.outgoing(page.refId)
  const backIds = brain.backlinks(page.refId)
  const linkableTargets = resolved.filter((p) => p.refId !== page.refId && !outIds.includes(p.refId))

  return (
    <section className="flex flex-1 overflow-hidden" style={{ minHeight: 0 }}>
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* 路径面包屑(知识库 › 文件)已上移到顶栏;这里只留内容操作。 */}
        <header className="shrink-0 flex items-center gap-2 px-5" style={{ height: 44 }}>
          <div className="flex-1" />
          <button
            onClick={() => {
              brain.uncollect(page.refId)
              onBack()
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--ui-hover-tint)]"
            style={{ color: 'var(--ui-text-3, #aba39b)' }}
          >
            <Trash2 size={12} />
            移出
          </button>
        </header>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          <KnowledgePageContent page={page} />
        </div>
      </div>

      {/* 右:链接 + 反向链接(透镜) */}
      <div
        className="shrink-0 flex flex-col overflow-y-auto"
        style={{ width: 256, borderLeft: '1px solid var(--ui-border, rgba(45,40,34,0.09))' }}
      >
        <div className="px-4 py-4">
          <SectionHead icon={<CornerUpLeft size={12} />} label="反向链接" count={backIds.length} />
          {backIds.length === 0 ? (
            <p className="text-xs mb-5" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
              还没有页面链到这里。
            </p>
          ) : (
            <div className="space-y-1 mb-5">
              {backIds.map((id) => {
                const rp = resolved.find((p) => p.refId === id)
                if (!rp) return null
                return <LinkChip key={id} page={rp} onClick={() => onOpen(id)} />
              })}
            </div>
          )}

          <SectionHead icon={<Link2 size={12} />} label="链接到" count={outIds.length} />
          <div className="space-y-1">
            {outIds.map((id) => {
              const rp = resolved.find((p) => p.refId === id)
              if (!rp) return null
              return (
                <LinkChip
                  key={id}
                  page={rp}
                  onClick={() => onOpen(id)}
                  onRemove={() => brain.removeLink(page.refId, id)}
                />
              )
            })}
          </div>

          {linkPickerOpen ? (
            <div className="mt-2 rounded-md p-1" style={{ border: '1px solid var(--ui-border, rgba(45,40,34,0.09))' }}>
              <div className="flex items-center justify-between px-1.5 py-1">
                <span className="text-xs" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
                  链接到…
                </span>
                <button onClick={() => setLinkPickerOpen(false)} style={{ color: 'var(--ui-text-3, #aba39b)' }}>
                  <X size={12} />
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {linkableTargets.length === 0 ? (
                  <p className="px-1.5 py-2 text-xs" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
                    没有可链接的其它页面。
                  </p>
                ) : (
                  linkableTargets.map((p) => (
                    <button
                      key={p.refId}
                      onClick={() => {
                        brain.addLink(page.refId, p.refId)
                        setLinkPickerOpen(false)
                      }}
                      className="w-full flex items-center gap-2 px-1.5 py-1.5 rounded text-left text-xs transition-colors hover:bg-[var(--ui-hover-tint)]"
                      style={{ color: 'var(--ui-text-1, #292722)' }}
                    >
                      {knowledgePageIcon(p, 12)}
                      <span className="flex-1 truncate">{p.title}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
            <button
              onClick={() => setLinkPickerOpen(true)}
              className="mt-2 w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--ui-hover-tint)]"
              style={{ color: 'var(--ui-accent, #6865a7)' }}
            >
              <Plus size={12} />
              建立链接
            </button>
          )}
        </div>
      </div>
    </section>
  )
}


export function KnowledgePageContent({
  page,
}: {
  page: ResolvedPage
}) {
  const [documentPath, setDocumentPath] = useState('')
  useEffect(() => {
    setDocumentPath('')
  }, [page.refId])
  const navigateDocumentPath = (relativePath: string) => {
    setDocumentPath(relativePath)
  }
  if (!page.exists) {
    return (
      <div
        className="h-full w-full overflow-y-auto px-6 py-10 text-sm"
        style={{ maxWidth: 'var(--reading-width, 680px)', color: 'var(--ui-text-3, #aba39b)' }}
      >
        这个对象已不存在(可能已被删除)。可以把它移出知识库。
      </div>
    )
  }
  if (page.kind === 'note') {
    const note = getNote(page.refId)!
    return (
      <div className="h-full w-full overflow-y-auto">
        <div className="mx-auto px-6 py-10 reading-prose" style={{ maxWidth: 'var(--reading-width, 680px)' }}>
          {note.bodyMarkdown.trim() ? (
            <MarkdownDocumentSurface markdown={note.bodyMarkdown} sourceVersion={`${note.id}:${note.updatedAt}`} />
          ) : (
            <p className="text-sm" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
              这篇笔记还没有内容。
            </p>
          )}
        </div>
      </div>
    )
  }
  if (page.documentTarget === undefined) return null
  return (
    <ReferencePreview
      itemId={page.refId}
      fallbackTitle={page.title}
      canOpen={false}
      onOpen={() => undefined}
      apiBase={page.documentTarget.apiBase}
      initialRelativePath={documentPath}
      onNavigatePath={navigateDocumentPath}
      embedded
    />
  )
}


function SectionHead({ icon, label, count }: { icon: React.ReactNode; label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 mb-2" style={{ color: 'var(--ui-text-2, #87827c)' }}>
      {icon}
      <span className="text-xs font-medium">{label}</span>
      <span className="text-xs" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
        {count}
      </span>
    </div>
  )
}

function LinkChip({ page, onClick, onRemove }: { page: ResolvedPage; onClick: () => void; onRemove?: () => void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors"
      style={{ background: hovered ? 'var(--ui-surface-hover, #eeebe6)' : 'transparent' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      {knowledgePageIcon(page, 12)}
      <span className="flex-1 text-xs truncate" style={{ color: 'var(--ui-text-1, #292722)' }}>
        {page.title}
      </span>
      {onRemove && hovered && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          style={{ color: 'var(--ui-text-3, #aba39b)' }}
        >
          <X size={11} />
        </button>
      )}
    </div>
  )
}
