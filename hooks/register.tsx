import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, UiPressArgument } from 'claude-code'

import type { TodoItem, TodoMirror, WorkflowMap, WorkflowNode } from '../types/index'
import { demoMap as demoPlan, teamMap } from './demo'
import { diagramStages, flowOutline, flowSvg, layoutFlow, outlineText } from './flow'
import type { FlowMarks } from './flow'
import { allDone, applyOp, compactLine, emptyMap, etaRange, etaText, exportMarkdown, findCycle, isActive, isStale, isStep, KINDS, mergeMaps, migrate, opSummary, planDiff, plainLines, readyIds, STATUSES, stageView, stats, textDiagram, timeline, validateMap } from './graph'
import type { Op } from './graph'
import { detectLang, HELP_TABS, LANGS, looksLikeRequest, resolveLang, STR } from './i18n'
import type { Lang } from './i18n'
import { CAPSULE_CELLS, CAPSULE_CHROME, cells, fitCells, forkPrompt, languageRule, MAX_SUGGESTIONS, MIN_ANSWER_CHARS, parseSuggestions, planSuggestions, ROW_CHROME, sameAs, skillList } from './suggest'
import type { Suggestion, SuggestView } from './suggest'
import { bandCards, barSegs, glyph, headerSegs } from './tui'
import type { Seg } from './tui'
import { amberPic, bandGraph, bandHeader, chevronPic, detailLines, fmtTime, iconPic, insFresh, insHot, insMark, kindOf, metaOf, miniBar, paneBar, paneCards, paneStatus, PX_PER_COL, slotPic, STAR_W, starPic, THEMES } from './svg'
import type { Clock, Kind } from './svg'

const TOOL = 'mcp__workflow-map__workflow_map'
const PANE = 'workflow-map'

/**
 * 間距系統（全部介面共用，改這裏就全部一致）。單位是介面的格（Box 的 padding／gap／margin）。
 * PAD = 卡內距（四邊相同）；GAP = 行內元素之間、卡與卡之間、輸入框上方橫條與下一條橫條之間；
 * ICON_COL = 圖示欄闊度（px）：卡內每一行都是 [圖示欄][GAP][文字]，所以卡頭、步驟、第二行、詳情的文字同一條線。
 * 橫條圖內的左邊留白見 svg.ts 的 BAND_INSET（px）。
 */
const SPACE = { PAD: 1, GAP: 1 } as const
/**
 * 全圖面板對齊 app 原生面板（Background tasks）：左邊縮一格（≈ 16px），右邊不縮——app 已在右邊多留約 15px 給
 * 捲動列（真機：卡左 29px、卡右 44px），右邊再縮就不對稱；這樣兩邊各約 30px，捲動列落在右邊留白之內，
 * 與原生面板一樣。卡與卡之間、分段標題與卡之間半格（≈ 8px，原生 7–8 / 12px）。
 */
const PANE_INSET = 1
const CARD_GAP = 0.5
const ICON_COL = 20
/** 卡內一行：標題至少要有這麼多格，否則「負責人 · 用時」與狀態字移到第二行 */
const TITLE_MIN = 12
/**
 * 按鈕跟 app 自己的設計：types 只有一種原生圖示按鈕（role="dismiss" = 原生關閉 ✕），沒有展開／收起／開啟／說明等
 * 原生圖示，也沒有圖示元素。所以：關閉用 role="dismiss"；其餘用 app 的文字按鈕（plain、淡色；指著時 app 自己的反白），
 * 不自創字形、不自加底色。
 */
const ICON_BTN = { plain: true, dimColor: true } as const
/**
 * 卡面：比四周略亮的填色、沒有可見外框（外框只用來令角變圓，顏色全透明）。types 的主題色沒有「卡面」一項，
 * 所以按 /config 的深淺主題選 8 位 hex（帶透明度）。外框不用「= 填色」：半透明的框疊在半透明的底上會變成
 * 一條更亮的線（實測）；全透明的框下面是同一片底色，看不見。終端機沒有填色，用 subtle 外框。
 */
const CARD_FILL = { dark: '#ffffff0f', light: '#0000000d' } as const
const CARD_EDGE = '#00000000'
const GLYPH_COLLAPSE = '˄'
const GLYPH_OPEN = '⤢'
/**
 * 計劃按 session 分開：每個計劃一個檔（PLANS_DIR/<planId>.json），每個 session 最多綁一個計劃（綁定存在 $.store，
 * key = bind:<sessionId>）。舊的共用檔 FILE 當作 id 為 'default' 的計劃，原地讀寫、不搬不改名不轉換；
 * 只有綁了它的 session 才看見它。
 */
const FILE = '.claude/workflow-map.json'
const LEGACY_ID = 'default'
const PLANS_DIR = '.claude/workflow-map/plans'
const UNDO_DIR = '.claude/workflow-map/undo'
const bindKey = (sessionId: string) => `bind:${sessionId}`
type Binding = { root: string; planId: string; at: string }
/** 封存的計劃：一個計劃一個檔，主檔保持細小 */
const HISTORY_DIR = '.claude/workflow-map.history'
/** 匯出的 Markdown（只寫這一個檔） */
const EXPORT_FILE = '.claude/workflow-map.export.md'
/** 還原用的快照（每個計劃最近 UNDO_MAX 次寫入之前的樣子），記憶體 + 檔案（UNDO_DIR/<planId>.json）各一份 */
const UNDO_MAX = 10
type Snapshot = { at: string; label: string; map: WorkflowMap }
let undoStack: Snapshot[] = []
/** undoStack 屬於哪個計劃（'' = 未讀） */
let undoFor = ''

const MAP = atom({ plugin: 'workflow-map', key: 'map' } as const, emptyMap())
const EXPANDED = atom({ plugin: 'workflow-map', key: 'expanded' } as const, false)
const PENDING = atom({ plugin: 'workflow-map', key: 'pending' } as const, false)
const DONE_TURNS = atom({ plugin: 'workflow-map', key: 'doneTurns' } as const, 0)
/** /workflow-demo：只在畫面顯示示範資料，不寫檔、不碰真資料 */
const DEMO = atom({ plugin: 'workflow-map', key: 'demo' } as const, '' as '' | 'basic' | 'team')
/** 全圖面板：流程圖（true）或階段卡（false）；本 session 記住 */
const DIAGRAM = atom({ plugin: 'workflow-map', key: 'diagram' } as const, false)
/** 全圖面板：正在看「插入前的計劃」的插入步驟 id（'' = 沒有） */
const BEFORE = atom({ plugin: 'workflow-map', key: 'before' } as const, '')
/** 全圖面板：正在看「插入後的改動」（現在的計劃 + 改動標記）的插入步驟 id（'' = 沒有） */
const CHANGES = atom({ plugin: 'workflow-map', key: 'changes' } as const, '')
/** 全圖面板「時間線」是否展開；最多列出最近 TIMELINE_MAX 項 */
const TIMELINE_OPEN = atom({ plugin: 'workflow-map', key: 'timelineOpen' } as const, false)
const TIMELINE_MAX = 40
/** 插入前的計劃（每個插入步驟一份，不受還原的 10 份上限影響）：SNAP_DIR/<planId>/<步驟 id>.json */
const SNAP_DIR = '.claude/workflow-map/snapshots'
const DONE_OPEN = atom({ plugin: 'workflow-map', key: 'doneOpen' } as const, false)
const FUTURE_OPEN = atom({ plugin: 'workflow-map', key: 'futureOpen' } as const, false)
const HISTORY_OPEN = atom({ plugin: 'workflow-map', key: 'historyOpen' } as const, false)
/** 全圖面板展開詳情的步驟（一次只開一個；'' = 無） */
const SELECTED = atom({ plugin: 'workflow-map', key: 'selected' } as const, '')
/**
 * 卡片圖兩端小卡指著時彈出的清單：最多幾行；底色要不透明（下面是對話內容），types 沒有「浮動面」的主題色，
 * 所以按深淺主題選色（接近 app 自己卡片的顏色）。
 */
const PEEK_MAX = 6
/** 清單的闊度上限（格，≈ 420px）；實際 = min(這個, 橫條闊 − 4) */
const PEEK_W = 56
/** 桌面一格最多幾 px（比 PX_PER_COL 偏大）：只用來算清單的位置，估錯只會令清單留在橫條內 */
const PX_PER_COL_MAX = 8
const PEEK_FILL = { dark: '#2b2b2b', light: '#f3f3f3' } as const
/** 全圖面板最上面的說明卡是否打開 */
const HELP_OPEN = atom({ plugin: 'workflow-map', key: 'helpOpen' } as const, false)
/** 全圖面板：專案總覽、正在唯讀檢視的另一個專案 */
const PROJECTS_OPEN = atom({ plugin: 'workflow-map', key: 'projectsOpen' } as const, false)
/** 這個 session 綁定的計劃 id（'' = 未綁定：橫條不畫計劃） */
const BOUND = atom({ plugin: 'workflow-map', key: 'bound' } as const, '')
/** 全圖面板「計劃」清單是否展開 */
const PLANS_OPEN = atom({ plugin: 'workflow-map', key: 'plansOpen' } as const, false)
const VIEW_ROOT = atom({ plugin: 'workflow-map', key: 'viewRoot' } as const, '')
/** $.store：有計劃的專案（最近 PROJECTS_MAX 個）。只讀別的專案的檔，從不寫。 */
const PROJECTS_KEY = 'projectsV1'
const PROJECTS_MAX = 20
type ProjectEntry = { root: string; title: string; done: number; total: number; running: number; updatedAt: string; planId?: string }

/** 說明卡顯示哪一種語言（'' = 介面語言） */
const HELP_LANG = atom({ plugin: 'workflow-map', key: 'helpLang' } as const, '')
/** 下一句建議（併入自 next-steps）：hidden／loading／offer */
const SUGGEST = atom({ plugin: 'workflow-map', key: 'suggest' } as const, { kind: 'hidden' } as SuggestView)
/** 子代理 id → 它負責的步驟 id（由描述內的 [wm:<id>] 得知） */
const AGENTS = atom({ plugin: 'workflow-map', key: 'agents' } as const, {} as Record<string, string>)
/** 模型內建待辦清單的鏡像（項目 → 步驟；由清單自動開的計劃 id） */
const TODOS = atom({ plugin: 'workflow-map', key: 'todos' } as const, { items: [], plan: '' } as TodoMirror)
let todoChain: Promise<unknown> = Promise.resolve()
/** 待辦清單至少幾項（未完成）才自動開計劃：與指引的「3 步以上」一致 */
const AUTO_MIN = 3
const TODO_STATUS: Record<string, WorkflowNode['status']> = { pending: 'todo', in_progress: 'doing', completed: 'done', deleted: 'dropped' }
/** 算作「實際工作」的工具；本輪主對話做了 NUDGE_AFTER 次而仍未有計劃 → 提示一次 */
const WORK_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'] as const
const NUDGE_AFTER = 3
const WORK = atom({ plugin: 'workflow-map', key: 'work' } as const, 0)
const NUDGE = atom({ plugin: 'workflow-map', key: 'nudge' } as const, 0)
/** 每分鐘跳一次（有進行中的步驟時），令用時與「久未更新」刷新 */
const TICK = atom({ plugin: 'workflow-map', key: 'tick' } as const, 0)
const WM_TAG = /\[wm:([^\]\s]+)\]/
/** 本輪開始時間：本輪新插入的步驟在聚焦時一定顯示 */
const TURN_AT = atom({ plugin: 'workflow-map', key: 'turnAt' } as const, 0)
/** 用戶這次親手輸入、看似新要求的原文（等模型記入計劃） */
const ASKED = atom({ plugin: 'workflow-map', key: 'asked' } as const, '')
/** 一輪結束時仍未記入計劃的要求原文（'' = 沒有）：橫條標題行尾「未記錄：…［加入計劃］✕」，每則訊息一次 */
const UNRECORDED = atom({ plugin: 'workflow-map', key: 'unrecorded' } as const, '')
/** 一句話的開頭（最多 n 個字，多了加「…」），空白合併；拉丁字不在字中間切（退到最近的空格，最多退 10 個字） */
const snippet = (s: string, n: number) => {
  const c = [...s.replace(/\s+/g, ' ').trim()]
  if (c.length <= n) return c.join('')
  let head = c.slice(0, n).join('')
  const sp = head.lastIndexOf(' ')
  if (/[A-Za-z0-9]/.test(c[n]!) && /[A-Za-z0-9]$/.test(head) && sp >= 0 && n - sp <= 10) head = head.slice(0, sp)
  return `${head.trimEnd()}…`
}
/** 聚焦的展開狀態在計劃改變、重開全圖時回到收起 */
const foldAll = async ($: $) => {
  if (await read($, DONE_OPEN)) await update($, DONE_OPEN, () => false)
  if (await read($, FUTURE_OPEN)) await update($, FUTURE_OPEN, () => false)
}
/** app 主題是淺色（/config 的 theme 含 light）；Svg 以圖片繪製讀不到主題，所以自己記住 */
const LIGHT = atom({ plugin: 'workflow-map', key: 'light' } as const, false)

const WORDING =
  "Titles and notes: in the user's own language (its written form), concise, plain words, no jargon or file names; " +
  'titles at most 8 CJK characters or 20 Latin characters; notes at most 20 CJK or 60 Latin characters.'

const DESCRIPTION =
  "Live dependency graph of this session's work (each session has its own plan; files under .claude/workflow-map/plans/), shown to the user. " +
  'ops: new_plan {title,nodes} starts an unrelated task (the current plan is archived to history); ' +
  "set_plan {nodes} replaces this plan's steps; upsert {nodes} changes only the given fields; status {id,status,note?}; " +
  'insert {nodes,note,before?} records work the USER interjected mid-plan (note = their words; deps = what it waits for; ' +
  'before = existing ids that must now wait for it); remove {ids}; show returns the full graph. ' +
  'Node: {id, title, status: todo|doing|done|blocked|dropped, deps: [ids it waits for], owner?, note?, lane?, kind?, edgeLabel?}. ' +
  'lane groups steps into one box in the diagram view; kind: step (default), decision (a question) or note (a warning, not a step); ' +
  'edgeLabel: a short label for what leads into this step (shown as "via …"). ' +
  'Steps sharing no deps path run in parallel. Cycles and unknown deps are rejected. ' +
  'Other ops return a one-line summary plus the changed steps and their neighbours. ' +
  'join {plan} binds this session to an existing plan of the project (to share it); leave unbinds. ' +
  WORDING

const SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['new_plan', 'set_plan', 'upsert', 'status', 'insert', 'remove', 'show', 'join', 'leave'] },
    plan: { type: 'string', description: 'join: the id or title of an existing plan of this project' },
    title: { type: 'string', description: 'new_plan: a short name for the task, in the user\'s language' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'short stable id, e.g. "A" or "build-ui"' },
          title: { type: 'string', description: "user's language, concise, ≤ 8 CJK / ≤ 20 Latin characters, no jargon" },
          status: { type: 'string', enum: STATUSES },
          deps: { type: 'array', items: { type: 'string' }, description: 'ids that must finish first' },
          lane: { type: 'string', description: 'group name: steps with the same lane are drawn in one box, e.g. "Review"' },
          kind: { type: 'string', enum: KINDS, description: 'step (default), decision (a question), note (a warning shown in the diagram, not a step)' },
          edgeLabel: { type: 'string', description: 'short label for what leads into this step, shown as "via …", e.g. "only if unsure"' },
          note: { type: 'string' },
          owner: { type: 'string', description: 'who does it: a sub-agent type or name, "me", …' },
        },
        required: ['id'],
      },
    },
    id: { type: 'string' },
    status: { type: 'string', enum: STATUSES },
    note: { type: 'string', description: 'insert: what the user asked, ≤ 20 CJK / 60 Latin characters. status: optional remark' },
    before: { type: 'array', items: { type: 'string' }, description: 'insert: existing ids that must wait for the new nodes' },
    ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['op'],
}

// 每次對話都會帶上（裝了外掛就有，用戶不用改 CLAUDE.md）：保持 ≤ 120 字。autoPlan = false 時只帶 GUIDE_MIN。
const GUIDE =
  `# Workflow map\nThis session's plan is shown live to the user. For any task with 3+ steps:\n` +
  `- At the start, call ${TOOL} new_plan (honest deps: independent steps share none).\n` +
  '- Keep statuses current: doing when a step starts, done or blocked when it ends.\n' +
  '- When the user adds a request mid-plan, record it with insert (note = their words) BEFORE acting on it.\n' +
  '- When delegating a step to a sub-agent, put [wm:<step id>] in its description.\n' +
  '- Many parallel workers: group them with lane (e.g. "Review"), label key arrows with edgeLabel.\n' +
  "- Titles in the user's language, plain words, no jargon, ≤ 8 CJK / 20 Latin characters.\n" +
  '- An unrelated new task: new_plan again.'
const GUIDE_MIN = `# Workflow map\n${TOOL} shows a plan to the user. Use it only when the user asks for one; then keep statuses current. Titles in the user's language.`

const HINT =
  `[workflow-map] A plan is in progress. If this message asks for something not already in the plan, record it first with ${TOOL} op "insert".`

type $ = EngineInterface

async function refreshTheme($: $) {
  try {
    const v = (await $.config.list()).find(r => r.key === 'theme')?.value
    const light = typeof v === 'string' && v.includes('light')
    if (light !== (await read($, LIGHT))) await update($, LIGHT, () => light)
  } catch {
    // 讀不到設定：維持深色
  }
}
const themeOf = async ($: $) => THEMES[(await read($, LIGHT)) ? 'light' : 'dark']

/** userConfig `language`：auto | en | zh-Hant | ja | ko | es | fr | de（每次載入由 register 設定） */
let languageSetting: unknown = 'auto'
/** userConfig `suggestions`：每輪結束後在橫條最後一行建議下一句（預設開） */
let suggestionsOn = true
/** userConfig `notify`：子代理完成、步驟受阻、久未更新時彈通知（預設開） */
let notifyOn = true
/** userConfig `autoPlan`：系統提示叫模型 3 步以上就開計劃、並由待辦清單自動開計劃（預設開；關 = 只帶最簡短的說明） */
let autoPlanOn = true
/** 同一時間內的通知合併：第一則之後等 NOTIFY_BATCH_MS，期間的全部合成一則 */
const NOTIFY_BATCH_MS = 5000
/** 已通知過的「步驟 × 轉變」（每步每種轉變最多一則；離開那個狀態後可再通知） */
const notified = new Set<string>()
let toastQueue: string[] = []
let toastTimer: { cancel: () => void } | undefined

function notify($: $, text: string) {
  if (!notifyOn) return
  toastQueue.push(text)
  if (toastTimer) return
  toastTimer = $.clock.after(NOTIFY_BATCH_MS, () => {
    const q = toastQueue
    toastQueue = []
    toastTimer = undefined
    if (q.length === 0) return
    void langNow($).then(lang => $.ui.toast(q.length === 1 ? q[0]! : STR[lang].nBatch(q.length, q.join(' · '))))
  })
}

/** 每步每種轉變只通知一次 */
function notifyOnce($: $, key: string, text: string) {
  if (notified.has(key)) return
  notified.add(key)
  notify($, text)
}

/** 一次寫入前後的狀態轉變 → 通知（完成只在子代理同步時通知；受阻一律通知） */
async function notifyTransitions($: $, before: WorkflowMap, after: WorkflowMap, fromAgent: boolean) {
  const old = new Map(before.nodes.map(n => [n.id, n]))
  const t = STR[await langNow($)]
  for (const n of after.nodes) {
    const o = old.get(n.id)
    if (!o || o.status === n.status) continue
    // 離開某個狀態：之後再進入可以再通知
    for (const k of ['done', 'blocked']) if (n.status !== k) notified.delete(`${n.id}:${k}`)
    if (n.status === 'done' && fromAgent) notifyOnce($, `${n.id}:done`, t.nDone(n.title, n.owner ?? ''))
    if (n.status === 'blocked') notifyOnce($, `${n.id}:blocked`, t.nBlocked(n.title))
  }
}
/** userConfig `staleMinutes`：進行中超過幾分鐘沒更新就標「久未更新」（0 = 不標） */
let staleMinutes = 30
const clockOf = async ($: $): Promise<Clock> => {
  await read($, TICK)
  const now = await $.clock.now()
  // 示範：當作本輪 20 分鐘前開始（示範裏 14 分鐘前插入的步驟算本輪，用紫色）
  return { now, staleMin: staleMinutes, turnAt: (await read($, DEMO)) ? now - 20 * 60_000 : await read($, TURN_AT) }
}
/** 用戶最近一次輸入的文字判斷出的語言（存在 $.store，跨 session） */
const LANG = atom({ plugin: 'workflow-map', key: 'lang' } as const, '')
/**
 * $.store 的鍵帶版本：舊鍵 'lang' 由有問題的偵測寫入（子代理的簡體文字也算），一律棄用。
 * 偵測規則再改時把版本加一。
 */
const LANG_KEY = 'langV2'
/** 設定 → 用戶輸入過的語言 → 計劃步驟名稱的文字（弱證據：模型用用戶的語言寫）→ 英文 */
const langNow = async ($: $): Promise<Lang> =>
  resolveLang(languageSetting, await read($, LANG), detectLang((await shownMap($)).nodes.map(n => n.title).join(' ')))

/** 示範資料：時間按現在推算，標題跟介面語言（設定 → 用戶輸入過的語言 → 英文），只在畫面使用 */
async function demoMap($: $, team: boolean): Promise<WorkflowMap> {
  return (team ? teamMap : demoPlan)(await $.clock.now(), resolveLang(languageSetting, await read($, LANG)))
}
const shownMap = async ($: $) => {
  const d = await read($, DEMO)
  return d ? demoMap($, d === 'team') : read($, MAP)
}

const sessionIdOf = async ($: $) => {
  try {
    return await $.session.id()
  } catch {
    return ''
  }
}

async function planPathOf($: $, planId: string): Promise<string> {
  return `${(await $.session.root()).replace(/[\\/]+$/, '')}/${planId === LEGACY_ID ? FILE : `${PLANS_DIR}/${planId}.json`}`
}

const nowIso = async ($: $) => new Date(await $.clock.now()).toISOString()

const rootOf = async ($: $) => (await $.session.root()).replace(/[\\/]+$/, '')

/** 讀 $.store 的專案清單（壞資料略過）。 */
async function readProjects($: $): Promise<ProjectEntry[]> {
  const raw = await $.store.get(PROJECTS_KEY).catch(() => undefined)
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (x): x is ProjectEntry =>
      typeof x === 'object' && x !== null && typeof (x as ProjectEntry).root === 'string' && typeof (x as ProjectEntry).total === 'number',
  )
}

/** 本專案的計劃有變：更新專案清單（沒有步驟就移除）。 */
async function registerProject($: $, map: WorkflowMap) {
  const root = await rootOf($)
  const s = stats(map)
  const others = (await readProjects($)).filter(p => p.root !== root)
  const mine: ProjectEntry[] = map.nodes.length
    ? [{ root, title: map.title ?? '', done: s.done, total: s.total, running: s.doing.length, updatedAt: map.updatedAt, planId: await read($, BOUND) }]
    : []
  await $.store.set(PROJECTS_KEY, [...mine, ...others].slice(0, PROJECTS_MAX))
}

/** 唯讀讀取另一個專案的計劃（任何錯誤 → undefined；從不寫入）。 */
async function readForeign($: $, root: string, planId = LEGACY_ID): Promise<WorkflowMap | undefined> {
  try {
    const v = validateMap(JSON.parse(await $.fs.read(`${root}/${planId === LEGACY_ID ? FILE : `${PLANS_DIR}/${planId}.json`}`)))
    return typeof v === 'string' ? undefined : migrate(v, await nowIso($)).map
  } catch {
    return undefined
  }
}

/**
 * 讀一個計劃（預設：這個 session 綁定的）。未綁定 → 空圖。無檔 → 空圖（id = 該計劃）。
 * 舊格式：計劃檔先備份原文再寫入新格式；舊共用檔（default）只在記憶體轉換，不改檔。
 * 損壞：計劃檔備份為 .bad-<ts>.json 再重來；舊共用檔不覆寫，拋出錯誤。讀取失敗（IO）拋出。
 */
export async function loadMap($: $, planId?: string): Promise<WorkflowMap> {
  const id = planId ?? (await read($, BOUND))
  if (!id) return emptyMap(await nowIso($))
  const legacy = id === LEGACY_ID
  const path = await planPathOf($, id)
  if (!(await $.fs.exists(path))) return { ...emptyMap(await nowIso($)), ...(legacy ? {} : { planId: id }) }
  const text = await $.fs.read(path)
  let problem: string
  const stamp = (await nowIso($)).replace(/[:.]/g, '-')
  try {
    const v = validateMap(JSON.parse(text))
    if (typeof v !== 'string') {
      const m = migrate(v, await nowIso($))
      if (m.map === v || legacy) return m.map
      await $.fs.write(path.replace(/\.json$/, `.v${m.from}-backup-${stamp}.json`), text)
      await $.fs.write(path, `${JSON.stringify(m.map, null, 2)}\n`)
      return m.map
    }
    problem = v
  } catch {
    problem = 'invalid JSON'
  }
  if (legacy) throw new Error(`${FILE} cannot be read (${problem}); it was left untouched`)
  const backup = path.replace(/\.json$/, `.bad-${stamp}.json`)
  await $.fs.write(backup, text)
  const empty = { ...emptyMap(await nowIso($)), planId: id }
  await $.fs.write(path, `${JSON.stringify(empty, null, 2)}\n`)
  $.ui.toast(STR[await langNow($)].corrupt(problem, backup.split('/').pop() ?? backup))
  return empty
}

/** 這個專案裏綁了某計劃的 session（由 $.store 的綁定得知）。 */
async function sessionsOn($: $, planId: string): Promise<string[]> {
  const root = await rootOf($)
  const out: string[] = []
  for (const key of await $.store.keys().catch(() => [] as string[])) {
    if (!key.startsWith('bind:')) continue
    const b = (await $.store.get(key).catch(() => undefined)) as Binding | undefined
    if (b && b.root === root && b.planId === planId) out.push(key.slice(5))
  }
  return out
}

/** 計劃檔記下哪些 session 在用（給其他工具看；舊共用檔不寫）。 */
async function recordSessions($: $, planId: string) {
  if (!planId || planId === LEGACY_ID) return
  const path = await planPathOf($, planId)
  if (!(await $.fs.exists(path))) return
  const map = await loadMap($, planId)
  await $.fs.write(path, `${JSON.stringify({ ...map, sessions: await sessionsOn($, planId) }, null, 2)}\n`)
}

/** 綁定（或解除綁定：planId = ''）這個 session 的計劃，並載入它。 */
async function bindPlan($: $, planId: string) {
  const sid = await sessionIdOf($)
  const prev = await read($, BOUND)
  await update($, BOUND, () => planId)
  if (planId) await $.store.set(bindKey(sid), { root: await rootOf($), planId, at: await nowIso($) } satisfies Binding)
  else await $.store.delete(bindKey(sid)).catch(() => undefined)
  undoFor = ''
  undoStack = []
  if (await read($, BEFORE)) await update($, BEFORE, () => '')
  if (await read($, CHANGES)) await update($, CHANGES, () => '')
  const map = await loadMap($, planId).catch(() => emptyMap())
  await update($, MAP, () => map)
  await foldAll($)
  if (prev && prev !== planId) await recordSessions($, prev).catch(() => undefined)
  await recordSessions($, planId).catch(() => undefined)
  if (planId) await registerProject($, map).catch(() => undefined)
}

type PlanInfo = { id: string; title: string; done: number; total: number; running: number; updatedAt: string; sessions: string[] }

