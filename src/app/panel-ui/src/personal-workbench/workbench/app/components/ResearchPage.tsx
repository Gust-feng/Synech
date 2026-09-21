import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  Compass,
  Copy,
  Download,
  ExternalLink,
  FileSearch,
  FileText,
  Globe,
  ListChecks,
  ListFilter,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Settings,
  Sparkles,
  Square,
  X,
} from 'lucide-react'

import type {
  ResearchCoverageView,
  ResearchSourceView,
  ResearchStageView,
  ResearchTaskDetailView,
} from '@panel-api/research'
import { RichText } from '@ui/components/rich-text'
import { useResearch } from '../../../../features/research/use-research'
import { fetchResearchSourceContent } from '../../../../features/research/research-client'
import { WorkbenchExplorer } from './WorkbenchExplorer'
import type { SettingsGroup } from '../../../../features/settings/components/types'
import './research-page.css'

interface ResearchPageProps {
  readonly explorerCollapsed?: boolean
  readonly onOpenSettings?: (group?: SettingsGroup) => void
  readonly onNavigate?: (view: 'home' | 'space' | 'workspace' | 'search' | 'brain' | 'research') => void
}

const STAGES: readonly { readonly key: ResearchStageView; readonly label: string }[] = [
  { key: 'planning', label: '拆解问题' },
  { key: 'searching', label: '联网检索' },
  { key: 'reading', label: '阅读正文' },
  { key: 'analyzing', label: '判断覆盖' },
  { key: 'writing', label: '撰写报告' },
]

const STAGE_INDEX_MAP: Record<ResearchStageView, number> = {
  planning: 0,
  searching: 1,
  reading: 2,
  analyzing: 3,
  writing: 4,
}

const COVERAGE_LABELS: Record<ResearchCoverageView, string> = {
  supported: '已证实',
  partial: '部分依据',
  contested: '存有争议',
  unanswered: '缺口待查',
}

const COVERAGE_COLORS: Record<ResearchCoverageView, string> = {
  supported: 'var(--ui-status-success, #4A8A6A)',
  partial: 'var(--ui-status-warning, #B08A3E)',
  contested: 'var(--ui-status-warning, #B08A3E)',
  unanswered: 'var(--ui-text-3, #aba39b)',
}

const SEED_TOPICS: readonly string[] = [
  '家用 NAS 的实际维护负担有多大？',
  '长上下文与 RAG 在知识问答中的优劣对比',
  '新能源汽车冬季续航的衰减原因与应对策略',
  '本地部署大模型在 2026 年的硬件门槛与取舍',
]

/**
 * 深度研究 · 交互式探针视界画布 (ResearchFocalCanvas)
 * 借鉴高定测量仪器与等深线（Bathymetric Contours）美学
 * 随着鼠标位置与输入聚焦状态，呈现克制微动的深度探针波纹与聚焦引力场
 */
