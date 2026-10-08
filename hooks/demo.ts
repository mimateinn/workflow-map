// /workflow-demo 用的示範資料：只在記憶體顯示，絕不寫入 .claude/workflow-map.json。
// 展示：已完成收成一組、三個並行（一個是用戶插入、一個久未更新）、一個受阻、負責人、用時、較遠的步驟收成「稍後」。
// /workflow-demo team：多人並行的編排（流程圖用）：決策、分組、組內「開發 → 測試」配對、提醒、線上標籤。
import type { WorkflowMap, WorkflowNode } from '../types/index'
import type { Lang } from './i18n'

type Row = [id: string, status: WorkflowNode['status'], deps: string[], owner: string, startedAgo?: number, doneAgo?: number, updatedAgo?: number]
const ROWS: Row[] = [
  ['req', 'done', [], 'me', 180, 170],
  ['model', 'done', ['req'], 'Builder', 165, 140],
  ['api', 'done', ['model'], 'Builder', 135, 95],
  ['ui', 'done', ['model'], 'Builder', 130, 70],
  ['lang', 'done', ['api'], 'Grok', 90, 60],
  ['cards', 'doing', ['ui'], 'Builder', 25, undefined, 3],
  ['wires', 'doing', ['ui'], 'Grok', 52, undefined, 45],
  ['dark', 'doing', ['ui'], 'Astra', 12, undefined, 2],
  ['test', 'todo', ['cards', 'wires'], ''],
  ['shots', 'blocked', ['dark'], ''],
  ['try', 'todo', ['test', 'shots'], 'me'],
  ['pub', 'todo', ['try', 'lang'], ''],
]
const TITLES: Partial<Record<Lang, Record<string, string>>> = {
  'zh-Hant': { req: '整理需求', model: '資料結構', api: '模型工具', ui: '介面骨架', lang: '多語文字', cards: '卡片版面', wires: '連線走法', dark: '深色主題', test: '自動測試', shots: '截圖說明', try: '實機試用', pub: '發佈' },
  en: { req: 'Gather needs', model: 'Data model', api: 'Model tool', ui: 'UI skeleton', lang: 'Translations', cards: 'Card layout', wires: 'Connectors', dark: 'Dark theme', test: 'Tests', shots: 'Screenshots', try: 'Real-app check', pub: 'Release' },
}
const NOTES: Partial<Record<Lang, { ins: string; blocked: string }>> = {
  'zh-Hant': { ins: '要跟系統深淺色', blocked: '等設計定稿' },
  en: { ins: 'Follow the system light/dark', blocked: 'Waiting for the design' },
}

const agoOf = (nowMs: number) => (min?: number) => (min === undefined ? undefined : new Date(nowMs - min * 60_000).toISOString())

/** 每步的狀態紀錄：計劃開始時加入 → 開始（負責人）→ 完成；受阻的最後一筆是受阻 */
function logOf(ago: (m?: number) => string | undefined, status: WorkflowNode['status'], owner: string, started?: number, done?: number, at = 200): WorkflowNode['log'] {
  const by = owner ? { by: owner } : {}
  return [
    { at: ago(at)!, status: 'todo' as const },
    ...(started !== undefined ? [{ at: ago(started)!, status: 'doing' as const, ...by }] : []),
    ...(done !== undefined ? [{ at: ago(done)!, status: 'done' as const, ...by }] : []),
    ...(status === 'blocked' ? [{ at: ago(8)!, status: 'blocked' as const }] : []),
  ]
}