/** 這個專案的全部計劃（舊共用檔 + 計劃資料夾；已封存的不列）。 */
async function listPlans($: $): Promise<PlanInfo[]> {
  const root = await rootOf($)
  const ids: string[] = []
  if (await $.fs.exists(`${root}/${FILE}`)) ids.push(LEGACY_ID)
  for (const f of await $.fs.list(`${root}/${PLANS_DIR}`).catch(() => [])) if (f.kind === 'file' && f.name.endsWith('.json') && !f.name.includes('.bad-') && !f.name.includes('-backup-')) ids.push(f.name.slice(0, -5))
  const out: PlanInfo[] = []
  for (const id of ids) {
    try {
      const m = validateMap(JSON.parse(await $.fs.read(await planPathOf($, id))))
      if (typeof m === 'string' || m.archivedAt || m.nodes.length === 0) continue
      const st = stats(m)
      out.push({ id, title: m.title || m.nodes[0]?.title || '', done: st.done, total: st.total, running: st.doing.length, updatedAt: m.updatedAt, sessions: await sessionsOn($, id) })
    } catch {
      // 讀不到：略過
    }
  }
  return out.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
}

/** 未綁定時工具的回覆：說明要怎樣做，並列出可加入的計劃。 */
async function noPlanMessage($: $): Promise<string> {
  const plans = await listPlans($)
  const list = plans.map(p => `"${p.id}" (${p.title || 'untitled'}, ${p.done}/${p.total}${p.sessions.length ? `, ${p.sessions.length} session(s)` : ''})`).join('; ')
  return (
    'No workflow plan is bound to this session (each session has its own plan). Call new_plan {title, nodes} to start one' +
    (list ? `, or op join {plan} to continue an existing plan of this project: ${list}.` : '.')
  )
}

/** 加入（綁定）一個計劃：plan = id，或標題（完全相同優先，其次包含）。 */
async function joinPlan($: $, ref: string): Promise<string> {
  const plans = await listPlans($)
  const q = ref.trim().toLowerCase()
  const hit = plans.find(p => p.id.toLowerCase() === q) ?? plans.find(p => p.title.toLowerCase() === q) ?? plans.find(p => q && p.title.toLowerCase().includes(q))
  const t = STR[await langNow($)]
  if (!hit) return t.planNotFound(ref)
  await bindPlan($, hit.id)
  return t.joined(hit.title || hit.id)
}

const openPane = ($: $, lang: Lang) => $.ui.open({ id: PANE, title: STR[lang].paneTitle })

/**
 * 待辦清單 → 計劃。TodoWrite 每次給整張清單（以內容對照）；TaskCreate／TaskUpdate 逐項（以 task id 對照）。
 * 未綁定計劃：清單有 AUTO_MIN 項以上未完成 → 開一個（步驟依次序；Task 工具給了 blockedBy 就照用），負責人 auto，通知一次。
 * 已綁定：只同步標題相同（或已對照過）的步驟的狀態；由清單自動開的計劃才會加入清單新增的項目。
 */
async function mirrorTodos($: $, e: Record<string, unknown>, result: unknown) {
  const prev = await read($, TODOS)
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  let items: TodoItem[]
  if (e.tool === 'TodoWrite') {
    if (!Array.isArray(e.todos)) return
    items = (e.todos as { content?: unknown; status?: unknown }[])
      .filter(x => typeof x?.content === 'string' && x.content.trim())
      .map(x => {
        const title = String(x.content).trim()
        return { key: title, title, status: String(x.status ?? 'pending'), blockedBy: [], step: prev.items.find(p => p.key === title)?.step }
      })
  } else if (e.tool === 'TaskCreate') {
    const id = (result as { task?: { id?: unknown } } | undefined)?.task?.id
    const title = typeof e.subject === 'string' ? e.subject.trim() : ''
    if (typeof id !== 'string' || !title) return
    items = [...prev.items, { key: id, title, status: 'pending', blockedBy: [] }]
  } else {
    const id = String(e.taskId ?? '')
    items = prev.items.map(p =>
      p.key === id
        ? {
            ...p,
            title: typeof e.subject === 'string' && e.subject.trim() ? e.subject.trim() : p.title,
            status: typeof e.status === 'string' ? e.status : p.status,
            blockedBy: [...new Set([...p.blockedBy, ...strs(e.addBlockedBy)])],
          }
        : strs(e.addBlocks).includes(p.key)
          ? { ...p, blockedBy: [...new Set([...p.blockedBy, id])] }
          : p,
    )
  }
  let plan = prev.plan
  const bound = await read($, BOUND)
  const live = items.filter(i => i.status !== 'deleted')
  // 步驟的 deps：Task 工具給了依賴就照用（沒有依賴的項目並行），否則按清單次序
  const depsOf = (i: TodoItem, before: string | undefined, stepOf: (key: string) => string | undefined) =>
    live.some(x => x.blockedBy.length) ? i.blockedBy.map(stepOf).filter((x): x is string => !!x) : before ? [before] : []
  if (!bound) {
    if (!autoPlanOn || live.filter(i => i.status !== 'completed').length < AUTO_MIN) return void (await update($, TODOS, () => ({ items, plan })))
    const steps = new Map(live.map((i, k) => [i.key, `t${k + 1}`]))
    const nodes = live.map((i, k) => ({
      id: steps.get(i.key)!,
      title: i.title,
      status: TODO_STATUS[i.status] ?? 'todo',
      owner: 'auto',
      deps: depsOf(i, k ? steps.get(live[k - 1]!.key) : undefined, key => steps.get(key)),
    }))
    const r = await applyAndWrite($, { op: 'new_plan', title: live[0]!.title, nodes } as Op, 'auto')
    if ('error' in r) return void (await update($, TODOS, () => ({ items, plan })))
    items = items.map(i => ({ ...i, step: steps.get(i.key) ?? i.step }))
    plan = await read($, BOUND)
    $.ui.toast(STR[await langNow($)].autoPlanMade)
    return void (await update($, TODOS, () => ({ items, plan })))
  }
  const map = await loadMap($)
  const byId = new Map(map.nodes.map(n => [n.id, n]))
  const byTitle = new Map(map.nodes.map(n => [n.title.trim(), n.id]))
  items = items.map(i => ({ ...i, step: i.step && byId.has(i.step) ? i.step : byTitle.get(i.title) }))
  const own = bound === plan
  const nodes: { id: string; title?: string; status: WorkflowNode['status']; owner?: string; deps?: string[] }[] = []
  let n = map.nodes.length
  let before: string | undefined
  for (const i of items) {
    if (i.status === 'deleted') {
      // 刪除：只在清單自己開的計劃上標「放棄」
      if (own && i.step && byId.get(i.step)?.status !== 'dropped') nodes.push({ id: i.step, status: 'dropped' })
      continue
    }
    const want = TODO_STATUS[i.status] ?? 'todo'
    if (!i.step && own) {
      while (byId.has(`t${++n}`));
      i.step = `t${n}`
      byId.set(i.step, { id: i.step, title: i.title, status: want, deps: [] })
      nodes.push({ id: i.step, title: i.title, status: want, owner: 'auto', deps: depsOf(i, before, key => items.find(x => x.key === key)?.step) })
    } else if (i.step && byId.get(i.step)?.status !== want) nodes.push({ id: i.step, status: want })
    before = i.step ?? before
  }
  await update($, TODOS, () => ({ items, plan }))
  if (nodes.length) await applyAndWrite($, { op: 'upsert', nodes } as Op, 'auto')
}

