import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, UiPressArgument } from 'claude-code'

import type { WorkflowMap, WorkflowNode } from '../types/index'
import { demoMap as demoPlan } from './demo'
import { allDone, applyOp, compactLine, emptyMap, etaMin, exportMarkdown, findCycle, isActive, isStale, mergeMaps, migrate, opSummary, plainLines, readyIds, STATUSES, stageView, stats, textDiagram, validateMap } from './graph'
import type { Op } from './graph'
import { detectLang, HELP_TABS, LANGS, looksLikeRequest, resolveLang, STR } from './i18n'
import type { Lang } from './i18n'
import { CAPSULE_CELLS, CAPSULE_CHROME, cells, fitCells, forkPrompt, languageRule, MAX_SUGGESTIONS, MIN_ANSWER_CHARS, parseSuggestions, planSuggestions, ROW_CHROME, sameAs, skillList } from './suggest'
import type { Suggestion, SuggestView } from './suggest'
import { amberPic, bandGraph, bandHeader, chevronPic, detailLines, fmtTime, iconPic, miniBar, paneBar, paneCards, paneStatus, PX_PER_COL, slotPic, STAR_W, starPic, THEMES } from './svg'
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
const DEMO = atom({ plugin: 'workflow-map', key: 'demo' } as const, false)
const DONE_OPEN = atom({ plugin: 'workflow-map', key: 'doneOpen' } as const, false)
const FUTURE_OPEN = atom({ plugin: 'workflow-map', key: 'futureOpen' } as const, false)
const HISTORY_OPEN = atom({ plugin: 'workflow-map', key: 'historyOpen' } as const, false)
/** 全圖面板展開詳情的步驟（一次只開一個；'' = 無） */
const SELECTED = atom({ plugin: 'workflow-map', key: 'selected' } as const, '')
/** 輸入框上方的卡片圖：是否顯示全部步驟（含稍後的層） */
const BAND_ALL = atom({ plugin: 'workflow-map', key: 'bandAll' } as const, false)
/** 卡片圖全部顯示時最多幾行卡 */
const BAND_MAX_ROWS = 6
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
/** 每分鐘跳一次（有進行中的步驟時），令用時與「久未更新」刷新 */
const TICK = atom({ plugin: 'workflow-map', key: 'tick' } as const, 0)
const WM_TAG = /\[wm:([^\]\s]+)\]/
/** 本輪開始時間：本輪新插入的步驟在聚焦時一定顯示 */
const TURN_AT = atom({ plugin: 'workflow-map', key: 'turnAt' } as const, 0)
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
  'Node: {id, title, status: todo|doing|done|blocked|dropped, deps: [ids it waits for], owner?, note?}. ' +
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
          lane: { type: 'string' },
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

// 每次對話都會帶上：保持 ≤ ~80 字
const GUIDE =
  `# Workflow map\nThe map is this session's own plan. For work with 3+ steps keep it current with ${TOOL}: new_plan at the start ` +
  '(honest deps: independent steps share none), status doing/done as you go, new_plan again for an unrelated task. ' +
  'If the user asks for something not in the plan, first insert it (note = their words; before = steps that must wait), then act. ' +
  'When delegating a step, set its owner and put [wm:<id>] in the Agent description; the step then syncs with that agent. ' +
  "Titles: the user's language, ≤ 8 CJK / 20 Latin characters, plain words."

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
  return { now: await $.clock.now(), staleMin: staleMinutes }
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
async function demoMap($: $): Promise<WorkflowMap> {
  return demoPlan(await $.clock.now(), resolveLang(languageSetting, await read($, LANG)))
}
const shownMap = async ($: $) => ((await read($, DEMO)) ? demoMap($) : read($, MAP))

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