/** 示範計劃：時間按現在推算（幾分鐘前開始、完成），標題跟介面語言。 */
export function demoMap(nowMs: number, lang: Lang): WorkflowMap {
  const titles = TITLES[lang] ?? TITLES.en!
  const notes = NOTES[lang] ?? NOTES.en!
  const ago = agoOf(nowMs)
  const nodes = ROWS.map(([id, status, deps, owner, started, done, updated]): WorkflowNode => {
    const n: WorkflowNode = { id, title: titles[id]!, status, deps, updatedAt: ago(updated ?? done ?? 200), log: logOf(ago, status, owner, started, done) }
    if (owner) n.owner = owner
    if (started !== undefined) n.startedAt = ago(started)
    if (done !== undefined) n.doneAt = ago(done)
    if (id === 'dark') {
      n.inserted = { at: ago(14)!, by: 'user', note: notes.ins }
      n.impact = { added: ['dark'], rewired: ['shots'], downstream: ['shots', 'try', 'pub'] }
      n.log = logOf(ago, status, owner, started, done, 14)
    }
    if (id === 'shots') n.note = notes.blocked
    return n
  })
  return { schemaVersion: 2, version: 1, planId: 'demo', title: 'demo', createdAt: ago(200)!, updatedAt: ago(2)!, nodes, tombstones: [] }
}

// ---- 團隊示範（流程圖） ----
type TeamRow = { id: string; lane?: string; kind?: 'decision' | 'note'; status: WorkflowNode['status']; deps: string[]; owner?: string; label?: string }
const LANES: Record<'zh-Hant' | 'en', Record<string, string>> = {
  'zh-Hant': { core: '共享核心', review: '獨立覆核', build: '8 組：各自開發、模組接入、配對測試', spare: '機動補位', fix: '具體阻塞修復', src: '官方來源核對' },
  en: { core: 'Shared core', review: 'Independent review', build: '8 pairs: build, wire in, test', spare: 'Standby', fix: 'Blocker fixes', src: 'Source checks' },
}
const TEAM_TITLES: Record<'zh-Hant' | 'en', Record<string, string>> = {
  'zh-Hant': {
    split: '拆分工作',
    decide: '需要改共享核心？',
    core1: '共用介面',
    core2: '解析入口',
    review: '覆核',
    build: '開發',
    test: '測試',
    spare: '補位',
    fix1: '修讀檔逾時',
    fix2: '修版面溢出',
    src1: '核對官方文件',
    src2: '核對版本說明',
    accept: '驗收通過',
    main: '主線：派工、整合、checkpoint',
    next: '預先確認候補批次',
    risk: '接線仍有排隊風險：先跑完一組再加',
    'l:core': '需要',
    'l:review': '普通 pattern：直接交覆核',
    'l:build': '共用介面／解析入口',
    'l:spare': '有空就接手',
    'l:fix': '處理已發現的阻塞',
    'l:src': '有疑問才查',
    insNote: '加一輪效能覆核',
  },
  en: {
    split: 'Split the work',
    decide: 'Change the shared core?',
    core1: 'Shared interface',
    core2: 'Parser entry',
    review: 'Review',
    build: 'Build',
    test: 'Test',
    spare: 'Standby',
    fix1: 'Fix read timeout',
    fix2: 'Fix layout overflow',
    src1: 'Check the docs',
    src2: 'Check release notes',
    accept: 'Acceptance passed',
    main: 'Main line: dispatch, merge, checkpoint',
    next: 'Line up the next batch',
    risk: 'Wiring may still queue: finish one pair first',
    'l:core': 'Yes',
    'l:review': 'Plain pattern: straight to review',
    'l:build': 'Shared interface / parser',
    'l:spare': 'Picks up slack',
    'l:fix': 'Fix blockers found',
    'l:src': 'Only when unsure',
    insNote: 'Add a performance review',
  },
}