export const register: Register = (on, options) => {
  languageSetting = (options as { language?: unknown } | undefined)?.language ?? 'auto'
  suggestionsOn = (options as { suggestions?: unknown } | undefined)?.suggestions !== false
  notifyOn = (options as { notify?: unknown } | undefined)?.notify !== false
  autoPlanOn = (options as { autoPlan?: unknown } | undefined)?.autoPlan !== false
  const stale = Number((options as { staleMinutes?: unknown } | undefined)?.staleMinutes ?? 30)
  staleMinutes = Number.isFinite(stale) && stale >= 0 ? stale : 30

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'workflow_map', description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false })
    await refreshTheme($)
    // 還原快照：新 session 由檔案重新讀
    undoFor = ''
    undoStack = []
    const expanded = (await $.store.get('expanded')) === true
    await update($, EXPANDED, () => expanded)
    const storedLang = await $.store.get(LANG_KEY)
    if (typeof storedLang === 'string') await update($, LANG, () => storedLang)
    // 這個 session 綁定的計劃（重新載入外掛或繼續同一個 session 時保留；新 session 未綁定）
    const binding = (await $.store.get(bindKey(await sessionIdOf($))).catch(() => undefined)) as Binding | undefined
    const planId = binding && binding.root === (await rootOf($)) && typeof binding.planId === 'string' ? binding.planId : ''
    await update($, BOUND, () => planId)
    let map = emptyMap()
    try {
      map = await loadMap($)
      await update($, MAP, () => map)
      if (planId) await registerProject($, map).catch(() => undefined)
    } catch (err) {
      $.ui.toast(STR[await langNow($)].readFail(String(err).slice(0, 200)))
    }
    const t = STR[await langNow($)]
    await $.command
      .register({ name: 'workflow', description: t.commandDesc })
      .catch(() => $.command.register({ name: 'workflow-map', description: t.commandDesc }))
    await $.command.register({ name: 'workflow-demo', description: t.demoDesc }).catch(() => undefined)
    let lastMtime = -1
    $.clock.every(3000, async () => {
      const nowMs = await $.clock.now()
      const minute = Math.floor(nowMs / 60_000)
      if (minute !== (await read($, TICK)) && (await shownMap($)).nodes.some(n => n.status === 'doing')) {
        await update($, TICK, () => minute)
        // 久未更新：每步每次（以最後更新時間為準）只通知一次
        const t = STR[await langNow($)]
        for (const n of (await read($, MAP)).nodes)
          if (isStale(n, nowMs, staleMinutes)) notifyOnce($, `${n.id}:stale:${n.updatedAt ?? n.startedAt ?? ''}`, t.nStale(n.title, staleMinutes))
      }
      try {
        const bound = await read($, BOUND)
        if (!bound) return
        const path = await planPathOf($, bound)
        const st = await $.fs.stat(path)
        if (st.mtimeMs === lastMtime) return
        lastMtime = st.mtimeMs
        const raw = validateMap(JSON.parse(await $.fs.read(path)))
        if (typeof raw === 'string') return
        // 別的工具寫入的舊格式：畫面先用轉換後的樣子，下次經工具寫入時才落檔
        const v = migrate(raw, await nowIso($)).map
        if (JSON.stringify(v) !== JSON.stringify(await read($, MAP))) await update($, MAP, () => v)
      } catch {
        // 檔案不存在或寫到一半：下次再看
      }
    })
    return next(e)
  })

  on('tool.call', { tool: TOOL }, ($, e) => serveTool($, e as Record<string, unknown>)).catch(($, e, next) => ({
    deny: `workflow_map failed (${next.error?.kind ?? 'unknown'}); nothing was changed.`,
  }))

  on('config.set', async ($, e, next) => {
    const r = await next(e)
    if (e.key === 'theme') await refreshTheme($)
    return r
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!e.tools.includes(TOOL)) return r
    return { sections: [...r.sections, { id: 'workflow-map:guide', text: autoPlanOn ? GUIDE : GUIDE_MIN, scope: 'session' as const }] }
  })

  // 安全網（模型忘了開計劃）：主對話用內建待辦清單（TodoWrite／TaskCreate／TaskUpdate）→ 鏡像成計劃並同步狀態。
  // 一次只處理一個（同一則回覆內的幾個 TaskCreate 不會互相蓋掉）。
  on('tool.call', { tool: ['TodoWrite', 'TaskCreate', 'TaskUpdate'] }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && r.result !== undefined && !r.isError) {
      const input = e as unknown as Record<string, unknown>
      const job = todoChain.then(() => mirrorTodos($, input, r.result))
      todoChain = job.catch(() => undefined)
      await todoChain
    }
    return r
  })

  // 主對話的實際工作（改檔、執行指令）：數本輪次數，給「可用 /workflow」提示
  on('tool.call', { tool: WORK_TOOLS }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && r.result !== undefined) await update($, WORK, n => n + 1)
    return r
  })

  // 安全網：計劃進行中用戶再發訊息 → 標示「未記錄」並提示模型一句；不自動新增步驟。
  // 只算用戶親手輸入的訊息（composer／bridge）：子代理通知、其他 session、排程、外掛的文字都不算，
  // 否則它們的簡體字會把介面語言改走，亦會誤標「新要求未記錄」。
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    // 介面語言跟用戶：以用戶最近一次輸入的文字判斷，存起來（不看模型寫的步驟名稱）
    const detected = detectLang(e.text)
    if (detected && detected !== (await read($, LANG))) {
      await update($, LANG, () => detected)
      await $.store.set(LANG_KEY, detected)
    }
    // 新訊息：上一則「未記錄」的提示收起（每則訊息只提示一次）
    if (await read($, UNRECORDED)) await update($, UNRECORDED, () => '')
    // 「好」「ok」「繼續」、只有圖片、很短的訊息：不算新要求
    if (!isActive(await read($, MAP)) || !looksLikeRequest(e.text)) return next(e)
    await update($, PENDING, () => true)
    await update($, ASKED, () => e.text)
    return next({ ...e, context: [...(e.context ?? []), HINT] })
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, TURN_AT, () => now)
    // 新一輪開始：收起上一輪的建議和提示，重新數工作次數
    if ((await read($, SUGGEST)).kind !== 'hidden') await update($, SUGGEST, () => ({ kind: 'hidden' }) as SuggestView)
    if ((await read($, NUDGE)) === 1) await update($, NUDGE, () => 2)
    await update($, WORK, () => 0)
    return next(e)
  })

  // 子代理開始：描述或任務內有 [wm:<id>] 而且步驟存在 → 該步驟 doing、負責人 = 子代理。沒有標記就不猜。
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = WM_TAG.exec(`${e.description ?? ''}\n${e.prompt ?? ''}`)?.[1]
    const agentId = 'agentId' in r ? r.agentId : undefined
    if (!id || !agentId) return r
    try {
      const owner = (e as { name?: string }).name || e.subagentType
      if ((await loadMap($)).nodes.some(n => n.id === id)) {
        const res = await applyAndWrite($, { op: 'upsert', nodes: [{ id, status: 'doing', owner }] }, owner)
        if (!('error' in res)) await update($, AGENTS, a => ({ ...a, [agentId]: id }))
      }
    } catch {
      // 同步失敗不影響子代理
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    // 子代理完成：答完 → done；出錯／被中止／拒絕 → blocked
    const linked = e.agentId === undefined ? undefined : (await read($, AGENTS))[e.agentId]
    if (e.agentId !== undefined && linked) {
      const agentId = e.agentId
      await update($, AGENTS, a => Object.fromEntries(Object.entries(a).filter(([k]) => k !== agentId)))
      try {
        await applyAndWrite(
          $,
          e.reason === 'answer' ? { op: 'status', id: linked, status: 'done' } : { op: 'status', id: linked, status: 'blocked', note: `agent ended: ${e.reason}` },
          agentId,
          true,
        )
      } catch {
        // 步驟可能已被刪除：略過
      }
    }
    if (e.agentId === undefined) {
      // 這一輪完了仍沒有任何工作流程操作：把那句要求留在橫條（未記錄：…［加入計劃］）
      if (await read($, PENDING)) {
        const asked = await read($, ASKED)
        await update($, PENDING, () => false)
        if (asked.trim()) await update($, UNRECORDED, () => asked)
      }
      const done = allDone(await read($, MAP))
      await update($, DONE_TURNS, n => (done ? n + 1 : 0))
      // 做了不少工作仍未有計劃：橫條提示一行（每個 session 一次）
      if ((await read($, NUDGE)) === 0 && (await read($, WORK)) >= NUDGE_AFTER && !(await read($, BOUND))) await update($, NUDGE, () => 1)
    }
    const result = await next(e)
    // 主對話答完（夠長）：另開一條（fork）問「用戶下一句最可能說甚麼」，不阻住這一輪的完成
    if (suggestionsOn && e.agentId === undefined && e.reason === 'answer' && (e.answer ?? '').trim().length >= MIN_ANSWER_CHARS) {
      const turnId = e.turnId
      await update($, SUGGEST, () => ({ kind: 'loading', turnId }) as SuggestView)
      void (async () => {
        const lang = await langNow($)
        const typed = await read($, LANG)
        const items = await computeSuggestions($, {
          map: await read($, MAP),
          lead: STR[lang].continueLead,
          forced: LANGS.includes(languageSetting as Lang) ? (languageSetting as Lang) : undefined,
          typed: LANGS.includes(typed as Lang) ? (typed as Lang) : undefined,
        })
        // 等候期間開始了新一輪（或另一輪完成）：作廢
        const now = await read($, SUGGEST)
        if (now.kind !== 'loading' || now.turnId !== turnId) return
        await update($, SUGGEST, () => (items.length ? { kind: 'offer', items } : { kind: 'hidden' }) as SuggestView)
        if (items[0]) void $.prompt.suggest({ text: items[0].prompt }).catch(() => undefined)
      })()
    }
    return result
  })

  // /workflow-demo：基本示範（開／關）；/workflow-demo team：團隊示範，並把全圖切到流程圖
  on('command.run', { command: 'workflow-demo' }, async ($, e) => {
    const team = /^team$/i.test(String((e as { args?: unknown }).args ?? '').trim())
    const want = team ? 'team' : 'basic'
    const next = (await read($, DEMO)) === want ? '' : want
    await update($, DEMO, () => next)
    if (next === 'team') await update($, DIAGRAM, () => true)
    const t = STR[await langNow($)]
    return { text: next === 'team' ? t.demoTeamOn : next ? t.demoOn : t.demoOff }
  })

  on('command.run', { command: ['workflow', 'workflow-map'] }, async ($, e) => {
    const map = await shownMap($)
    const lang = await langNow($)
    await foldAll($)
    const arg = String((e as { args?: unknown }).args ?? '').trim().toLowerCase()
    // /workflow export：寫 Markdown 檔並複製
    if (arg === 'export') return { text: await exportPlan($) }
    // /workflow join <id|標題>、/workflow leave
    const rawArg = String((e as { args?: unknown }).args ?? '').trim()
    if (/^join\s+/i.test(rawArg)) {
      const msg = await joinPlan($, rawArg.replace(/^join\s+/i, ''))
      $.ui.toast(msg)
      return { text: msg }
    }
    if (arg === 'leave') {
      await bindPlan($, '')
      const msg = STR[lang].left
      $.ui.toast(msg)
      return { text: msg }
    }
    // /workflow undo：還原上一次寫入
    if (arg === 'undo') {
      const msg = await undoPlan($)
      $.ui.toast(msg)
      return { text: msg }
    }
    // /workflow diagram：以流程圖打開全圖
    if (/^(diagram|flow|流程圖)$/i.test(arg)) await update($, DIAGRAM, () => true)
    // /workflow help：打開全圖並展開說明卡
    const wantHelp = /^(help|說明|说明|\?)$/i.test(arg)
    if (wantHelp !== (await read($, HELP_OPEN))) await update($, HELP_OPEN, () => wantHelp)
    await openPane($, lang)
    return { text: map.nodes.length ? `${STR[lang].paneOpened} ${compactLine(map, lang)}` : STR[lang].empty }
  })

  // 輸入框上方（一條橫條，所有行同一條左邊）：
  //   標題行「● 進行中  下一步：…  ━━━── 6/11  ˅ ⤢」→（展開時）卡片圖 →（有建議時）建議行「✦ 1 … · 2 … · 3 …  ✕」。
  // 建議行的 ✦ 與標題行的狀態點同一欄；✕ 與右上兩個控制同一條右邊。沒有計劃時只畫建議行。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const map = await shownMap($)
    const showPlan = map.nodes.length > 0 && !(allDone(map) && (await read($, DONE_TURNS)) >= 2) // 全部完成後只顯示一輪
    const sv: SuggestView = suggestionsOn && !e.props.isWorking ? await read($, SUGGEST) : { kind: 'hidden' }
    const nudge = !showPlan && (await read($, NUDGE)) === 1
    if (!showPlan && sv.kind === 'hidden' && !nudge) return next(e)
    // 下面其他外掛的橫條照畫（在我們之上）
    let below: RenderChildren = null
    try {
      below = await next(e)
    } catch {
      below = null
    }
    const lang = await langNow($)
    const t = STR[lang]
    const expanded = await read($, EXPANDED)
    const pending = await read($, PENDING)
    const unrecorded = await read($, UNRECORDED)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const T = await themeOf($)
    // 兩個控制；按鍵 e／f（終端機：ctrl+x tab 讓橫條取得焦點後按，按鈕畫成「e: 展開」）
    const controls = (
      <Box key="ctl" flexDirection="row" flexShrink={0} alignItems="center" gap={SPACE.GAP}>
        <Button key="toggle" {...ICON_BTN} hotkey="e" label={expanded ? t.collapseTip : t.expandTip} onPress={() => toggle($)} />
        <Button key="open" {...ICON_BTN} hotkey="f" label={t.openTip} onPress={() => openPane($, lang)} />
      </Box>
    )
    // 未記錄的要求（一輪完了模型沒有記入）：「未記錄：開頭 16 字…」［加入計劃］✕ —— 加入計劃只把草稿放入輸入框，從不自動送出
    const clearUnrecorded = () => update($, UNRECORDED, () => '')
    const unrecordedRow = unrecorded
      ? [
          <Box key="unrec" flexShrink={1} minWidth={0} overflow="hidden">
            <Text color="warning" wrap="truncate-end">
              {t.unrecorded(snippet(unrecorded, 16))}
            </Text>
          </Box>,
          <Box key="unrec-add" flexShrink={0}>
            <Button
              key="add-to-plan"
              {...ICON_BTN}
              hotkey="a"
              label={t.addToPlan}
              onPress={async () => {
                await clearUnrecorded()
                void $.prompt.fill({ text: t.addToPlanDraft(unrecorded) }).then(
                  r => r.isFilled || $.ui.toast(t.fillFail),
                  () => $.ui.toast(t.fillFail),
                )
              }}
            />
          </Box>,
          <Box key="unrec-x" flexShrink={0}>
            <Button key="unrecorded-dismiss" role="dismiss" hotkey="x" plain label="✕" onPress={clearUnrecorded} />
          </Box>,
        ]
      : null
    // 「未記錄」一組佔的格數（字 + 按鈕 + ✕ + 間距）：標題行左邊的「下一步」按這個讓位，不會被切走半個字
    const unrecordedCells = unrecorded ? cells(t.unrecorded(snippet(unrecorded, 16))) + cells(t.addToPlan) + 2 + 3 * SPACE.GAP + 4 : 0
    // 終端機：一段段帶主題色的字排成一行（不換行）
    const segLine = (key: string, segs: readonly Seg[]) => (
      <Box key={key} flexDirection="row" flexShrink={0}>
        {segs.map(s => (
          <Text color={s.color} dimColor={s.dim} bold={s.bold}>
            {s.text}
          </Text>
        ))}
      </Box>
    )

    // ---- 建議行 ----
    let suggestRow: RenderChildren = null
    if (sv.kind !== 'hidden') {
      // ✦ 在一個不會被壓扁的格內（同標題行狀態點同一欄；格闊 = 標題行文字開始的位置，第一個建議由同一條線開始）。
      // 之前它與建議按鈕同在一行、可被壓縮，長建議會把它壓到 0 闊（真機看不見）。
      const star = (
        <Box key="star" flexShrink={0} width={Svg ? undefined : 2}>
          {Svg ? <Svg source={starPic(T).source} alt="✦" width={STAR_W} height={20} /> : <Text color="claude">✦</Text>}
        </Box>
      )
      if (sv.kind === 'loading') {
        suggestRow = (
          <Box key="suggest" flexDirection="row" alignItems="center" gap={0}>
            {star}
            <Text color="claude">…</Text>
          </Box>
        )
      } else {
        // 一行：放得下幾個就畫幾個（至少一個，太長會截斷），不換行
        const labels = sv.items.map(item => fitCells(item.label, CAPSULE_CELLS))
        let shown = labels.length
        const width = (n: number) => labels.slice(0, n).reduce((sum, l) => sum + cells(l) + CAPSULE_CHROME, 0)
        while (shown > 1 && width(shown) > e.props.bodyColumns - ROW_CHROME) shown--
        const hide = () => update($, SUGGEST, () => ({ kind: 'hidden' }) as SuggestView)
        suggestRow = (
          <Box key="suggest" flexDirection="row" alignItems="center" gap={0}>
            {star}
            {sv.items.slice(0, shown).flatMap((item, index) => [
              ...(index > 0 ? [<Text dimColor>{' · '}</Text>] : []),
              <Box key={`s${index}`} flexShrink={1}>
                <Button
                  key={`pick${index + 1}`}
                  hotkey={String(index + 1)}
                  {...ICON_BTN}
                  label={labels[index] ?? item.label}
                  onPress={async () => {
                    await hide()
                    void $.prompt.fill({ text: item.prompt }).then(
                      r => r.isFilled || $.ui.toast(t.fillFail),
                      () => $.ui.toast(t.fillFail),
                    )
                  }}
                />
              </Box>,
            ])}
            <Box flexGrow={1} />
            <Button key="dismiss" role="dismiss" hotkey="0" plain label="✕" onPress={hide} />
          </Box>
        )
      }
    }

    let planRows: RenderChildren = null
    if (showPlan && !Svg) {
      // 終端機版：標題行「◉ 名稱 +2  下一步：…   ━━ ━━ ━━  5/12 ≈ 1時  e: 展開  f: 全圖」→（展開時）字元畫的卡片圖
      const cols = Math.max(40, e.props.bodyColumns || 100)
      const view = stageView(map, { freshSince: await read($, TURN_AT) })
      const clock = await clockOf($)
      const ctlW = cells(expanded ? t.collapseTip : t.expandTip) + cells(t.openTip) + 3 * 2 + SPACE.GAP
      const head = headerSegs(map, view, lang, clock, cols - ctlW - 2 - unrecordedCells, pending, etaText(map, clock.now, lang, true))
      const g = expanded ? bandCards(map, view, lang, clock, cols - 1) : undefined
      planRows = [
        <Box key="title" flexDirection="row" alignItems="center">
          <Box flexShrink={1} overflow="hidden">
            {segLine('lead', head.left)}
          </Box>
          <Box flexGrow={1} minWidth={2} />
          {segLine('meter', head.right)}
          <Box width={2} flexShrink={0} />
          {unrecordedRow}
          {controls}
        </Box>,
        g ? (
          <Box key="graph" flexDirection="column">
            {g.lines.map((l, i) => segLine(`g${i}`, l))}
          </Box>
        ) : null,
      ]
    } else if (showPlan && Svg) {
      const view = stageView(map, { freshSince: await read($, TURN_AT) })
      // 可用闊度：欄數 × 每格 px（寧小勿大），扣去兩個按鈕
      const avail = Math.max(240, Math.round((e.props.bodyColumns || 100) * PX_PER_COL) - 56 - Math.round(unrecordedCells * PX_PER_COL))
      const clock = await clockOf($)
      const eta = etaText(map, clock.now, lang, true)
      const etaN = etaRange(map, clock.now)?.n ?? 0
      const head = bandHeader(map, view, lang, T, avail, pending, clock, eta)
      const graph = expanded ? bandGraph(map, view, lang, T, avail + 56, clock) : undefined
      // 指著兩端小卡時的清單（無 hook：有 key 的 Box 是 hover 範圍，裏面藏一個沒有 key、display:none 的 Box，hover 時 display:flex）。
      // position:absolute、bottom={1}：向上開（下面是輸入框），底邊貼住小卡頂。清單是父 Box 的一部分：指標由小卡移到清單上仍然打開。
      // 固定闊度；每項兩行：[圖示][標題]／[空位][淡色提示（稍後：等甚麼；已完成：負責人 · 用時）]，兩行都只一行、省略號，不換行；
      // 項與項之間一格；最多 PEEK_MAX 項，多的在最後一行（上面一條 app 的分隔線）：「… 還有 N 項 · 全圖」，全圖是按鈕。
      const ready = readyIds(map.nodes)
      const byId = new Map(map.nodes.map(n => [n.id, n]))
      const peekFill = PEEK_FILL[(await read($, LIGHT)) ? 'light' : 'dark']
      const popW = Math.min(PEEK_W, (e.props.bodyColumns || 100) - 4)
      const textW = popW - 2 * SPACE.PAD - 2 - 4 // 框、內距、圖示欄（20px ≈ 3 格）與間距
      const Markdown = 'Markdown' in table ? table.Markdown : undefined
      const peekLine = (icon: RenderChildren, text: string, dim: boolean) => (
        <Box flexDirection="row" alignItems="center" gap={SPACE.GAP}>
          <Box flexShrink={0}>{icon}</Box>
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Text dimColor={dim} wrap="truncate-end">
              {fitCells(text, textW) || ' '}
            </Text>
          </Box>
        </Box>
      )
      const peek = (
        rows: { n: (typeof map.nodes)[number]; hint: string }[],
        more: number,
        anchor: { left: number } | { right: number },
        full: { key: string; open: () => Promise<unknown> },
      ) => (
        <Box
          position="absolute"
          bottom={1}
          {...anchor}
          width={popW}
          display="none"
          hover={{ display: 'flex' }}
          flexDirection="column"
          gap={SPACE.GAP}
          padding={SPACE.PAD}
          borderStyle="round"
          borderColor={CARD_EDGE}
          backgroundColor={peekFill}
        >
          {rows.map(({ n, hint }) => (
            <Box flexDirection="column">
              {peekLine(<Svg source={iconPic(kindOf(n, ready, clock), insHot(n, clock), T).source} alt={t.status[n.status]} width={ICON_COL} height={ICON_COL} />, `${insMark(n, clock) ? '◇ ' : ''}${n.title}`, false)}
              {peekLine(<Svg source={slotPic(T).source} alt="" width={ICON_COL} height={ICON_COL} />, hint, true)}
            </Box>
          ))}
          {more > 0 ? (Markdown ? <Markdown text="---" /> : null) : null}
          {more > 0 ? (
            <Box flexDirection="row" alignItems="center">
              <Box flexShrink={1} minWidth={0} overflow="hidden">
                <Text dimColor wrap="truncate-end">{`${t.peekMore(more)} · `}</Text>
              </Box>
              <Box flexShrink={0}>
                <Button key={full.key} {...ICON_BTN} label={t.openTip} onPress={full.open} />
              </Box>
            </Box>
          ) : null}
        </Box>
      )
      const waitsOf = (n: (typeof map.nodes)[number]) => {
        const w = n.deps.map(d => byId.get(d)).filter(d => d && isStep(d) && d.status !== 'done')
        return w.length ? t.waitShort(w.map(d => d!.title).join(t.list)) : ''
      }
      const laterRows = (graph?.hiddenSteps ?? []).map(n => ({ n, hint: waitsOf(n) }))
      const doneRows = view.done.map(n => ({ n, hint: metaOf(n, lang, clock) }))
      // 稍後清單的位置：幽靈卡右邊到橫條左邊放得下就向左開（右邊對齊幽靈卡），否則左邊貼橫條左邊（不出界）。
      // 這裏的格寬用偏大的 PX_PER_COL_MAX：估錯只會令清單留在橫條內。
      const ghostLeftPx = (graph?.done?.width ?? 0) + (graph?.main?.width ?? 0)
      const laterAnchor =
        (ghostLeftPx + (graph?.ghost?.width ?? 0)) / PX_PER_COL_MAX >= popW ? { right: 0 } : { left: -Math.floor(ghostLeftPx / PX_PER_COL_MAX) }
      // 「全圖」：打開全圖並展開對應的一段（稍後／已完成）
      const openLater = async () => {
        await update($, FUTURE_OPEN, () => true)
        await openPane($, lang)
      }
      const openDone = async () => {
        await update($, DONE_OPEN, () => true)
        await openPane($, lang)
      }
      const s = stats(map)
      planRows = [
        <Box key="title" flexDirection="row" alignItems="center" gap={SPACE.GAP}>
          {/* 圖片模式（非 isInteractive）：透明底；寬高 = viewBox，1:1 不縮放。左右兩張圖之間由空白撐開，進度條永遠貼住按鈕 */}
          <Box flexShrink={1} overflow="hidden">
            <Svg source={head.lead.source} alt={compactLine(map, lang)} width={head.lead.width} height={head.lead.height} />
          </Box>
          <Box flexGrow={1} />
          <Box flexShrink={0}>
            <Svg
              source={head.meter.source}
              alt={[t.progressTip(s.done, s.total), eta ? t.etaTip(eta, etaN) : '', pending ? t.unloggedTip : ''].filter(Boolean).join('\n')}
              width={head.meter.width}
              height={head.meter.height}
            />
          </Box>
          {unrecordedRow}
          {controls}
        </Box>,
        graph ? (
          // 一行三張圖，中間沒有空隙（線接得上）：[已完成小卡]（指著：已完成清單）[各層的卡][稍後幽靈卡]（指著：稍後清單）
          <Box key="graph" flexDirection="row" alignItems="flex-start" gap={0}>
            {graph.done ? (
              <Box key="peek-done" flexShrink={0}>
                <Svg source={graph.done.source} alt={t.doneCard(view.done.length)} width={graph.done.width} height={graph.done.height} />
                {peek(doneRows.slice(-PEEK_MAX), Math.max(0, doneRows.length - PEEK_MAX), { left: 0 }, { key: 'peek-full-done', open: openDone })}
              </Box>
            ) : null}
            {graph.main ? (
              <Box key="graph-main" flexShrink={0}>
                <Svg source={graph.main.source} alt={plainLines(map, lang).join('\n')} width={graph.main.width} height={graph.main.height} />
              </Box>
            ) : null}
            {graph.ghost ? (
              <Box key="peek-later" flexShrink={0}>
                <Svg source={graph.ghost.source} alt={t.laterCard(graph.hiddenSteps.length)} width={graph.ghost.width} height={graph.ghost.height} />
                {peek(laterRows.slice(0, PEEK_MAX), Math.max(0, laterRows.length - PEEK_MAX), laterAnchor, { key: 'peek-full-later', open: openLater })}
              </Box>
            ) : null}
          </Box>
        ) : null,
      ]
    }
    return (
      <Box flexDirection="column">
        {below}
        <Box key="workflow-map" flexDirection="column">
          {planRows}
          {nudge ? (
            <Box key="nudge">
              <Text dimColor>{t.nudge}</Text>
            </Box>
          ) : null}
          {suggestRow}
        </Box>
      </Box>
    )
  })

  // 全圖面板（間距系統見檔頭 SPACE）：標題行（進度條可縮 → 16 / 23 · 狀態 → 收放按鈕，貼右邊）→ 卡（由上而下）→ 歷史卡。
  // 卡框 = Box 圓角邊框，介面撐滿闊度；卡內每一行都是 [圖示欄 20px][GAP][文字]：卡頭、步驟、第二行、詳情都對齊同一條線。
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const lang = await langNow($)
    const t = STR[lang]
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    // 唯讀檢視另一個專案：讀它的檔（不寫），沒有還原／匯出／歷史
    const viewRoot = await read($, VIEW_ROOT)
    const ownRoot = await rootOf($)
    const foreign = viewRoot !== '' && viewRoot !== ownRoot ? viewRoot : undefined
    const foreignEntry = foreign ? (await readProjects($)).find(p => p.root === foreign) : undefined
    const foreignMap = foreign ? await readForeign($, foreign, foreignEntry?.planId || LEGACY_ID) : undefined
    const current = foreign ? (foreignMap ?? emptyMap()) : await shownMap($)
    // 一個中途要求的「插入前／插入後」（都是唯讀）：插入前 = 快照（SNAP_DIR/<planId>/<id>.json；示範時由示範資料拿走插入的步驟推算）；
    // 插入後 = 現在的計劃，加上由快照到現在的改動標記（planDiff）
    const beforeId = foreign ? '' : await read($, BEFORE)
    const changesId = foreign || beforeId ? '' : await read($, CHANGES)
    const reqId = beforeId || changesId
    const beforeNode = reqId ? current.nodes.find(n => n.id === reqId) : undefined
    const snap = reqId ? await snapshotOf($, current, reqId) : undefined
    const beforeMap = beforeId ? snap : undefined
    // 「階段 a → b」按畫面的編號：階段卡 = 未完成步驟按依賴分層；流程圖 = 組所在的行
    const cardStages = (m: WorkflowMap) => new Map(stageView(m, { expandDone: true, expandFuture: true, smallPlan: Infinity }).levels.flatMap((lv, i) => lv.map(n => [n.id, i + 1] as const)))
    const diff = changesId && snap ? planDiff(snap, current, cardStages) : undefined
    const map = beforeId ? (beforeMap ?? emptyMap()) : current
    const diagram = await read($, DIAGRAM)
    const projectName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root
    const backButton = <Button key="project-back" {...ICON_BTN} label={`← ${t.back}`} onPress={() => update($, VIEW_ROOT, () => '')} />
    const banner = foreign ? (
      <Box key="viewing" flexDirection="row" alignItems="center" gap={SPACE.GAP}>
        {backButton}
        <Text bold>{t.viewing(projectName(foreign))}</Text>
      </Box>
    ) : null
    const titlesOf = (ids: readonly string[]) => ids.map(id => current.nodes.find(n => n.id === id)?.title ?? id).join(t.list)
    const leaveRequest = async () => {
      await update($, BEFORE, () => '')
      await update($, CHANGES, () => '')
    }
    // 頂部一行：返回 · 插入前 | 插入後（目前的一邊不淡）· 說明；插入後再加一行圖例
    const beforeBanner = reqId ? (
      <Box key="before" flexDirection="column">
        <Box flexDirection="row" alignItems="center" gap={SPACE.GAP}>
          <Button key="before-back" {...ICON_BTN} label={`← ${t.back}`} onPress={leaveRequest} />
          <Button
            key="side-before"
            plain
            dimColor={!beforeId}
            label={t.sideBefore}
            onPress={async () => {
              await update($, CHANGES, () => '')
              await update($, BEFORE, () => reqId)
            }}
          />
          <Text dimColor>|</Text>
          <Button
            key="side-after"
            plain
            dimColor={!changesId}
            label={t.sideAfter}
            onPress={async () => {
              await update($, BEFORE, () => '')
              await update($, CHANGES, () => reqId)
            }}
          />
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Text dimColor wrap="truncate-end">
              {beforeId ? t.beforeBanner(beforeNode?.title ?? reqId) : t.changesBanner(beforeNode?.title ?? reqId)}
            </Text>
          </Box>
        </Box>
        {diff ? (
          <Box key="legend">
            <Text dimColor wrap="truncate-end">
              {t.diffLegend}
            </Text>
          </Box>
        ) : null}
        {beforeId && beforeNode?.impact
          ? [
              beforeNode.impact.added.length ? t.diffAdded(titlesOf(beforeNode.impact.added)) : '',
              beforeNode.impact.rewired.length ? t.diffRewired(titlesOf(beforeNode.impact.rewired)) : '',
            ]
              .filter(Boolean)
              .map((l, i) => (
                <Box key={`diff-${i}`}>
                  <Text dimColor wrap="truncate-end">
                    {l}
                  </Text>
                </Box>
              ))
          : null}
      </Box>
    ) : null
    if (reqId && !snap)
      return (
        <Box flexDirection="column" paddingLeft={PANE_INSET} gap={SPACE.GAP}>
          {beforeBanner}
          <Text dimColor>{t.beforeMissing}</Text>
        </Box>
      )
    if (foreign && !foreignMap)
      return (
        <Box flexDirection="column">
          {banner}
          <Text dimColor>{t.unavailable}</Text>
        </Box>
      )
    const projectsOpen = await read($, PROJECTS_OPEN)
    const plansOpen = await read($, PLANS_OPEN)
    if (map.nodes.length === 0 && !projectsOpen && !plansOpen) {
      // 未綁定計劃：說明 + 打開「計劃」清單可以加入本專案的計劃
      return (
        <Box flexDirection="column" paddingLeft={PANE_INSET} gap={SPACE.GAP}>
          {beforeBanner}
          <Text dimColor>{(await read($, BOUND)) ? t.empty : t.noPlanBound}</Text>
          {reqId ? null : (
            <Box flexDirection="row">
              <Button key="plans" {...ICON_BTN} label={t.plans} onPress={() => update($, PLANS_OPEN, () => true)} />
            </Box>
          )}
        </Box>
      )
    }
    const doneOpen = await read($, DONE_OPEN)
    // 插入後的改動：稍後的步驟一併展開（受影響的步驟多在後面）
    const futureOpen = (await read($, FUTURE_OPEN)) || !!diff
    const turnAt = await read($, TURN_AT)
    const pending = await read($, PENDING)
    const selected = await read($, SELECTED)
    const clock = await clockOf($)
    const T = await themeOf($)
    const view = stageView(map, { freshSince: turnAt, expandDone: doneOpen, expandFuture: futureOpen })
    // 收放按鈕只在有東西可收時出現（以「不展開」時的視圖判斷）
    const base = stageView(map, { freshSince: turnAt })
    const historyOpen = await read($, HISTORY_OPEN)
    // 分段（原生面板的「Running」「Finished 172 ⌄」）：進行中、接著、已完成 N ⌄、稍後 N ⌄（後兩段可收起）
    const doneShown = doneOpen || !base.foldDone
    // 工具列（標題行下一行，貼右）：匯出、歷史、說明
    const timelineOpen = await read($, TIMELINE_OPEN)
    const readOnly = !!foreign || !!reqId
    const tools = [
      { key: 'diagram', label: diagram ? t.stagesBtn : t.diagramBtn, onPress: () => update($, DIAGRAM, v => !v) },
      ...(readOnly ? [] : [{ key: 'timeline', label: timelineOpen ? t.hideTimeline : t.timelineBtn, onPress: () => update($, TIMELINE_OPEN, v => !v) }]),
      ...(readOnly
        ? []
        : [
            { key: 'undo', label: t.undoBtn, onPress: async () => $.ui.toast(await undoPlan($)) },
            { key: 'export', label: t.exportBtn, onPress: async (press: UiPressArgument) => $.ui.toast(await exportPlan($, press.surface)) },
            { key: 'history', label: historyOpen ? t.hideHistory : t.history, onPress: () => update($, HISTORY_OPEN, v => !v) },
          ]),
      ...(readOnly ? [] : [{ key: 'plans', label: plansOpen ? t.hidePlans : t.plans, onPress: () => update($, PLANS_OPEN, v => !v) }]),
      ...(reqId ? [] : [{ key: 'projects', label: projectsOpen ? t.hideProjects : t.projects, onPress: () => update($, PROJECTS_OPEN, v => !v) }]),
    ]
    const plans = plansOpen && !foreign ? await listPlans($) : []
    const mySession = await sessionIdOf($)
    const myPlan = await read($, BOUND)
    const projects = projectsOpen ? await readProjects($) : []
    const helpOpen = await read($, HELP_OPEN)
    // 說明卡的語言：分頁選的，否則介面語言
    const pickedHelp = await read($, HELP_LANG)
    const hl: Lang = LANGS.includes(pickedHelp as Lang) ? (pickedHelp as Lang) : lang
    const hs = STR[hl]
    const s = stats(map)
    const cards = paneCards(map, view, { lang, doneOpen: true, clock })
    const history = historyOpen && !foreign ? await readHistory($) : []
    const cols = (e.props as { bodyColumns?: number }).bodyColumns ?? 100
    const slot = Svg ? slotPic(T) : undefined
    const fill = Svg ? CARD_FILL[(await read($, LIGHT)) ? 'light' : 'dark'] : undefined
    const btn = (key: string, label: string, onPress: (press: UiPressArgument) => unknown) => <Button key={key} {...ICON_BTN} label={label} onPress={onPress} />
    const segLine = (key: string, segs: readonly Seg[]) => (
      <Box key={key} flexDirection="row" flexShrink={0}>
        {segs.map(x => (
          <Text color={x.color} dimColor={x.dim} bold={x.bold}>
            {x.text}
          </Text>
        ))}
      </Box>
    )
    // 卡內行與行之間：app 自己的分隔線（Markdown 的 ---）；終端機的 Markdown 不畫成線，改用一行 ─（卡內闊 = 面板闊 − 內距 − 框）
    const Markdown = 'Markdown' in table ? table.Markdown : undefined
    const divider = (key: string) =>
      !Svg ? (
        <Box key={key} flexShrink={0}>
          <Text color="subtle">{'─'.repeat(Math.max(8, cols - PANE_INSET - 4))}</Text>
        </Box>
      ) : Markdown ? (
        <Markdown key={key} text="---" />
      ) : null
    // 圖示欄：桌面 20px 圖，終端機 1 個字；沒有圖示時是同闊的空位
    const iconCol = (k: Kind | undefined, ins: boolean, alt: string, fresh = false) =>
      Svg ? (
        k ? (
          <Svg source={iconPic(k, ins, T, fresh).source} alt={alt} width={ICON_COL} height={ICON_COL} />
        ) : (
          <Svg source={slot!.source} alt="" width={ICON_COL} height={ICON_COL} />
        )
      ) : (
        (g => (
          <Text color={g.color} dimColor={g.dim} bold={g.bold}>
            {g.text}
          </Text>
        ))(k ? glyph(k, ins) : { text: ' ' })
      )
    // 一行：[圖示欄][GAP][內容…]
    const line = (key: string, icon: RenderChildren, ...content: RenderChildren[]) => (
      <Box key={key} flexDirection="row" alignItems="center" gap={SPACE.GAP}>
        {icon}
        {content}
      </Box>
    )
    // 卡：同一個框、同一個內距；卡與卡之間 GAP
    const card = (key: string, children: RenderChildren) => (
      <Box
        key={key}
        flexDirection="column"
        marginTop={CARD_GAP}
        borderStyle="round"
        borderColor={fill ? CARD_EDGE : 'subtle'}
        backgroundColor={fill}
        paddingX={SPACE.PAD}
        paddingY={Svg ? SPACE.PAD : 0}
      >
        {children}
      </Box>
    )
    const status = [paneStatus(map, lang), pending ? t.unlogged : ''].filter(Boolean).join(' · ')
    // 一行裏面甚麼都不換行：只有標題會縮（省略號，完整標題在「詳情」）；負責人 · 用時、狀態字、詳情都不縮。
    // 窄面板：固定的部分放進去後標題不夠 TITLE_MIN 格 → 負責人 · 用時、狀態字移到標題下面一行（淡色），詳情留在第一行。
    const fixed = (key: string, text: string, color?: string, dim?: boolean) => (
      <Box key={key} flexShrink={0}>
        <Text color={color} dimColor={dim} wrap="truncate-end">
          {text}
        </Text>
      </Box>
    )
    const shrink = (key: string, el: RenderChildren) => (
      <Box key={key} flexShrink={1} minWidth={0} overflow="hidden">
        {el}
      </Box>
    )
    // 卡內一行左右的固定闊度（格）：面板內距 + 框 + 卡內距 + 圖示欄 + 兩個間距
    const rowChrome = PANE_INSET + 2 + 2 * SPACE.PAD + (Svg ? 3 : 1) + 2 * SPACE.GAP
    const titleRoom = (r: (typeof cards)[number]['rows'][number], detail: string) =>
      cols - rowChrome - (r.info ? cells(r.info) + SPACE.GAP : 0) - (r.status ? cells(r.status) + SPACE.GAP : 0) - (cells(detail) + 2)
    // 打開了詳情的插入步驟：它的影響（之後要等它的步驟）在階段卡用紫點、在流程圖用紫框標出
    const selNode = map.nodes.find(n => n.id === selected)
    // 插入後的改動畫面已有自己的標記：不再疊紫點
    const impactIds = new Set(selNode?.impact && !diff ? [...selNode.impact.rewired, ...selNode.impact.downstream] : [])
    const violet = Svg ? T.ins : 'merged'
    // 詳情的行（插入的步驟另有「插入前的計劃」按鈕；唯讀檢視時沒有）
    const hasBefore = !readOnly && selNode?.inserted ? (await snapshotOf($, map, selNode.id, true)) !== undefined : false
    const detailRows = (n: (typeof map.nodes)[number]) => [
      ...detailLines(map, n, lang, clock).map((l, i) =>
        line(
          `detail-${i}`,
          iconCol(undefined, false, ''),
          <Text dimColor wrap="wrap">
            {l}
          </Text>,
        ),
      ),
      n.inserted && hasBefore
        ? line(
            'before-btn',
            iconCol(undefined, false, ''),
            btn(`changes:${n.id}`, t.changesBtn, async () => {
              // 進入改動畫面時收起詳情（畫面上的標記已說明）
              await update($, SELECTED, () => '')
              await update($, CHANGES, () => n.id)
            }),
            btn(`before:${n.id}`, t.beforeBtn, () => update($, BEFORE, () => n.id)),
          )
        : null,
    ]
    // 插入後的改動標記（階段卡）：標題前 + ／ ~；標題後「階段 3 → 4」、● 因此要等；~ 的步驟下面一行「改為等 ◇X」
    const dAdded = new Set(diff?.added ?? [])
    const dRewired = new Map((diff?.rewired ?? []).map(r => [r.id, r.via]))
    const dMoved = new Map((diff?.moved ?? []).map(m => [m.id, m]))
    const dBlocked = new Set(diff?.blocked ?? [])
    const titleOf = (id: string) => map.nodes.find(n => n.id === id)?.title ?? id
    const marks: FlowMarks | undefined = diff
      ? {
          added: dAdded,
          rewired: new Set(dRewired.keys()),
          moved: new Map(planDiff(snap!, current, diagramStages).moved.map(m => [m.id, `${m.from}→${m.to}`])),
          blocked: dBlocked,
          removed: diff.removed.map(r => r.title),
        }
      : undefined
    // 一張階段卡：卡頭（已完成段不用，段標題已說了）＋ 各步，步與步之間 app 的分隔線
    const stageCard = (c: (typeof cards)[number], bare: boolean) =>
      card(c.key, [
        bare ? null : line('head', iconCol(undefined, false, ''), shrink('head-t', <Text bold wrap="truncate-end">{c.head}</Text>)),
        ...c.rows.flatMap((r, ri) => {
          const open = r.n.id === selected
          const detail = open ? t.detailClose : t.detailOpen
          const wide = titleRoom(r, detail) >= TITLE_MIN
          const metaParts = [r.info ? fixed('info', r.info, undefined, true) : null, r.status ? fixed('status', r.status, r.statusColor, !r.statusColor) : null]
          return [
            ri > 0 ? divider(`div:${r.n.id}`) : null,
            <Box key={`row:${r.n.id}`} flexDirection="column">
              {line(
                'main',
                iconCol(r.k, r.ins, r.status || t.status[r.n.status], r.fresh),
                r.mark ? fixed('ins-mark', '◇', undefined, true) : null,
                dAdded.has(r.n.id) ? fixed('diff-add', '+', Svg ? T.done : 'success') : dRewired.has(r.n.id) ? fixed('diff-rewired', '~', violet) : null,
                shrink(
                  'title',
                  <Text wrap="truncate-end" dimColor={r.k === 'todo'}>
                    {r.n.title}
                  </Text>,
                ),
                impactIds.has(r.n.id) ? fixed('impact', '•', violet) : null,
                dMoved.has(r.n.id) ? fixed('diff-moved', `${t.stage(dMoved.get(r.n.id)!.from, 1)} → ${dMoved.get(r.n.id)!.to}`, undefined, true) : null,
                dBlocked.has(r.n.id) ? fixed('diff-blocked', '●', 'warning') : null,
                <Box flexGrow={1} />,
                ...(wide ? metaParts : []),
                <Box key="detail-btn" flexShrink={0}>
                  {btn(`detail:${r.n.id}`, detail, () => update($, SELECTED, v => (v === r.n.id ? '' : r.n.id)))}
                </Box>,
              )}
              {!wide && (r.info || r.status) ? line('meta', iconCol(undefined, false, ''), ...metaParts) : null}
              {r.sub && !open
                ? line(
                    'sub',
                    iconCol(undefined, false, ''),
                    shrink(
                      'sub-t',
                      <Text dimColor={!r.ins} color={r.ins ? violet : undefined} wrap="truncate-end">
                        {r.sub}
                      </Text>,
                    ),
                  )
                : null}
              {dRewired.has(r.n.id)
                ? line(
                    'diff-sub',
                    iconCol(undefined, false, ''),
                    shrink(
                      'diff-sub-t',
                      <Text color={violet} wrap="truncate-end">
                        {t.nowWaitsFor(dRewired.get(r.n.id)!.map(titleOf).join(t.list))}
                      </Text>,
                    ),
                  )
                : null}
              {open ? detailRows(r.n) : null}
            </Box>,
          ]
        }),
      ])
    // 分段：進行中（第一層）、接著（聚焦內其餘各層）、已完成 N ⌄、稍後 N ⌄
    const stageCards = cards.filter(c => c.key.startsWith('stage:'))
    const nowCount = base.levels.length
    const doneCard = cards.find(c => c.key === 'done')
    const sections: { key: string; label: string; toggle?: { key: string; open: boolean; onPress: () => unknown }; cards: typeof cards }[] = [
      ...(stageCards.length ? [{ key: 'now', label: t.secNow, cards: stageCards.slice(0, 1) }] : []),
      ...(nowCount > 1 ? [{ key: 'next', label: t.secNext, cards: stageCards.slice(1, nowCount) }] : []),
      ...(view.done.length
        ? [
            {
              key: 'done',
              label: `${t.secDone} ${view.done.length}`,
              toggle: { key: 'fold-done', open: doneShown, onPress: () => update($, DONE_OPEN, () => !doneShown) },
              cards: doneShown && doneCard ? [doneCard] : [],
            },
          ]
        : []),
      ...(base.later.length
        ? [
            {
              key: 'later',
              label: `${t.secLater} ${base.later.length}`,
              toggle: { key: 'fold-future', open: futureOpen, onPress: () => update($, FUTURE_OPEN, v => !v) },
              cards: futureOpen ? stageCards.slice(nowCount) : [],
            },
          ]
        : []),
    ]
    const paneEta = etaText(map, clock.now, lang)
    const paneEtaN = etaRange(map, clock.now)?.n ?? 0
    // 流程圖：桌面一張圖（闊 = 面板格數 × 每格 px，1:1）；終端機是按組的縮排大綱
    const outline = diagram ? flowOutline(map, lang, Math.max(20, cols - PANE_INSET - 1), clock) : []
    let diagramPic: { source: string; width: number; height: number } | undefined
    if (diagram && Svg) {
      const lay = layoutFlow(map, { width: Math.max(240, Math.round(cols * PX_PER_COL) - 16), lang })
      diagramPic = flowSvg(map, lay, lang, T, clock, marks ? new Set() : impactIds, marks)
      // Svg 的內容上限 131072 字（約 250 步以上才會超過）：超過就改用文字大綱
      if (diagramPic.source.length > 131072) diagramPic = undefined
    }
    // 中途加的要求（流程圖下面）：每項可開詳情（影響、插入前的計劃）
    const requests = map.nodes.filter(n => n.inserted && n.status !== 'dropped')
    const diagramView = diagram ? (
      <Box key="diagram" flexDirection="column" marginTop={SPACE.GAP}>
        {diagramPic && Svg ? (
          <Box key="diagram-pic" flexShrink={0}>
            <Svg source={diagramPic.source} alt={outlineText(outline)} width={diagramPic.width} height={diagramPic.height} />
          </Box>
        ) : (
          <Box key="diagram-outline" flexDirection="column">
            {outline.map((l, i) => segLine(`fl${i}`, l))}
          </Box>
        )}
        {requests.length
          ? card('requests', [
              line('head', iconCol(undefined, false, ''), <Text bold>{t.requestsTitle}</Text>),
              ...requests.flatMap((n, i) => {
                const open = n.id === selected
                return [
                  i > 0 ? divider(`req-div-${i}`) : null,
                  <Box key={`req:${n.id}`} flexDirection="column">
                    {line(
                      'main',
                      iconCol(kindOf(n, readyIds(map.nodes), clock), insHot(n, clock), t.status[n.status], insFresh(n, clock)),
                      insMark(n, clock) ? fixed('ins-mark', '◇', undefined, true) : null,
                      shrink('title', <Text wrap="truncate-end">{n.title}</Text>),
                      <Box flexGrow={1} />,
                      <Box key="detail-btn" flexShrink={0}>
                        {btn(`detail:${n.id}`, open ? t.detailClose : t.detailOpen, () => update($, SELECTED, v => (v === n.id ? '' : n.id)))}
                      </Box>,
                    )}
                    {line(
                      'sub',
                      iconCol(undefined, false, ''),
                      shrink(
                        'sub-t',
                        <Text color={insHot(n, clock) ? violet : undefined} dimColor={!insHot(n, clock)} wrap="truncate-end">
                          {n.inserted!.note}
                        </Text>,
                      ),
                    )}
                    {open ? detailRows(n) : null}
                  </Box>,
                ]
              }),
            ])
          : null}
      </Box>
    ) : null
    const events = timelineOpen && !readOnly ? timeline(map, lang) : []
    // 說明卡：小標題（粗）＋ 圖示表
    const section = (key: string, title: string) => (
      <Box key={`${key}-t`}>
        <Text bold>{title}</Text>
      </Box>
    )
    // 說明卡的語言：app 原生的下拉選單（Select，如 app 自己的語言設定），選中的打 ✓；終端機用文字按鈕
    const Select = 'Select' in table ? table.Select : undefined
    // Select 沒有闊度屬性：包一個不會被壓的格，闊 = 最長的選項（CJK 算 2 格）+ 展開記號與內距
    const selectW = Math.max(...HELP_TABS.map(([, name]) => cells(name))) + 6
    const helpLangPicker = Select ? (
      <Select
        key="help-lang"
        options={HELP_TABS.map(([code, name]) => ({ value: code, label: name }))}
        value={hl}
        onSelect={value => update($, HELP_LANG, () => value)}
      />
    ) : (
      HELP_TABS.map(([code, name]) => (
        <Button key={`tab-${code}`} plain dimColor={code !== hl} label={code === hl ? `[${name}]` : name} onPress={() => update($, HELP_LANG, () => code)} />
      ))
    )
    const langBox = (
      <Box key="help-lang-box" flexShrink={0} width={selectW}>
        {helpLangPicker}
      </Box>
    )
    const legend = [
      ['done', iconCol('done', false, hs.helpLegend.done), hs.helpLegend.done],
      ['doing', iconCol('doing', false, hs.helpLegend.doing), hs.helpLegend.doing],
      ['todo', iconCol('todo', false, hs.helpLegend.todo), hs.helpLegend.todo],
      ['blocked', iconCol('blocked', false, hs.helpLegend.blocked), hs.helpLegend.blocked],
      ['ins', iconCol('todo', true, hs.helpLegend.ins), hs.helpLegend.ins],
      ['stale', iconCol('stale', false, hs.helpLegend.stale), hs.helpLegend.stale],
      [
        'pending',
        Svg ? <Svg source={amberPic(T).source} alt={hs.helpLegend.pending} width={ICON_COL} height={ICON_COL} /> : <Text color="warning">●</Text>,
        hs.helpLegend.pending,
      ],
    ] as const

    return (
      <Box flexDirection="column" paddingLeft={PANE_INSET} paddingRight={0}>
        {banner}
        {beforeBanner}
        <Box key="head" flexDirection="row" alignItems="center" gap={SPACE.GAP}>
          {/* 進度條在可縮的格內（preserveAspectRatio none）：窄時縮條，不縮數字 */}
          <Box flexGrow={Svg ? 1 : 0} flexShrink={1} overflow="hidden">
            {Svg ? (
              <Svg source={paneBar(map, T, 360).source} alt={[t.progressTip(s.done, s.total), paneEta ? t.etaTip(paneEta, paneEtaN) : ''].filter(Boolean).join('\n')} height={20} />
            ) : (
              // 終端機：字元進度條闊 = 這一行餘下的格數（數字、時間、狀態字之後），不會換行
              segLine(
                'bar',
                barSegs(
                  map,
                  Math.min(
                    40,
                    cols -
                      PANE_INSET -
                      3 -
                      cells(`${s.done} / ${s.total}`) -
                      (paneEta ? 1 + cells(paneEta) : 0) -
                      (pending ? 2 : 0) -
                      (cols >= 70 && status ? 1 + cells(status) : 0),
                  ),
                ),
              )
            )}
          </Box>
          {Svg ? null : <Box flexGrow={1} />}
          <Box flexShrink={0}>
            <Text bold>{`${s.done} / ${s.total}`}</Text>
          </Box>
          {paneEta ? (
            <Box flexShrink={0}>
              <Text dimColor>{paneEta}</Text>
            </Box>
          ) : null}
          {pending ? <Text color="warning">●</Text> : null}
          {/* 窄面板先不顯示狀態字 */}
          {cols >= 70 && status ? (
            <Box flexShrink={0}>
              <Text dimColor>{status}</Text>
            </Box>
          ) : null}
        </Box>
        {/* 工具列貼右；放不下時整個按鈕移到下一行（按鈕本身不縮、不斷字） */}
        <Box key="tools" flexDirection="row" flexWrap="wrap" justifyContent="flex-end" alignItems="center" gap={SPACE.GAP}>
          {[...tools, { key: 'help', label: t.help, onPress: () => update($, HELP_OPEN, v => !v) }].map(b => (
            <Box key={`tb-${b.key}`} flexShrink={0}>
              {btn(b.key, b.label, b.onPress)}
            </Box>
          ))}
        </Box>
        {helpOpen
          ? card('help', [
              // 第一行像設定頁的一列：「語言」（左，淡色）…… 下拉選單、收起（右），同一行、垂直置中；選單不會被擠到下一行
              <Box key="lang-row" flexDirection="row" alignItems="center" gap={SPACE.GAP}>
                <Text dimColor>{hs.languageLabel}</Text>
                <Box flexGrow={1} />
                {Select ? langBox : null}
                {btn('help-close', hs.helpClose, () => update($, HELP_OPEN, () => false))}
              </Box>,
              Select ? null : (
                <Box key="tabs" flexDirection="row" flexWrap="wrap" gap={SPACE.GAP}>
                  {helpLangPicker}
                </Box>
              ),
              divider('help-div-0'),
              <Box key="intro">
                <Text wrap="wrap">{hs.helpWhat}</Text>
              </Box>,
              Select ? null : (
                <Box key="tabs" flexDirection="row" flexWrap="wrap" gap={SPACE.GAP}>
                  {helpLangPicker}
                </Box>
              ),
              divider('help-div-1'),
              section('legend', hs.helpLegendTitle),
              // 圖示：兩欄
              ...[0, 2, 4, 6].map(i => (
                <Box key={`lg-row-${i}`} flexDirection="row">
                  {legend.slice(i, i + 2).map(([k, icon, label]) => (
                    <Box key={`lg-cell-${k}`} width="50%" flexDirection="row">
                      {line(`lg-${k}`, icon, <Text dimColor wrap="truncate-end">{label}</Text>)}
                    </Box>
                  ))}
                </Box>
              )),
              divider('help-div-2'),
              section('use', hs.helpUseTitle),
              ...hs.helpUse.map((it, i) => (
                <Box key={`use-${i}`}>
                  <Text dimColor wrap="wrap">{`·  ${it}`}</Text>
                </Box>
              )),
              divider('help-div-3'),
              section('ai', hs.helpAiTitle),
              ...hs.helpAi.map((it, i) => (
                <Box key={`ai-${i}`}>
                  <Text dimColor wrap="wrap">{`·  ${it}`}</Text>
                </Box>
              )),
              divider('help-div-4'),
              section('cmd', hs.helpCmdTitle),
              ...(
                [
                  ['/workflow', hs.helpCmds.workflow],
                  ['/workflow diagram', hs.helpCmds.diagram],
                  ['/workflow help', hs.helpCmds.help],
                  ['/workflow-demo', hs.helpCmds.demo],
                  ['/workflow export', hs.helpCmds.export],
                  ['/workflow undo', hs.helpCmds.undo],
                  ['/workflow join', hs.helpCmds.join],
                  ['/workflow leave', hs.helpCmds.leave],
                  ['language', hs.helpCmds.language],
                  ['staleMinutes', hs.helpCmds.staleMinutes],
                  ['suggestions', hs.helpCmds.suggestions],
                  ['notify', hs.helpCmds.notify],
                ] as const
              ).map(([k, v]) => (
                <Box key={`cmd-${k}`} flexDirection="row" gap={SPACE.GAP}>
                  <Box width={18} flexShrink={0}>
                    <Text>{k}</Text>
                  </Box>
                  <Box flexShrink={1}>
                    <Text dimColor wrap="wrap">
                      {v}
                    </Text>
                  </Box>
                </Box>
              )),
            ])
          : null}
        {diagram ? diagramView : null}
        {(diagram ? [] : sections).map(sec => [
          <Box key={`sec:${sec.key}`} marginTop={SPACE.GAP} flexDirection="row" alignItems="center">
            {sec.toggle ? btn(sec.toggle.key, Svg ? sec.label : `${sec.toggle.open ? '▾' : '▸'} ${sec.label}`, sec.toggle.onPress) : <Text dimColor>{sec.label}</Text>}
            {sec.toggle && Svg ? <Svg source={chevronPic(sec.toggle.open, T).source} alt={sec.toggle.open ? t.collapseTip : t.expandTip} width={14} height={20} /> : null}
          </Box>,
          ...sec.cards.map(c => stageCard(c, sec.key === 'done')),
        ])}
        {plansOpen && !readOnly
          ? card('plans', [
              line('head', iconCol(undefined, false, ''), <Text bold>{t.plans}</Text>),
              plans.length === 0 ? line('empty', iconCol(undefined, false, ''), <Text dimColor>{t.noPlansHere}</Text>) : null,
              ...plans.flatMap((p, i) => [
                i > 0 ? divider(`plan-div-${i}`) : null,
                line(
                  `pl-${p.id}`,
                  iconCol(p.total > 0 && p.done === p.total ? 'done' : p.running > 0 ? 'doing' : 'todo', false, ''),
                  shrink('title', <Text wrap="truncate-end">{p.title || t.untitled}</Text>),
                  <Box flexGrow={1} />,
                  fixed(
                    'meta',
                    [`${p.done}/${p.total}`, p.id === myPlan ? t.thisSession : '', t.sessionsN(p.sessions.filter(x => x !== mySession).length), fmtTime(p.updatedAt)]
                      .filter(Boolean)
                      .join(' · '),
                    undefined,
                    true,
                  ),
                  <Box key="act" flexShrink={0}>
                    {p.id === myPlan
                      ? btn(`leave-${p.id}`, t.leave, async () => {
                          await bindPlan($, '')
                          $.ui.toast(t.left)
                        })
                      : btn(`join-${p.id}`, myPlan ? t.switchTo : t.join, async () => $.ui.toast(await joinPlan($, p.id)))}
                  </Box>,
                ),
              ]),
            ])
          : null}
        {/* 插入後：已移除的步驟（刪除線）；流程圖已在圖的最底一行畫了 */}
        {diff?.removed.length && !diagram
          ? card('removed', [
              line('head', iconCol(undefined, false, ''), <Text bold>{t.removedTitle}</Text>),
              ...diff.removed.map((r, i) =>
                line(
                  `rm${i}`,
                  iconCol(undefined, false, ''),
                  shrink(
                    'rm-t',
                    <Text dimColor strikethrough wrap="truncate-end">
                      {r.title}
                    </Text>,
                  ),
                ),
              ),
            ])
          : null}
        {projectsOpen && !reqId
          ? card('projects', [
              line('head', iconCol(undefined, false, ''), <Text bold>{t.projects}</Text>),
              projects.length === 0 ? line('empty', iconCol(undefined, false, ''), <Text dimColor>{t.projectsEmpty}</Text>) : null,
              ...projects.map((p, i) =>
                line(
                  `p${i}`,
                  iconCol(p.total > 0 && p.done === p.total ? 'done' : p.running > 0 ? 'doing' : 'todo', false, ''),
                  // 按鈕的字不會自己省略：先按餘下的闊度截短（右邊的進度條與數字不縮）
                  shrink(
                    'name',
                    <Button
                      key={`project-${i}`}
                      plain
                      label={fitCells(
                        `${projectName(p.root)}${p.root === ownRoot ? ' ·' : ''}${p.title ? ` — ${p.title}` : ''}`,
                        Math.max(TITLE_MIN, cols - rowChrome - 10 - cells([`${p.done}/${p.total}`, t.statusLine(p.running, 0, 0), fmtTime(p.updatedAt)].filter(Boolean).join(' · ')) - 2),
                      )}
                      onPress={() => update($, VIEW_ROOT, () => (p.root === ownRoot ? '' : p.root))}
                    />,
                  ),
                  <Box flexGrow={1} />,
                  <Box key="bar" flexShrink={0}>
                    {Svg ? (
                      <Svg source={miniBar(p.done, p.total, T).source} alt={`${p.done}/${p.total}`} width={60} height={20} />
                    ) : (
                      segLine(`pbar-${i}`, [
                        { text: '━'.repeat(Math.round((8 * p.done) / Math.max(1, p.total))), color: 'success' },
                        { text: '━'.repeat(8 - Math.round((8 * p.done) / Math.max(1, p.total))), color: 'subtle' },
                      ])
                    )}
                  </Box>,
                  fixed('meta', [`${p.done}/${p.total}`, t.statusLine(p.running, 0, 0), fmtTime(p.updatedAt)].filter(Boolean).join(' · '), undefined, true),
                ),
              ),
            ])
          : null}
        {timelineOpen && !readOnly
          ? card('timeline', [
              line('head', iconCol(undefined, false, ''), <Text bold>{t.timelineBtn}</Text>),
              events.length === 0 ? line('empty', iconCol(undefined, false, ''), <Text dimColor>{t.timelineEmpty}</Text>) : null,
              events.length > TIMELINE_MAX ? line('earlier', iconCol(undefined, false, ''), <Text dimColor>{t.tlEarlier(events.length - TIMELINE_MAX)}</Text>) : null,
              ...events.slice(-TIMELINE_MAX).map((ev, i) =>
                line(
                  `tl${i}`,
                  iconCol(undefined, false, ''),
                  fixed('at', fmtTime(ev.at), undefined, true),
                  shrink('text', <Text wrap="truncate-end">{ev.text}</Text>),
                ),
              ),
            ])
          : null}
        {historyOpen && !readOnly
          ? card('history', [
              line('head', iconCol(undefined, false, ''), <Text bold>{t.history}</Text>),
              history.length === 0 ? line('empty', iconCol(undefined, false, ''), <Text dimColor>{t.historyEmpty}</Text>) : null,
              ...history.map((p, i) =>
                line(
                  `h${i}`,
                  iconCol(p.total > 0 && p.done === p.total ? 'done' : undefined, false, ''),
                  shrink('title', <Text wrap="truncate-end">{p.title || t.untitled}</Text>),
                  <Box flexGrow={1} />,
                  fixed('meta', `${fmtTime(p.at)}  ${p.done}/${p.total}`, undefined, true),
                ),
              ),
            ])
          : null}
      </Box>
    )
  })
}

