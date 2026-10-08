// /workflow-demo 用的示範資料：只在記憶體顯示，絕不寫入 .claude/workflow-map.json。
// 展示：已完成收成一組、三個並行（一個是用戶插入、一個久未更新）、一個受阻、負責人、用時、較遠的步驟收成「稍後」。
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

/** 示範計劃：時間按現在推算（幾分鐘前開始、完成），標題跟介面語言。 */
export function demoMap(nowMs: number, lang: Lang): WorkflowMap {
  const titles = TITLES[lang] ?? TITLES.en!
  const notes = NOTES[lang] ?? NOTES.en!
  const ago = (min?: number) => (min === undefined ? undefined : new Date(nowMs - min * 60_000).toISOString())
  const nodes = ROWS.map(([id, status, deps, owner, started, done, updated]): WorkflowNode => {
    const n: WorkflowNode = { id, title: titles[id]!, status, deps, updatedAt: ago(updated ?? done ?? 200) }
    if (owner) n.owner = owner
    if (started !== undefined) n.startedAt = ago(started)
    if (done !== undefined) n.doneAt = ago(done)
    if (id === 'dark') {
      n.inserted = { at: ago(14)!, by: 'user', note: notes.ins }
      n.log = [
        { at: ago(14)!, status: 'todo' },
        { at: ago(12)!, status: 'doing', by: 'Astra' },
      ]
    }
    if (id === 'shots') n.note = notes.blocked
    return n
  })
  return { schemaVersion: 2, version: 1, planId: 'demo', title: 'demo', createdAt: ago(200)!, updatedAt: ago(2)!, nodes, tombstones: [] }
}