function teamRows(): TeamRow[] {
  const S = (i: number, done: number, doing: number) => (i <= done ? 'done' : i <= doing ? 'doing' : 'todo') as WorkflowNode['status']
  const rows: TeamRow[] = [
    { id: 'split', status: 'done', deps: [], owner: 'me' },
    { id: 'decide', kind: 'decision', status: 'done', deps: ['split'], owner: 'me' },
    { id: 'core1', lane: 'core', status: 'done', deps: ['decide'], owner: 'Builder', label: 'core' },
    { id: 'core2', lane: 'core', status: 'done', deps: ['decide'], owner: 'Builder', label: 'core' },
    ...[1, 2, 3, 4, 5].map(i => ({ id: `review${i}`, lane: 'review', status: S(i, 2, 4), deps: ['decide'], owner: `Reviewer ${i}`, label: 'review' })),
    ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap(i => [
      { id: `build${i}`, lane: 'build', status: i === 6 ? ('blocked' as const) : S(i, 3, 5), deps: ['core1', 'core2'], owner: `Builder ${i}`, label: 'build' },
      { id: `test${i}`, lane: 'build', status: S(i, 2, 3), deps: [`build${i}`], owner: `Tester ${i}` },
    ]),
    ...[1, 2, 3].map(i => ({ id: `spare${i}`, lane: 'spare', status: S(i, 0, 1), deps: ['decide'], owner: `Grok ${i}`, label: 'spare' })),
    { id: 'fix1', lane: 'fix', status: 'doing', deps: ['test1'], owner: 'Astra', label: 'fix' },
    { id: 'fix2', lane: 'fix', status: 'todo', deps: ['test2'], label: 'fix' },
    { id: 'src1', lane: 'src', status: 'done', deps: ['review1'], owner: 'Researcher', label: 'src' },
    { id: 'src2', lane: 'src', status: 'todo', deps: ['review2'], label: 'src' },
    {
      id: 'accept',
      status: 'todo',
      deps: [...[1, 2, 3, 4, 5].map(i => `review${i}`), ...[1, 2, 3, 4, 5, 6, 7, 8].map(i => `test${i}`), 'spare3', 'fix1', 'fix2', 'src1', 'src2'],
    },
    { id: 'main', status: 'todo', deps: ['accept'], owner: 'me' },
    { id: 'next', status: 'todo', deps: ['main'] },
    { id: 'risk', kind: 'note', status: 'todo', deps: ['main'] },
  ]
  return rows
}

/** 團隊示範：約 40 步的多人並行編排（只在畫面使用）。標題：繁中、英文（其他語言用英文）。 */
export function teamMap(nowMs: number, lang: Lang): WorkflowMap {
  const L = lang === 'zh-Hant' ? 'zh-Hant' : 'en'
  const tt = TEAM_TITLES[L]
  const ago = agoOf(nowMs)
  const title = (id: string) => {
    const m = /^([a-z]+)(\d+)$/.exec(id)
    return tt[id] ?? (m && tt[m[1]!] ? `${tt[m[1]!]} ${m[2]}` : id)
  }
  let k = 0
  const nodes = teamRows().map((r): WorkflowNode => {
    k++
    const started = r.status === 'todo' ? undefined : 120 - k * 2
    const done = r.status === 'done' ? 100 - k * 2 : undefined
    // 進行中的步驟最近有更新（不會顯示「久未更新」）
    const updated = r.status === 'doing' ? 2 + (k % 9) : (done ?? started ?? 130)
    const n: WorkflowNode = { id: r.id, title: title(r.id), status: r.status, deps: r.deps, updatedAt: ago(updated), log: logOf(ago, r.status, r.owner ?? '', started, done, 130) }
    if (r.lane) n.lane = LANES[L][r.lane]
    if (r.kind) n.kind = r.kind
    if (r.label) n.edgeLabel = tt[`l:${r.label}`]
    if (r.owner) n.owner = r.owner
    if (started !== undefined) n.startedAt = ago(started)
    if (done !== undefined) n.doneAt = ago(done)
    if (r.id === 'review5') {
      n.title = L === 'zh-Hant' ? '效能覆核' : 'Speed review'
      n.inserted = { at: ago(30)!, by: 'user', note: tt.insNote! }
      n.impact = { added: ['review5'], rewired: ['accept'], downstream: ['accept', 'main', 'next'] }
    }
    return n
  })
  return { schemaVersion: 2, version: 1, planId: 'demo-team', title: 'demo', createdAt: ago(130)!, updatedAt: ago(2)!, nodes, tombstones: [] }
}