/**
 * Up to three next-prompt suggestions: the plan's ready steps lead; a fork of the session fills the rest
 * (skipped when the plan already gives three). Derived from anthropics/claude-plugins-community next-steps
 * (Apache-2.0, see hooks/suggest.ts and LICENSE-APACHE); kept here because $ may not cross an import.
 */
async function computeSuggestions(
  $: $,
  o: { map: WorkflowMap; lead: string; forced: Lang | undefined; typed: Lang | undefined },
): Promise<Suggestion[]> {
  const items = planSuggestions(o.map, o.lead)
  if (items.length >= MAX_SUGGESTIONS) return items
  try {
    const commands = await $.command.list().catch(() => null)
    const known = commands === null ? null : new Set(commands.map(command => command.name))
    const reply = await $.model.fork({ prompt: forkPrompt(commands === null ? '' : skillList(commands), languageRule(o.forced, o.typed)) })
    for (const item of reply.isAnswered ? parseSuggestions(reply.text, known) : []) {
      if (items.length === MAX_SUGGESTIONS) break
      if (!items.some(had => sameAs(had, item))) items.push(item)
    }
  } catch (error) {
    $.ui.log(`suggestions: fork failed: ${String(error)}`)
  }
  return items
}

/** 匯出：計劃 → Markdown → 寫入 EXPORT_FILE（只寫這個檔）並複製；回傳通知文字。 */
async function exportPlan($: $, surface?: UiPressArgument['surface']): Promise<string> {
  const lang = await langNow($)
  const md = exportMarkdown(await shownMap($), lang, await $.clock.now())
  await $.fs.write(`${(await $.session.root()).replace(/[\\/]+$/, '')}/${EXPORT_FILE}`, md)
  await $.ui.copy({ text: md, ...(surface ? { surface } : {}) }).catch(() => undefined)
  return STR[lang].exported(EXPORT_FILE)
}