export const register: Register = (on, options) => {
  languageSetting = (options as { language?: unknown } | undefined)?.language ?? 'auto'
  suggestionsOn = (options as { suggestions?: unknown } | undefined)?.suggestions !== false
  notifyOn = (options as { notify?: unknown } | undefined)?.notify !== false
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
    return { sections: [...r.sections, { id: 'workflow-map:guide', text: GUIDE, scope: 'session' as const }] }
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
    // 「好」「ok」「繼續」、只有圖片、很短的訊息：不算新要求
    if (!isActive(await read($, MAP)) || !looksLikeRequest(e.text)) return next(e)
    await update($, PENDING, () => true)
    return next({ ...e, context: [...(e.context ?? []), HINT] })
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, TURN_AT, () => now)
    // 新一輪開始：收起上一輪的建議
    if ((await read($, SUGGEST)).kind !== 'hidden') await update($, SUGGEST, () => ({ kind: 'hidden' }) as SuggestView)
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
      if (await read($, PENDING)) await update($, PENDING, () => false)
      const done = allDone(await read($, MAP))
      await update($, DONE_TURNS, n => (done ? n + 1 : 0))
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

  on('command.run', { command: 'workflow-demo' }, async $ => {
    const isOn = !(await read($, DEMO))
    await update($, DEMO, () => isOn)
    const t = STR[await langNow($)]
    return { text: isOn ? t.demoOn : t.demoOff }
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
    if (!showPlan && sv.kind === 'hidden') return next(e)
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
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const T = await themeOf($)
    const controls = (
      <Box key="ctl" flexDirection="row" flexShrink={0} alignItems="center" gap={SPACE.GAP}>
        <Button key="toggle" {...ICON_BTN} label={expanded ? t.collapseTip : t.expandTip} onPress={() => toggle($)} />
        <Button key="open" {...ICON_BTN} label={t.openTip} onPress={() => openPane($, lang)} />
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
      const shown = expanded ? plainLines(map, lang).slice(0, 6) : []
      planRows = [
        <Box key="title" flexDirection="row" gap={1}>
          <Box flexShrink={1} flexGrow={1}>
            <Text wrap="truncate-end">{compactLine(map, lang)}</Text>
          </Box>
          {pending ? <Text color="warning">●</Text> : null}
          {controls}
        </Box>,
        ...shown.map(line => <Text wrap="truncate-end">{line}</Text>),
      ]
    } else if (showPlan && Svg) {
      const view = stageView(map, { freshSince: await read($, TURN_AT) })
      // 可用闊度：欄數 × 每格 px（寧小勿大），扣去兩個按鈕
      const avail = Math.max(240, Math.round((e.props.bodyColumns || 100) * PX_PER_COL) - 56)
      const clock = await clockOf($)
      const etaM = etaMin(map, clock.now)
      const head = bandHeader(map, view, lang, T, avail, pending, clock, etaM === undefined ? '' : `≈ ${t.durShort(etaM)}`)
      const showAll = await read($, BAND_ALL)
      const graph = expanded
        ? bandGraph(map, showAll ? stageView(map, { freshSince: await read($, TURN_AT), expandFuture: true }) : view, lang, T, avail - 80, clock, {
            all: showAll,
            maxRows: BAND_MAX_ROWS,
          })
        : undefined
      // 「+N 稍後」：圖後的 app 文字按鈕（圖裏的字按不到）；全部顯示時是「收起稍後」，再多的仍有「+N … 全圖」
      const chips = graph
        ? [
            ...(showAll ? [<Button key="band-less" {...ICON_BTN} label={t.hideLater} onPress={() => update($, BAND_ALL, () => false)} />] : []),
            ...(graph.hidden > 0
              ? [
                  showAll ? (
                    <Button
                      key="band-more"
                      {...ICON_BTN}
                      label={t.moreInFull(graph.hidden)}
                      onPress={async () => {
                        await update($, FUTURE_OPEN, () => true)
                        await openPane($, lang)
                      }}
                    />
                  ) : (
                    <Button key="band-later" {...ICON_BTN} label={t.laterCard(graph.hidden)} onPress={() => update($, BAND_ALL, () => true)} />
                  ),
                ]
              : []),
          ]
        : []
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
              alt={[t.progressTip(s.done, s.total), etaM === undefined ? '' : t.etaTip(t.dur(etaM)), pending ? t.unloggedTip : ''].filter(Boolean).join('\n')}
              width={head.meter.width}
              height={head.meter.height}
            />
          </Box>
          {controls}
        </Box>,
        graph ? (
          <Box key="graph" flexDirection="row" alignItems="flex-start" gap={SPACE.GAP}>
            <Svg source={graph.source} alt={plainLines(map, lang).join('\n')} width={graph.width} height={graph.height} />
            {chips}
          </Box>
        ) : null,
      ]
    }
    return (
      <Box flexDirection="column">
        {below}
        <Box key="workflow-map" flexDirection="column">
          {planRows}
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
    const map = foreign ? (foreignMap ?? emptyMap()) : await shownMap($)
    const projectName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root
    const backButton = <Button key="project-back" {...ICON_BTN} label={`← ${t.back}`} onPress={() => update($, VIEW_ROOT, () => '')} />
    const banner = foreign ? (
      <Box key="viewing" flexDirection="row" alignItems="center" gap={SPACE.GAP}>
        {backButton}
        <Text bold>{t.viewing(projectName(foreign))}</Text>
      </Box>
    ) : null
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
          <Text dimColor>{(await read($, BOUND)) ? t.empty : t.noPlanBound}</Text>
          <Box flexDirection="row">
            <Button key="plans" {...ICON_BTN} label={t.plans} onPress={() => update($, PLANS_OPEN, () => true)} />
          </Box>
        </Box>
      )
    }
    const doneOpen = await read($, DONE_OPEN)
    const futureOpen = await read($, FUTURE_OPEN)
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
    const tools = [
      ...(foreign
        ? []
        : [
            { key: 'undo', label: t.undoBtn, onPress: async () => $.ui.toast(await undoPlan($)) },
            { key: 'export', label: t.exportBtn, onPress: async (press: UiPressArgument) => $.ui.toast(await exportPlan($, press.surface)) },
            { key: 'history', label: historyOpen ? t.hideHistory : t.history, onPress: () => update($, HISTORY_OPEN, v => !v) },
          ]),
      ...(foreign ? [] : [{ key: 'plans', label: plansOpen ? t.hidePlans : t.plans, onPress: () => update($, PLANS_OPEN, v => !v) }]),
      { key: 'projects', label: projectsOpen ? t.hideProjects : t.projects, onPress: () => update($, PROJECTS_OPEN, v => !v) },
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
    const GLYPHS: Record<string, string> = { done: '✓', doing: '●', stale: '●', ready: '○', todo: '○', blocked: '!' }
    const slot = Svg ? slotPic(T) : undefined
    const fill = Svg ? CARD_FILL[(await read($, LIGHT)) ? 'light' : 'dark'] : undefined
    const btn = (key: string, label: string, onPress: (press: UiPressArgument) => unknown) => <Button key={key} {...ICON_BTN} label={label} onPress={onPress} />
    // 卡內行與行之間：app 自己的分隔線（Markdown 的 ---），沒有就不畫
    const Markdown = 'Markdown' in table ? table.Markdown : undefined
    const divider = (key: string) => (Markdown ? <Markdown key={key} text="---" /> : null)
    // 圖示欄：桌面 20px 圖，終端機 1 個字；沒有圖示時是同闊的空位
    const iconCol = (k: Kind | undefined, ins: boolean, alt: string) =>
      Svg ? (
        k ? (
          <Svg source={iconPic(k, ins, T).source} alt={alt} width={ICON_COL} height={ICON_COL} />
        ) : (
          <Svg source={slot!.source} alt="" width={ICON_COL} height={ICON_COL} />
        )
      ) : (
        <Text color={k === 'doing' ? 'claude' : k === 'blocked' || k === 'stale' ? 'warning' : k === 'done' ? 'success' : undefined}>
          {!k ? ' ' : ins ? '◇' : GLYPHS[k]}
        </Text>
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
        padding={SPACE.PAD}
      >
        {children}
      </Box>
    )
    const status = [paneStatus(map, lang), pending ? t.unlogged : ''].filter(Boolean).join(' · ')
    // 一張階段卡：卡頭（已完成段不用，段標題已說了）＋ 各步，步與步之間 app 的分隔線
    const stageCard = (c: (typeof cards)[number], bare: boolean) =>
      card(c.key, [
        bare ? null : line('head', iconCol(undefined, false, ''), <Text bold wrap="truncate-end">{c.head}</Text>),
        ...c.rows.flatMap((r, ri) => {
          const open = r.n.id === selected
          return [
            ri > 0 ? divider(`div:${r.n.id}`) : null,
            <Box key={`row:${r.n.id}`} flexDirection="column">
              {line(
                'main',
                iconCol(r.k, !!r.n.inserted, r.status || t.status[r.n.status]),
                <Box flexShrink={1}>
                  <Text wrap="truncate-end" dimColor={r.k === 'todo'}>
                    {r.n.title}
                  </Text>
                </Box>,
                <Box flexGrow={1} />,
                r.info ? <Text dimColor>{r.info}</Text> : null,
                r.status ? (
                  <Text color={r.statusColor} dimColor={!r.statusColor}>
                    {r.status}
                  </Text>
                ) : null,
                btn(`detail:${r.n.id}`, open ? t.detailClose : t.detailOpen, () => update($, SELECTED, v => (v === r.n.id ? '' : r.n.id))),
              )}
              {r.sub && !open
                ? line(
                    'sub',
                    iconCol(undefined, false, ''),
                    <Text dimColor={!r.n.inserted} color={r.n.inserted ? T.ins : undefined} wrap="truncate-end">
                      {r.sub}
                    </Text>,
                  )
                : null}
              {open
                ? detailLines(map, r.n, lang, clock).map((l, i) =>
                    line(
                      `detail-${i}`,
                      iconCol(undefined, false, ''),
                      <Text dimColor wrap="wrap">
                        {l}
                      </Text>,
                    ),
                  )
                : null}
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
    const paneEta = etaMin(map, clock.now)
    // 說明卡：小標題（粗）＋ 圖示表
    const section = (key: string, title: string) => (
      <Box key={`${key}-t`}>
        <Text bold>{title}</Text>
      </Box>
    )
    // 說明卡的語言：app 原生的下拉選單（Select，如 app 自己的語言設定），選中的打 ✓；終端機用文字按鈕
    const Select = e.surface !== 'terminal' && 'Select' in table ? table.Select : undefined
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
        <Box key="head" flexDirection="row" alignItems="center" gap={SPACE.GAP}>
          {/* 進度條在可縮的格內（preserveAspectRatio none）：窄時縮條，不縮數字 */}
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            {Svg ? <Svg source={paneBar(map, T, 360).source} alt={t.progressTip(s.done, s.total)} height={20} /> : null}
          </Box>
          <Box flexShrink={0}>
            <Text bold>{`${s.done} / ${s.total}`}</Text>
          </Box>
          {paneEta === undefined ? null : (
            <Box flexShrink={0}>
              <Text dimColor>{`≈ ${t.dur(paneEta)}`}</Text>
            </Box>
          )}
          {pending ? <Text color="warning">●</Text> : null}
          {/* 窄面板先不顯示狀態字 */}
          {cols >= 70 && status ? (
            <Box flexShrink={0}>
              <Text dimColor>{status}</Text>
            </Box>
          ) : null}
        </Box>
        <Box key="tools" flexDirection="row" alignItems="center" gap={SPACE.GAP}>
          <Box flexGrow={1} />
          {tools.map(b => btn(b.key, b.label, b.onPress))}
          {btn('help', t.help, () => update($, HELP_OPEN, v => !v))}
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
                  <Box width={16} flexShrink={0}>
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
        {sections.map(sec => [
          <Box key={`sec:${sec.key}`} marginTop={SPACE.GAP} flexDirection="row" alignItems="center">
            {sec.toggle ? btn(sec.toggle.key, Svg ? sec.label : `${sec.label} ${sec.toggle.open ? '⌃' : '⌄'}`, sec.toggle.onPress) : <Text dimColor>{sec.label}</Text>}
            {sec.toggle && Svg ? <Svg source={chevronPic(sec.toggle.open, T).source} alt={sec.toggle.open ? t.collapseTip : t.expandTip} width={14} height={20} /> : null}
          </Box>,
          ...sec.cards.map(c => stageCard(c, sec.key === 'done')),
        ])}
        {plansOpen && !foreign
          ? card('plans', [
              line('head', iconCol(undefined, false, ''), <Text bold>{t.plans}</Text>),
              plans.length === 0 ? line('empty', iconCol(undefined, false, ''), <Text dimColor>{t.noPlansHere}</Text>) : null,
              ...plans.flatMap((p, i) => [
                i > 0 ? divider(`plan-div-${i}`) : null,
                line(
                  `pl-${p.id}`,
                  iconCol(p.total > 0 && p.done === p.total ? 'done' : p.running > 0 ? 'doing' : 'todo', false, ''),
                  <Box flexShrink={1}>
                    <Text wrap="truncate-end">{p.title || t.untitled}</Text>
                  </Box>,
                  <Box flexGrow={1} />,
                  <Text dimColor>
                    {[
                      `${p.done}/${p.total}`,
                      p.id === myPlan ? t.thisSession : '',
                      t.sessionsN(p.sessions.filter(x => x !== mySession).length),
                      fmtTime(p.updatedAt),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>,
                  p.id === myPlan
                    ? btn(`leave-${p.id}`, t.leave, async () => {
                        await bindPlan($, '')
                        $.ui.toast(t.left)
                      })
                    : btn(`join-${p.id}`, myPlan ? t.switchTo : t.join, async () => $.ui.toast(await joinPlan($, p.id))),
                ),
              ]),
            ])
          : null}
        {projectsOpen
          ? card('projects', [
              line('head', iconCol(undefined, false, ''), <Text bold>{t.projects}</Text>),
              projects.length === 0 ? line('empty', iconCol(undefined, false, ''), <Text dimColor>{t.projectsEmpty}</Text>) : null,
              ...projects.map((p, i) =>
                line(
                  `p${i}`,
                  iconCol(p.total > 0 && p.done === p.total ? 'done' : p.running > 0 ? 'doing' : 'todo', false, ''),
                  <Button
                    key={`project-${i}`}
                    plain
                    label={`${projectName(p.root)}${p.root === ownRoot ? ' ·' : ''}${p.title ? ` — ${p.title}` : ''}`}
                    onPress={() => update($, VIEW_ROOT, () => (p.root === ownRoot ? '' : p.root))}
                  />,
                  <Box flexGrow={1} />,
                  Svg ? <Svg source={miniBar(p.done, p.total, T).source} alt={`${p.done}/${p.total}`} width={60} height={20} /> : null,
                  <Text dimColor>{[`${p.done}/${p.total}`, t.statusLine(p.running, 0, 0), fmtTime(p.updatedAt)].filter(Boolean).join(' · ')}</Text>,
                ),
              ),
            ])
          : null}
        {historyOpen && !foreign
          ? card('history', [
              line('head', iconCol(undefined, false, ''), <Text bold>{t.history}</Text>),
              history.length === 0 ? line('empty', iconCol(undefined, false, ''), <Text dimColor>{t.historyEmpty}</Text>) : null,
              ...history.map((p, i) =>
                line(
                  `h${i}`,
                  iconCol(p.total > 0 && p.done === p.total ? 'done' : undefined, false, ''),
                  <Box flexShrink={1}>
                    <Text wrap="truncate-end">{p.title || t.untitled}</Text>
                  </Box>,
                  <Box flexGrow={1} />,
                  <Text dimColor>{`${fmtTime(p.at)}  ${p.done}/${p.total}`}</Text>,
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
