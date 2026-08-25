export interface Note {
  id: string
  spaceId?: string
  title: string
  bodyMarkdown: string
  createdAt: number
  updatedAt: number
  revision: number
}

export type PageKind = 'note' | 'space_reference'

export interface BrainPage {
  refId: string
  kind: PageKind
  collectedAt: number
  asset?: {
    status: 'managed'
    title: string
    sourceLabel: string
    contentKind: 'file' | 'directory'
    sourceReferenceId?: string
    sourceRelativePath?: string
  }
}

export interface BrainLink {
  from: string
  to: string
}

export interface Theme {
  id: string
  name: string
  color: string
  origin: 'agent' | 'user'
}

export interface Assignment {
  refId: string
  themeId: string
  by: 'agent' | 'user'
  locked: boolean
}