/** 插入前的計劃檔：步驟 id 以 encodeURIComponent 編碼（不會跳出資料夾） */
const snapshotPath = async ($: $, planId: string, nodeId: string) => `${await rootOf($)}/${SNAP_DIR}/${planId}/${encodeURIComponent(nodeId)}.json`

/**
 * 插入某步驟之前的計劃：示範資料由目前的計劃拿走該次插入的步驟、並還原改過的依賴推算；
 * 真資料讀 SNAP_DIR 的檔（壞檔、沒有檔 → undefined）。onlyCheck = 只看有沒有（不讀內容）。
 */
async function snapshotOf($: $, current: WorkflowMap, nodeId: string, onlyCheck = false): Promise<WorkflowMap | undefined> {
  const node = current.nodes.find(n => n.id === nodeId)
  if (await read($, DEMO)) {
    if (!node?.impact) return undefined
    const gone = new Set(node.impact.added)
    return {
      ...current,
      nodes: current.nodes.filter(n => !gone.has(n.id)).map(n => ({ ...n, deps: n.deps.filter(d => !gone.has(d)) })),
    }
  }
  const planId = await read($, BOUND)
  if (!planId) return undefined
  try {
    const path = await snapshotPath($, planId, nodeId)
    if (onlyCheck) return (await $.fs.exists(path)) ? current : undefined
    const v = validateMap((JSON.parse(await $.fs.read(path)) as { map?: unknown }).map)
    return typeof v === 'string' ? undefined : v
  } catch {
    return undefined
  }
}