function ResearchFocalCanvas({ focused }: { focused: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const focusRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animationId: number
    let phase = 0

    const render = () => {
      const dpr = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      const height = canvas.clientHeight

      if (width === 0 || height === 0) {
        animationId = requestAnimationFrame(render)
        return
      }

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr
        canvas.height = height * dpr
      }

      ctx.save()
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, width, height)

      const targetFocus = focused ? 1 : 0
      focusRef.current += (targetFocus - focusRef.current) * 0.08
      const currentFocus = focusRef.current

      phase += 0.015

      // 居中呈现，不随鼠标偏移，保持安稳专注的学术仪态
      const centerX = width / 2
      const centerY = height / 2

      const isDark = document.documentElement.getAttribute('data-color') === 'dark'
      const baseR = isDark ? 168 : 104
      const baseG = isDark ? 162 : 101
      const baseB = isDark ? 192 : 167

      const RING_COUNT = 14
      const maxRadiusX = width * 0.44
      const maxRadiusY = height * 0.42

      for (let i = 1; i <= RING_COUNT; i++) {
        const t = i / RING_COUNT
        // 聚焦时，椭圆向中心收拢并加快微波动
        const contraction = 1 - currentFocus * 0.2 * (1 - t)
        const rx = maxRadiusX * t * contraction
        const ry = maxRadiusY * t * contraction

        // 正弦呼吸扰动
        const wave = Math.sin(phase + i * 0.35) * (1.6 + currentFocus * 1.2)

        ctx.beginPath()
        ctx.ellipse(centerX, centerY, Math.max(1, rx + wave), Math.max(1, ry + wave * 0.5), 0, 0, Math.PI * 2)

        const alpha = (0.035 + (1 - t) * 0.11 + currentFocus * 0.05).toFixed(3)
        ctx.strokeStyle = `rgba(${baseR}, ${baseG}, ${baseB}, ${alpha})`
        ctx.lineWidth = 1
        ctx.stroke()
      }

      // 中心聚焦十字丝 (Focal crosshair)
      const chSize = 5 + currentFocus * 4
      ctx.beginPath()
      ctx.strokeStyle = `rgba(${baseR}, ${baseG}, ${baseB}, ${0.18 + currentFocus * 0.25})`
      ctx.lineWidth = 1
      ctx.moveTo(centerX - chSize, centerY)
      ctx.lineTo(centerX + chSize, centerY)
      ctx.moveTo(centerX, centerY - chSize)
      ctx.lineTo(centerX, centerY + chSize)
      ctx.stroke()

      // 中心聚焦微圆点
      ctx.beginPath()
      ctx.arc(centerX, centerY, 1.6 + currentFocus * 0.8, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${baseR}, ${baseG}, ${baseB}, ${0.35 + currentFocus * 0.35})`
      ctx.fill()

      ctx.restore()
      animationId = requestAnimationFrame(render)
    }

    render()

    return () => {
      cancelAnimationFrame(animationId)
    }
  }, [focused])

  return <canvas ref={canvasRef} className="ui-research-focal-canvas" />
}

export function ResearchPage({ explorerCollapsed: initialExplorerCollapsed = false, onOpenSettings }: ResearchPageProps) {
  const research = useResearch()
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const [readingSource, setReadingSource] = useState<ResearchSourceView | null>(null)
  const [explorerQuery, setExplorerQuery] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const selected = research.detail
  const active = selected !== null && (selected.status === 'queued' || selected.status === 'running')
  const searchReady = research.readiness?.search.available ?? true

  // 检查器与历史栏联动状态：
  // 1. 点击历史列表里的研究项，默认处于浏览模式：历史栏保持展开，时间线/检查器保持关闭，不打断浏览节奏。
  // 2. 只有当用户明确点击“展开时间线”或进入深挖时，才自动折叠左侧历史栏、滑出右侧时间线面板。
  // 3. 当用户主动关闭时间线时，左侧历史栏自动重新展开。
  // 4. 用户也可以随时通过工具栏按钮独立展开/收起历史栏。
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [historyCollapsedOverride, setHistoryCollapsedOverride] = useState<boolean | null>(false)

  const prevSelectedIdRef = useRef<string | null>(selected?.id ?? null)
  useEffect(() => {
    if (selected?.id !== prevSelectedIdRef.current) {
      prevSelectedIdRef.current = selected?.id ?? null
      // 切换/点击研究时：默认仅浏览，不自动展开时间线，保持历史栏展开
      setInspectorOpen(false)
      setHistoryCollapsedOverride(false)
    }
  }, [selected?.id])

  const isHistoryCollapsed = initialExplorerCollapsed || (
    historyCollapsedOverride !== null
      ? historyCollapsedOverride
      : (selected !== null && inspectorOpen)
  )

  const handleToggleInspector = (nextOpen: boolean) => {
    setInspectorOpen(nextOpen)
    // 明确点击展开时间线时收起历史栏；关闭时间线时重新展开历史栏
    setHistoryCollapsedOverride(!nextOpen ? false : true)
  }

  const handleToggleHistory = () => {
    setHistoryCollapsedOverride(!isHistoryCollapsed)
  }

  async function handleStart(): Promise<void> {
    const question = draft.trim()
    if (question.length === 0 || !searchReady || research.submitting) return
    try {
      await research.submit(question)
      setDraft('')
    } catch {
      // 错误由 hook 暴露
    }
  }

  function pickSeed(topic: string): void {
    setDraft(topic)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
  }

  return (
    <div className="ui-research-studio">
      {/* ── 左侧记录栏（挂入统一的 WorkbenchExplorer 槽位）── */}
      <WorkbenchExplorer collapsed={isHistoryCollapsed} width={260}>
        <div className="ui-research-nav">
          <div className="ui-research-nav__head">
            <span className="ui-research-nav__title">
              <Compass size={14} style={{ color: 'var(--ui-accent, #6865a7)' }} />
              研究记录
            </span>
            <button
              type="button"
              onClick={() => research.select(null)}
              className="ui-research-nav__new-btn"
              title="新建研究"
            >
              <Plus size={12} strokeWidth={2.2} />
              <span>新研究</span>
            </button>
          </div>

          {research.tasks.length > 5 && (
            <div className="ui-research-nav__search">
              <input
                type="text"
                value={explorerQuery}
                onChange={(e) => setExplorerQuery(e.target.value)}
                placeholder="筛选研究记录…"
                className="ui-research-nav__search-input"
              />
            </div>
          )}

          <div className="ui-research-nav__list">
            {research.tasks.length === 0 ? (
              <div className="ui-research-nav__empty">
                <FileSearch size={22} strokeWidth={1.4} style={{ opacity: 0.5, marginBottom: 8 }} />
                <p className="m-0 text-xs leading-relaxed">
                  暂无研究记录。
                  <br />
                  在此发起的研究将沉淀于此。
                </p>
              </div>
            ) : (
              research.tasks
                .filter((t) => !explorerQuery.trim() || t.question.toLowerCase().includes(explorerQuery.toLowerCase()))
                .map((task) => {
                  const isSelected = selected?.id === task.id
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => research.select(task.id)}
                      data-selected={isSelected}
                      className="ui-research-nav__item"
                    >
                      <span className="ui-research-nav__item-question">{task.question}</span>
                      <div className="ui-research-nav__item-meta">
                        <StatusDot status={task.status} />
                        <span>{formatRelativeTime(task.createdAt)}</span>
                        {task.sourceCount > 0 && <span>· {task.sourceCount} 来源</span>}
                      </div>
                    </button>
                  )
                })
            )}
          </div>
        </div>
      </WorkbenchExplorer>

      {/* ── 右侧主工作区 ── */}
      <div className="ui-research-content">
        {selected === null ? (
          /* 模式 A：Studio 发起界面（保持极致简约与视觉张力，无教学式说教） */
          <div className="ui-research-stage">
            <div className="ui-research-empty-studio">
              <div className="ui-research-hero">
                <div className="ui-research-hero__focal-wrap">
                  <ResearchFocalCanvas focused={focused} />
                </div>
                <h1 className="ui-research-hero__title">深度研究</h1>
              </div>

              {/* 提问输入卡 */}
              <div className="ui-research-composer" data-focused={focused}>
                <textarea
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void handleStart()
                    }
                  }}
                  placeholder="写下一个需要查证的研究主题…"
                  className="ui-research-composer__input"
                />

                <div className="ui-research-composer__toolbar">
                  <div className="ui-research-composer__pills">
                    {searchReady ? (
                      <span className="ui-research-pill" data-status="ready">
                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--ui-status-done,#48A870)]" />
                        联网已就绪
                      </span>
                    ) : (
                      <span className="ui-research-pill" data-status="warning">
                        <AlertCircle size={12} />
                        <span>未配置搜索服务</span>
                        {onOpenSettings !== undefined && (
                          <button
                            type="button"
                            onClick={() => onOpenSettings?.()}
                            className="ui-research-pill__action"
                          >
                            配置
                          </button>
                        )}
                      </span>
                    )}
                  </div>

                  <div className="ui-research-composer__actions">
                    <span className="ui-research-composer__hint">Enter 开始</span>
                    <button
                      type="button"
                      disabled={draft.trim().length === 0 || !searchReady || research.submitting}
                      onClick={() => void handleStart()}
                      className="ui-research-composer__submit"
                    >
                      {research.submitting ? (
                        <LoaderCircle size={14} className="animate-spin" />
                      ) : (
                        <ArrowUp size={14} strokeWidth={2.4} />
                      )}
                      <span>{research.submitting ? '启动中' : '开始研究'}</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* 极简研究主题推荐 (无浮动卡片，纯粹发丝线标签) */}
              <div className="ui-research-seeds">
                <span className="ui-research-seeds__label">探索方向</span>
                <div className="ui-research-seeds__chips">
                  {SEED_TOPICS.map((topic) => (
                    <button
                      key={topic}
                      type="button"
                      onClick={() => pickSeed(topic)}
                      className="ui-research-seed-chip"
                    >
                      <span>{topic}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* 模式 B：具体研究详情 / 报告阅读界面 (Ultra Workbench) */
          <ResearchDetailView
            task={selected}
            active={active}
            cancelling={research.cancelling}
            inspectorOpen={inspectorOpen}
            isHistoryCollapsed={isHistoryCollapsed}
            onCancel={() => void research.cancel()}
            onRestart={(q) => {
              research.select(null)
              setDraft(q)
              requestAnimationFrame(() => inputRef.current?.focus())
            }}
            onToggleInspector={handleToggleInspector}
            onToggleHistory={handleToggleHistory}
          />
        )}
      </div>
    </div>
  )
}

/* ── 详情与成果视图 (Ultra Workbench 双栏版式) ── */
function ResearchDetailView({
  task,
  active,
  cancelling,
  inspectorOpen,
  isHistoryCollapsed,
  onCancel,
  onRestart,
  onToggleInspector,
  onToggleHistory,
}: {
  task: ResearchTaskDetailView
  active: boolean
  cancelling: boolean
  inspectorOpen: boolean
  isHistoryCollapsed: boolean
  onCancel: () => void
  onRestart: (question: string) => void
  onToggleInspector: (open: boolean) => void
  onToggleHistory: () => void
}) {
  const [inspectorTab, setInspectorTab] = useState<'activity' | 'sources' | 'plan'>(
    active ? 'activity' : 'sources'
  )
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const isCompleted = task.status === 'completed' && task.reportMarkdown !== null
  const stopped = task.status === 'interrupted'
  const failed = task.status === 'failed'
  const planPending = active && (task.plan === null || task.plan.questions.length === 0)

  const stateLabel = cancelling
    ? '正在停止'
    : active
      ? (task.stage === 'writing' ? '整理报告' : task.stage === 'reading' ? '阅读正文' : task.stage === 'analyzing' ? '判断覆盖' : '研究中')
      : isCompleted
        ? '研究已完成'
        : stopped
          ? '已停止'
          : '未完成'

  const activityLabel = active
    ? (task.stage === 'planning'
        ? '正在拆解核心子问题，生成研究计划…'
        : task.stage === 'searching'
          ? `正在进行第 ${task.usage.searchRequests || 1} 轮联网检索…`
          : task.stage === 'reading'
            ? `正在阅读信源正文（已抓取 ${task.usage.fetchRequests} 篇）…`
            : task.stage === 'analyzing'
              ? '正在综合多方证据，判断问题覆盖度…'
              : task.stage === 'writing'
                ? '正在撰写结构化研究报告…'
                : '正在推进深度调研…')
    : isCompleted
      ? `已完成调研 · 收集 ${task.sources.length} 个来源`
      : stopped
        ? '研究已停止。'
        : (task.errorMessage ?? '研究未完成。')

  const handleCopy = async () => {
    if (!task.reportMarkdown) return
    try {
      await navigator.clipboard.writeText(task.reportMarkdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板失败静默
    }
  }

  const handleDownload = () => {
    if (!task.reportMarkdown) return
    const blob = new Blob([task.reportMarkdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `深度研究-${task.question.slice(0, 24).replace(/[\\/:*?"<>|]/g, '_')}.md`
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleSelectSource = (sourceId: string | null) => {
    setSelectedSourceId(sourceId)
    setInspectorTab('sources')
    onToggleInspector(true)
  }

  return (
    <div className="ui-research-layout" data-inspector={inspectorOpen ? 'open' : 'closed'}>
      {/* 主栏 (Main Column) */}
      <div className="ui-research-main">
        {/* 顶部轻量工具栏 */}
        <header className="ui-research-toolbar">
          <div className="ui-research-toolbar__topic">
            <button
              type="button"
              className={`ui-research-history-toggle ${!isHistoryCollapsed ? 'is-active' : ''}`}
              onClick={onToggleHistory}
              title={isHistoryCollapsed ? '展开研究记录 (历史列表)' : '收起研究记录'}
              aria-label="切换研究记录侧栏"
            >
              <PanelLeft size={14} />
              <span>{isHistoryCollapsed ? '历史记录' : '收起历史'}</span>
            </button>
            <span className="ui-research-toolbar__divider" />
            <span className="ui-research-kicker">RESEARCH TOPIC</span>
            <span className="ui-research-toolbar__question" title={task.question}>
              {task.question}
            </span>
          </div>
          <div className="ui-research-toolbar__actions">
            <span className="ui-research-state-pill" data-status={task.status}>
              {active && <span className="ui-research-live-dot" />}
              <span>{stateLabel}</span>
            </span>
            <button
              type="button"
              className={`ui-research-inspector-toggle ${inspectorOpen ? 'is-active' : ''}`}
              onClick={() => onToggleInspector(!inspectorOpen)}
              title={inspectorOpen ? '收起时间线与文献（将自动展开历史记录）' : '展开时间线与文献（将自动收起历史记录）'}
              aria-label="切换时间线与文献"
            >
              <PanelRight size={14} />
              <span>{inspectorOpen ? '收起时间线' : '展开时间线'}</span>
            </button>
          </div>
        </header>

        <div className="ui-research-main__content" data-mode={isCompleted ? 'report' : 'plan'}>
          {/* 模式 1：报告已生成 (Report Mode) */}
          {isCompleted ? (
            <article className="ui-research-report" aria-label="研究报告">
              <div className="ui-research-report__header">
                <span className="ui-research-kicker">RESEARCH REPORT</span>
                <h1 className="ui-research-report__title">{task.reportTitle ?? task.question}</h1>
                <div className="ui-research-report__meta">
                  <span>用时 {formatDuration(task.usage.elapsedMs)}</span>
                  <span className="ui-research-dot-sep">·</span>
                  <button
                    type="button"
                    className="ui-research-stat-link"
                    onClick={() => {
                      setInspectorTab('sources')
                      setSelectedSourceId(null)
                      onToggleInspector(true)
                    }}
                  >
                    {task.sources.length} 个来源文献
                  </button>
                  <span className="ui-research-dot-sep">·</span>
                  <button
                    type="button"
                    className="ui-research-stat-link"
                    onClick={() => {
                      setInspectorTab('activity')
                      setSelectedSourceId(null)
                      onToggleInspector(true)
                    }}
                  >
                    {task.usage.searchRequests} 次多轮检索
                  </button>
                  {task.usage.fetchRequests > 0 && (
                    <>
                      <span className="ui-research-dot-sep">·</span>
                      <span>已读正文 {task.usage.fetchRequests} 篇</span>
                    </>
                  )}
                </div>
              </div>

              <div className="ui-research-report__prose">
                <RichText text={task.reportMarkdown ?? ''} />
              </div>

              {task.plan && task.plan.questions.length > 0 && (
                <details className="ui-research-completed-plan">
                  <summary>
                    <ListChecks size={14} />
                    <span>查看完整论证计划 ({task.plan.questions.length} 项)</span>
                    <ChevronDown size={13} className="ui-research-fold-icon" />
                  </summary>
                  <ol className="ui-research-plan__items">
                    {task.plan.questions.map((q) => {
                      const coverage = lastCoverageOf(task, q.id)
                      const isItemComplete = coverage !== undefined && coverage.coverage === 'supported'
                      return (
                        <li key={q.id} data-state={isItemComplete ? 'complete' : 'pending'} className="ui-research-plan__item">
                          <span className="ui-research-plan__check">
                            {isItemComplete ? <Check size={12} /> : null}
                          </span>
                          <span className="ui-research-plan__text">{q.text}</span>
                          {q.priority === 'high' && <span className="ui-research-plan__priority">重点</span>}
                          {coverage !== undefined && (
                            <button
                              type="button"
                              className="ui-research-plan__tag-btn"
                              onClick={() => {
                                setInspectorTab('plan')
                                onToggleInspector(true)
                              }}
                              title="在右侧检查器查看论证细节"
                            >
                              <span className="ui-research-plan__tag" data-coverage={coverage.coverage}>
                                {COVERAGE_LABELS[coverage.coverage]}
                              </span>
                            </button>
                          )}
                        </li>
                      )
                    })}
                  </ol>
                </details>
              )}

              <footer className="ui-research-report__actions">
                <button className="ui-research-btn-subtle" type="button" onClick={() => void handleCopy()}>
                  {copied ? <Check size={13} style={{ color: 'var(--ui-status-done, #48A870)' }} /> : <Copy size={13} />}
                  <span>{copied ? '已复制' : '复制报告'}</span>
                </button>
                <button className="ui-research-btn-subtle" type="button" onClick={handleDownload}>
                  <Download size={13} />
                  <span>下载 Markdown</span>
                </button>
                <button className="ui-research-btn-subtle" type="button" onClick={() => onRestart(task.question)}>
                  <Plus size={13} />
                  <span>以同一问题新建</span>
                </button>
              </footer>
            </article>
          ) : (
            /* 模式 2：研究计划与进行态 (In-progress Plan) */
            <section className="ui-research-plan" aria-label="研究计划">
              <div className="ui-research-plan__header">
                <div className="ui-research-plan__header-left">
                  <span className="ui-research-plan__symbol"><ListChecks size={17} /></span>
                  <span className="ui-research-plan__header-title">研究论证计划</span>
                </div>
                <span className="ui-research-state-badge" data-scene={task.status}>
                  {active && <span className="ui-research-live-dot" />}
                  <span>{stateLabel}</span>
                </span>
              </div>

              <h1 className="ui-research-plan__title">
                {task.plan?.objective ?? task.question}
              </h1>

              {planPending ? (
                <p className="ui-research-plan__pending">
                  <span className="ui-research-live-dot" />
                  <span>正在拆解核心子问题，生成研究计划…</span>
                </p>
              ) : (
                <ol className="ui-research-plan__items">
                  {task.plan?.questions.map((q) => {
                    const coverage = lastCoverageOf(task, q.id)
                    const isItemComplete = coverage !== undefined && coverage.coverage === 'supported'
                    const isItemActive = active && !isItemComplete && (task.stage === 'reading' || task.stage === 'searching' || task.stage === 'analyzing')
                    const itemState = isItemComplete ? 'complete' : isItemActive ? 'active' : 'pending'

                    return (
                      <li key={q.id} data-state={itemState} className="ui-research-plan__item">
                        <span className="ui-research-plan__check">
                          {isItemComplete ? <Check size={12} /> : isItemActive ? <span /> : null}
                        </span>
                        <span className="ui-research-plan__text">{q.text}</span>
                        {q.priority === 'high' && <span className="ui-research-plan__priority">重点</span>}
                        {coverage !== undefined && (
                          <button
                            type="button"
                            className="ui-research-plan__tag-btn"
                            onClick={() => {
                              setInspectorTab('plan')
                              onToggleInspector(true)
                            }}
                            title="在右侧检查器查看论证细节"
                          >
                            <span className="ui-research-plan__tag" data-coverage={coverage.coverage}>
                              {COVERAGE_LABELS[coverage.coverage]}
                            </span>
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ol>
              )}

              <div className="ui-research-plan__progress">
                <div className="ui-research-plan__current" role="status">
                  <span className="ui-research-plan__activity-text">{activityLabel}</span>
                  <span className="ui-research-plan__elapsed">用时 {formatDuration(task.usage.elapsedMs)}</span>
                </div>

                {active && (
                  <div className="ui-research-indeterminate" role="progressbar" aria-label={stateLabel}>
                    <span />
                  </div>
                )}

                {(stopped || failed || task.errorMessage) && (
                  <p className="ui-research-plan__outcome">
                    {task.errorMessage ?? (stopped ? '研究已停止。右侧检查器仍可查看停止前收集的文献与记录。' : '研究未完成。已取得的材料仍可查看。')}
                  </p>
                )}

                <div className="ui-research-plan__actions">
                  <button
                    type="button"
                    className="ui-research-text-button"
                    onClick={() => {
                      setInspectorTab('activity')
                      setSelectedSourceId(null)
                      onToggleInspector(true)
                    }}
                  >
                    <Search size={13} />
                    <span>{task.usage.searchRequests} 次检索</span>
                  </button>
                  <button
                    type="button"
                    className="ui-research-text-button"
                    onClick={() => {
                      setInspectorTab('sources')
                      setSelectedSourceId(null)
                      onToggleInspector(true)
                    }}
                  >
                    <BookOpen size={13} />
                    <span>{task.sources.length} 个来源</span>
                  </button>
                  {active ? (
                    <button
                      type="button"
                      className="ui-research-stop"
                      disabled={cancelling}
                      onClick={onCancel}
                    >
                      <Square size={10} fill="currentColor" />
                      <span>{cancelling ? '正在停止' : '停止研究'}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ui-research-btn-subtle ui-research-plan__restart"
                      onClick={() => onRestart(task.question)}
                    >
                      <Plus size={13} />
                      <span>以同一问题新建</span>
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      </div>

      {/* 侧栏：研究检查器 (Research Inspector) 始终挂载，由 CSS 平滑过渡宽度 */}
      <aside
        className="ui-research-inspector-slot"
        aria-hidden={!inspectorOpen}
        inert={!inspectorOpen ? true : undefined}
      >
        <ResearchInspector
          task={task}
          active={active}
          tab={inspectorTab}
          selectedSourceId={selectedSourceId}
          onTabChange={(nextTab) => {
            setInspectorTab(nextTab)
            setSelectedSourceId(null)
          }}
          onSelectSource={handleSelectSource}
          onClose={() => onToggleInspector(false)}
        />
      </aside>
    </div>
  )
}

/* ── 研究检查器 (Research Inspector) ── */
function ResearchInspector({
  task,
  active,
  tab,
  selectedSourceId,
  onTabChange,
  onSelectSource,
  onClose,
}: {
  task: ResearchTaskDetailView
  active: boolean
  tab: 'activity' | 'sources' | 'plan'
  selectedSourceId: string | null
  onTabChange: (tab: 'activity' | 'sources' | 'plan') => void
  onSelectSource: (id: string | null) => void
  onClose: () => void
}) {
  const selectedSource = task.sources.find((s) => s.id === selectedSourceId)
  const [sourceContent, setSourceContent] = useState<string | null>(null)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedSource) {
      setSourceContent(null)
      setSourceError(null)
      return
    }
    let cancelled = false
    setSourceLoading(true)
    setSourceContent(null)
    setSourceError(null)
    void fetchResearchSourceContent(task.id, selectedSource.id)
      .then((res) => {
        if (!cancelled) setSourceContent(res.contentText)
      })
      .catch((err: unknown) => {
        if (!cancelled) setSourceError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setSourceLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [task.id, selectedSource])

  return (
    <div className="ui-research-inspector">
      {/* 头部 */}
      <div className="ui-research-inspector__header">
        <div className="ui-research-inspector__heading">
          <span className="ui-research-kicker">RESEARCH INSPECTOR</span>
          <h3>研究检查器</h3>
        </div>
        <button
          type="button"
          className="ui-research-inspector__close"
          onClick={onClose}
          title="收起检查器"
          aria-label="收起检查器"
        >
          <X size={15} />
        </button>
      </div>

      {/* Tabs */}
      <div className="ui-research-inspector__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'activity'}
          onClick={() => {
            onTabChange('activity')
            onSelectSource(null)
          }}
          className="ui-research-inspector__tab"
        >
          <span>检索轨迹</span>
          {task.queries.length > 0 && <span className="ui-research-tab-count">{task.queries.length}</span>}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={tab === 'sources'}
          onClick={() => onTabChange('sources')}
          className="ui-research-inspector__tab"
        >
          <span>文献证据</span>
          {task.sources.length > 0 && <span className="ui-research-tab-count">{task.sources.length}</span>}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={tab === 'plan'}
          onClick={() => {
            onTabChange('plan')
            onSelectSource(null)
          }}
          className="ui-research-inspector__tab"
        >
          <span>论证要点</span>
          {task.plan && task.plan.questions.length > 0 && (
            <span className="ui-research-tab-count">{task.plan.questions.length}</span>
          )}
        </button>
      </div>

      {/* 内容区域 */}
      <div className="ui-research-inspector__body">
        {tab === 'activity' && (
          <div className="ui-research-inspector__activity">
            {/* 当前执行阶段徽标 */}
            <div className="ui-research-inspector__stage-row">
              <span className="ui-research-inspector__label">当前阶段</span>
              <span className="ui-research-stage-badge">
                {active && <span className="ui-research-live-dot" />}
                {STAGES.find((s) => s.key === task.stage)?.label ?? (task.status === 'completed' ? '已完成' : '已就绪')}
              </span>
            </div>

            {/* 检索记录列表 */}
            <div className="ui-research-inspector__section-title">
              <span>检索关键词 ({task.queries.length})</span>
            </div>

            {task.queries.length === 0 ? (
              <div className="ui-research-inspector__empty">
                {active ? '正在准备发起第一轮检索…' : '暂无检索记录'}
              </div>
            ) : (
              <ol className="ui-research-query-list">
                {task.queries.map((q, idx) => (
                  <li key={q.id || idx} className="ui-research-query-item" data-status={q.status}>
                    <div className="ui-research-query-header">
                      <span className="ui-research-query-round">R{q.round}</span>
                      <span className="ui-research-query-text">{q.text}</span>
                      {q.status === 'succeeded' ? (
                        <Check size={12} className="ui-research-status-ok" />
                      ) : (
                        <X size={12} className="ui-research-status-fail" />
                      )}
                    </div>
                    <div className="ui-research-query-meta">
                      <span>命中 {q.resultCount} 条结果</span>
                    </div>
                  </li>
                ))}
              </ol>
            )}

            {/* 用量统计 */}
            <div className="ui-research-inspector__section-title">
              <span>资源与用量</span>
            </div>
            <div className="ui-research-usage-grid">
              <div className="ui-research-usage-card">
                <span className="ui-research-usage-label">检索轮次</span>
                <span className="ui-research-usage-value">{task.usage.searchRequests}</span>
              </div>
              <div className="ui-research-usage-card">
                <span className="ui-research-usage-label">正文抓取</span>
                <span className="ui-research-usage-value">{task.usage.fetchRequests} 篇</span>
              </div>
              <div className="ui-research-usage-card">
                <span className="ui-research-usage-label">模型交互</span>
                <span className="ui-research-usage-value">{task.usage.modelRequests} 次</span>
              </div>
              <div className="ui-research-usage-card">
                <span className="ui-research-usage-label">总计用时</span>
                <span className="ui-research-usage-value">{formatDuration(task.usage.elapsedMs)}</span>
              </div>
            </div>
          </div>
        )}

        {tab === 'sources' && (
          <div className="ui-research-inspector__sources">
            {selectedSource ? (
              /* 单个来源下钻详情 */
              <div className="ui-research-source-detail">
                <button
                  type="button"
                  className="ui-research-btn-subtle ui-research-source-back"
                  onClick={() => onSelectSource(null)}
                >
                  <ArrowLeft size={12} />
                  <span>全部文献列表</span>
                </button>

                <div className="ui-research-source-detail__head">
                  <span className="ui-research-source-ordinal">[{selectedSource.ordinal}]</span>
                  <h4 className="ui-research-source-detail__title">{selectedSource.title}</h4>
                </div>

                <a
                  href={selectedSource.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="ui-research-source-detail__link"
                >
                  <span>{selectedSource.url}</span>
                  <ExternalLink size={11} />
                </a>

                {selectedSource.snippet && (
                  <div className="ui-research-source-detail__section">
                    <span className="ui-research-inspector__label">检索摘要</span>
                    <p className="ui-research-source-detail__snippet">{selectedSource.snippet}</p>
                  </div>
                )}

                <div className="ui-research-source-detail__section">
                  <span className="ui-research-inspector__label">正文抓取摘录</span>
                  {sourceLoading ? (
                    <div className="ui-research-source-detail__hint">正在加载正文摘录…</div>
                  ) : sourceError ? (
                    <div className="ui-research-source-detail__hint error">{sourceError}</div>
                  ) : sourceContent ? (
                    <div className="ui-research-source-detail__content">{sourceContent}</div>
                  ) : (
                    <div className="ui-research-source-detail__hint">本次研究仅参考了摘要信息。</div>
                  )}
                </div>
              </div>
            ) : (
              /* 来源列表 */
              <div className="ui-research-source-list">
                {task.sources.length === 0 ? (
                  <div className="ui-research-inspector__empty">
                    {active ? '检索进行中，正在收集文献来源…' : '暂无引用来源'}
                  </div>
                ) : (
                  task.sources.map((s) => (
                    <div
                      key={s.id}
                      className="ui-research-inspector-source-item"
                      onClick={() => onSelectSource(s.id)}
                    >
                      <div className="ui-research-inspector-source-top">
                        <span className="ui-research-source-ordinal">[{s.ordinal}]</span>
                        <span className="ui-research-inspector-source-title">{s.title}</span>
                      </div>
                      <div className="ui-research-inspector-source-bottom">
                        <span className="ui-research-inspector-source-host">{parseHost(s.url)}</span>
                        <span className="ui-research-inspector-source-badge" data-has-content={s.hasContent}>
                          {s.hasContent ? `${s.contentChars} 字` : '仅摘要'}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'plan' && (
          <div className="ui-research-inspector__plan">
            {!task.plan || task.plan.questions.length === 0 ? (
              <div className="ui-research-inspector__empty">
                {active ? '正在拆解核心要点与子问题…' : '暂无论证要点'}
              </div>
            ) : (
              <ol className="ui-research-inspector-plan-list">
                {task.plan.questions.map((q) => {
                  const coverage = lastCoverageOf(task, q.id)
                  return (
                    <li key={q.id} className="ui-research-inspector-plan-item">
                      <div className="ui-research-inspector-plan-header">
                        <span className="ui-research-plan__text">{q.text}</span>
                        {q.priority === 'high' && (
                          <span className="ui-research-plan__priority">重点</span>
                        )}
                      </div>
                      {coverage && (
                        <div className="ui-research-inspector-plan-coverage">
                          <span
                            className="ui-research-plan__tag"
                            data-coverage={coverage.coverage}
                          >
                            {COVERAGE_LABELS[coverage.coverage]}
                          </span>
                          {coverage.text && (
                            <p className="ui-research-inspector-plan-evidence">{coverage.text}</p>
                          )}
                          {coverage.gaps && coverage.gaps.length > 0 && (
                            <div className="ui-research-inspector-plan-gaps">
                              <span className="ui-research-inspector__label">待查缺口：</span>
                              <span>{coverage.gaps.join('；')}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: ResearchTaskDetailView['status'] }) {
  if (status === 'completed') {
    return <span className="h-1.5 w-1.5 rounded-full bg-[var(--ui-status-success)]" />
  }
  if (status === 'running') {
    return <span className="h-1.5 w-1.5 rounded-full bg-[var(--ui-accent)] animate-pulse" />
  }
  if (status === 'queued') {
    return <span className="h-1.5 w-1.5 rounded-full bg-[var(--ui-status-warning)]" />
  }
  return <span className="h-1.5 w-1.5 rounded-full bg-[var(--ui-text-3)]" />
}

function RotateIcon({ size }: { size: number }) {
  return <Sparkles size={size} />
}

function lastCoverageOf(task: ResearchTaskDetailView, questionId: string) {
  for (let idx = task.coverage.length - 1; idx >= 0; idx -= 1) {
    const item = task.coverage[idx]?.answers.find((a) => a.questionId === questionId)
    if (item !== undefined) return item
  }
  return undefined
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} 秒`
  const mins = Math.floor(sec / 60)
  return `${mins} 分 ${sec % 60} 秒`
}

function parseHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