const undoPath = async ($: $, planId: string) => `${(await $.session.root()).replace(/[\\/]+$/, '')}/${UNDO_DIR}/${planId}.json`

/** 這個計劃的快照：第一次用到時由檔案讀回（壞檔當作空）。 */
async function loadUndo($: $, planId: string) {
  if (undoFor === planId) return
  undoFor = planId
  try {
    const raw = JSON.parse(await $.fs.read(await undoPath($, planId))) as { snapshots?: unknown }
    const list = Array.isArray(raw.snapshots) ? raw.snapshots : []
    undoStack = list
      .map(x => {
        const m = validateMap((x as { map?: unknown }).map)
        const at = (x as { at?: unknown }).at
        const label = (x as { label?: unknown }).label
        return typeof m === 'string' || typeof at !== 'string' || typeof label !== 'string' ? undefined : { at, label, map: m }
      })
      .filter((x): x is Snapshot => !!x)
      .slice(-UNDO_MAX)
  } catch {
    undoStack = []
  }
}

async function saveUndo($: $, planId: string) {
  await $.fs.write(await undoPath($, planId), `${JSON.stringify({ version: 1, snapshots: undoStack })}\n`)
}

async function pushUndo($: $, planId: string, snap: Snapshot) {
  await loadUndo($, planId)
  undoStack = [...undoStack, snap].slice(-UNDO_MAX)
  await saveUndo($, planId)
}

/** 這次操作的簡短說明（還原通知用），用介面語言與步驟名稱。 */
async function undoLabel($: $, base: WorkflowMap, op: Op): Promise<string> {
  const t = STR[await langNow($)]
  const title = (id: string) => base.nodes.find(n => n.id === id)?.title ?? id
  const names = (ids: readonly string[]) => ids.map(title).slice(0, 3).join(t.list)
  switch (op.op) {
    case 'status':
      return `${title(op.id)} → ${t.status[op.status] ?? op.status}`
    case 'insert':
      return `◇ ${op.nodes.map(n => n.title ?? n.id).slice(0, 3).join(t.list)}`
    case 'remove':
      return `− ${names(op.ids)}`
    case 'upsert':
      return names(op.nodes.map(n => n.id))
    default:
      return base.title || t.paneTitle
  }
}

/** 還原最近一次寫入之前的計劃（以一次新的寫入套用，經同一條合併路徑）；回傳通知文字。 */
async function undoPlan($: $): Promise<string> {
  const t = STR[await langNow($)]
  const planId = await read($, BOUND)
  if (!planId) return t.nothingToUndo
  await loadUndo($, planId)
  const snap = undoStack[undoStack.length - 1]
  if (!snap) return t.nothingToUndo
  const r = await applyAndWrite($, { op: 'restore', nodes: snap.map.nodes, title: snap.map.title }, 'undo')
  if ('error' in r) return r.error
  undoStack = undoStack.slice(0, -1)
  await saveUndo($, planId)
  return t.undone(snap.label)
}

async function historyPath($: $, map: WorkflowMap, stamp: string): Promise<string> {
  const title = map.title || map.nodes[0]?.title || 'plan'
  const slug = title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan'
  return `${(await $.session.root()).replace(/[\\/]+$/, '')}/${HISTORY_DIR}/${stamp.replace(/[:.]/g, '-')}-${slug}.json`
}

/**
 * 寫入主檔：寫之前再讀一次，按步驟合併（較新的 updatedAt 勝、tombstone 不復活），避免蓋走其他寫入者
 * （Codex、Grok、其他 session）同時的修改。$.fs 沒有 rename，做不到原子寫入：每次寫入都是整份新內容。
 * 同一時間另一個寫入者換了計劃（planId 不同、而且有步驟）→ 不寫，請模型重試。
 */
async function writeMerged($: $, planId: string, base: WorkflowMap, ours: WorkflowMap): Promise<WorkflowMap | string> {
  const latest = await loadMap($, planId)
  // 檔案上已有另一個計劃（別的寫入者剛開了新計劃）：不寫。空檔／無檔不算衝突
  if (latest.nodes.length > 0 && latest.planId !== base.planId)
    return 'Another writer replaced the plan meanwhile; nothing was changed. Call op show and retry.'
  const final = mergeMaps(latest, ours)
  const cycle = findCycle(final.nodes)
  if (cycle) return `Merging with another writer's change would create a cycle (${cycle.join(' → ')}); nothing was changed. Call op show and retry.`
  await $.fs.write(await planPathOf($, planId), `${JSON.stringify(final, null, 2)}\n`)
  return final
}

/**
 * 套用一個操作並寫檔（模型的工具呼叫、子代理同步、還原都走這裏），只作用於這個 session 綁定的計劃。
 * 未綁定：new_plan／set_plan 開一個新計劃並綁定；其他操作回覆「未綁定」。
 * 開新計劃（new_plan、或在已完成的計劃上 set_plan）：舊計劃只在沒有其他 session 綁著時才封存；有人共用就只解除綁定。
 */
export async function applyAndWrite($: $, op: Op, by?: string, fromAgent = false): Promise<{ error: string } | { map: WorkflowMap; text: string }> {
  const planId = await read($, BOUND)
  if (!planId && op.op !== 'new_plan' && op.op !== 'set_plan') return { error: await noPlanMessage($) }
  let base: WorkflowMap
  try {
    base = await loadMap($, planId)
  } catch (err) {
    return { error: `Could not read the plan; nothing was changed: ${String(err).slice(0, 300)}` }
  }
  const now = await nowIso($)
  const r = applyOp(base, op, now, by)
  if ('error' in r) return { error: r.error }
  if (op.op === 'show') return { map: r.map, text: textDiagram(r.map, 60, 'en') }
  const creating = !planId || r.archive
  let final: WorkflowMap
  if (creating) {
    const sid = await sessionIdOf($)
    if (planId && r.archive) {
      const others = (await sessionsOn($, planId)).filter(x => x !== sid)
      const latest = await loadMap($, planId)
      if (others.length === 0 && latest.nodes.length) {
        // 先封存（以檔案上最新的內容為準）；計劃檔本身標記封存（舊共用檔不改）
        await $.fs.write(await historyPath($, latest, now), `${JSON.stringify({ ...latest, archivedAt: now }, null, 2)}\n`)
        if (planId !== LEGACY_ID) await $.fs.write(await planPathOf($, planId), `${JSON.stringify({ ...latest, archivedAt: now }, null, 2)}\n`)
      }
    }
    final = { ...r.map, sessions: [sid], createdBy: sid }
    await $.fs.write(await planPathOf($, final.planId!), `${JSON.stringify(final, null, 2)}\n`)
    await bindPlan($, final.planId!)
  } else {
    // 還原用：記下這次寫入之前的計劃（還原本身不記，免得來回）
    if (op.op !== 'restore' && (r.changed.length || r.removed.length)) await pushUndo($, planId, { at: now, label: await undoLabel($, base, op), map: base })
    const merged = await writeMerged($, planId, base, r.map)
    if (typeof merged === 'string') return { error: merged }
    final = merged
    // 插入：記下插入前的計劃（每個插入的步驟一份；失敗不影響這次寫入）
    if (op.op === 'insert')
      for (const n of op.nodes)
        await $.fs.write(await snapshotPath($, planId, n.id), `${JSON.stringify({ version: 1, at: now, note: op.note, map: base })}\n`).catch(() => undefined)
    await update($, MAP, () => final)
    await foldAll($)
    await notifyTransitions($, base, final, fromAgent)
    await registerProject($, final).catch(() => undefined)
  }
  return { map: final, text: [r.info, opSummary(final, r.changed, r.removed)].filter(Boolean).join('\n') }
}

async function serveTool($: $, e: Record<string, unknown>): Promise<{ deny: string } | { result: string }> {
  const { tool: _t, tool_use_id: _u, agentId: _a, ...args } = e
  // 加入／離開計劃（不改計劃內容）
  if (args.op === 'join') {
    if (typeof args.plan !== 'string' || !args.plan.trim()) return { deny: 'join needs plan: a plan id or title (see op show, or the list in the no-plan message)' }
    return { result: await joinPlan($, args.plan) }
  }
  if (args.op === 'leave') {
    await bindPlan($, '')
    return { result: 'This session left its plan. Call new_plan to start a new one, or join one.' }
  }
  const r = await applyAndWrite($, args as unknown as Op)
  if ('error' in r) return { deny: r.error }
  if (await read($, PENDING)) await update($, PENDING, () => false)
  // 模型把用戶的要求記入了：短通知「已記錄：用戶原話」（通知關了就不彈）；上一則「未記錄」提示亦收起
  if (args.op === 'insert') {
    if (await read($, UNRECORDED)) await update($, UNRECORDED, () => '')
    if (notifyOn && typeof args.note === 'string' && args.note.trim()) $.ui.toast(STR[await langNow($)].recorded(snippet(args.note, 24)))
  }
  return { result: r.text }
}

/** 歷史：最新 20 個封存計劃（標題、封存時間、完成數）。 */
async function readHistory($: $): Promise<{ title: string; at: string; done: number; total: number }[]> {
  const dir = `${(await $.session.root()).replace(/[\\/]+$/, '')}/${HISTORY_DIR}`
  const entries = await $.fs.list(dir).catch(() => [])
  const files = entries.filter(f => f.kind === 'file' && f.name.endsWith('.json')).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 20)
  const out: { title: string; at: string; done: number; total: number }[] = []
  for (const f of files) {
    try {
      const m = validateMap(JSON.parse(await $.fs.read(`${dir}/${f.name}`)))
      if (typeof m === 'string') continue
      const s = stats(m)
      out.push({ title: m.title || m.nodes[0]?.title || '', at: m.archivedAt ?? m.updatedAt, done: s.done, total: s.total })
    } catch {
      // 壞檔：略過
    }
  }
  return out
}

async function toggle($: $) {
  const v = !(await read($, EXPANDED))
  await update($, EXPANDED, () => v)
  await $.store.set('expanded', v)
}
