// 純邏輯：資料驗證、操作、環偵測、拓撲分層、文字摘要。冇 $，可以直接測。
import type { WorkflowMap, WorkflowNode, WorkflowStatus } from '../types/index'
import { STR } from './i18n'
import type { Lang } from './i18n'

export const STATUSES: readonly WorkflowStatus[] = ['todo', 'doing', 'done', 'blocked', 'dropped']
const MARK: Record<WorkflowStatus, string> = { done: '✓', doing: '▶', todo: '○', blocked: '✗', dropped: '–' }

export const emptyMap = (): WorkflowMap => ({ version: 1, updatedAt: new Date(0).toISOString(), nodes: [] })

const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 信任邊界：檔案入面嘅嘢一律當唔可信。合格就返 map，唔合格返原因。 */
export function validateMap(raw: unknown): WorkflowMap | string {
  if (!isObj(raw)) return '頂層不是物件'
  if (!Array.isArray(raw.nodes)) return 'nodes 不是陣列'
  const seen = new Set<string>()
  const nodes: WorkflowNode[] = []
  for (const [i, n] of raw.nodes.entries()) {
    if (!isObj(n)) return `nodes[${i}] 不是物件`
    if (!isStr(n.id) || n.id === '') return `nodes[${i}].id 無效`
    if (seen.has(n.id)) return `id 重複：${n.id}`
    seen.add(n.id)
    if (!isStr(n.title)) return `${n.id}.title 無效`
    if (!STATUSES.includes(n.status as WorkflowStatus)) return `${n.id}.status 無效`
    if (!Array.isArray(n.deps) || !n.deps.every(isStr)) return `${n.id}.deps 無效`
    if (n.lane !== undefined && !isStr(n.lane)) return `${n.id}.lane 無效`
    if (n.note !== undefined && !isStr(n.note)) return `${n.id}.note 無效`
    if (n.inserted !== undefined) {
      const ins = n.inserted
      if (!isObj(ins) || !isStr(ins.at) || !isStr(ins.note)) return `${n.id}.inserted 無效`
    }
    // 保留未知欄位：其他 AI 可能加咗嘢，唔好靜靜食走
    nodes.push({ ...(n as WorkflowNode) })
  }
  const version = typeof raw.version === 'number' ? raw.version : 1
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : new Date(0).toISOString()
  return { ...(raw as object), version, updatedAt, nodes } as WorkflowMap
}

/** 搵一個環，返環上嘅 id 路徑（首尾相同），冇就 undefined。 */
export function findCycle(nodes: readonly WorkflowNode[]): string[] | undefined {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const state = new Map<string, 1 | 2>() // 1 = 行緊, 2 = 完
  const stack: string[] = []
  const visit = (id: string): string[] | undefined => {
    state.set(id, 1)
    stack.push(id)
    for (const d of byId.get(id)?.deps ?? []) {
      if (!byId.has(d)) continue
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d]
      if (state.get(d) === undefined) {
        const found = visit(d)
        if (found) return found
      }
    }
    stack.pop()
    state.set(id, 2)
    return undefined
  }
  for (const n of nodes) {
    if (state.get(n.id) === undefined) {
      const found = visit(n.id)
      if (found) return found
    }
  }
  return undefined
}

/** 拓撲深度：冇（有效）依賴 = 0，否則 1 + max(依賴深度)。假設無環。 */
export function depths(nodes: readonly WorkflowNode[]): Map<string, number> {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const memo = new Map<string, number>()
  const depth = (id: string): number => {
    const known = memo.get(id)
    if (known !== undefined) return known
    memo.set(id, 0) // 防萬一有環都唔會無限遞迴
    const deps = (byId.get(id)?.deps ?? []).filter(d => byId.has(d))
    const v = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(depth))
    memo.set(id, v)
    return v
  }
  for (const n of nodes) depth(n.id)
  return memo
}

/** 按深度分欄；同一欄 = 可並行。欄內保持原本次序。 */
export function columns(nodes: readonly WorkflowNode[]): WorkflowNode[][] {
  const d = depths(nodes)
  const cols: WorkflowNode[][] = []
  for (const n of nodes) (cols[d.get(n.id) ?? 0] ??= []).push(n)
  return cols.map(c => c ?? [])
}

const settled = (s: WorkflowStatus | undefined) => s === 'done' || s === 'dropped'

/** 可以開工：todo 而且所有（有效）依賴都完／棄。 */
export function readyIds(nodes: readonly WorkflowNode[]): Set<string> {
  const byId = new Map(nodes.map(n => [n.id, n]))
  return new Set(
    nodes
      .filter(n => n.status === 'todo' && n.deps.every(d => !byId.has(d) || settled(byId.get(d)?.status)))
      .map(n => n.id),
  )
}

export type Stats = { done: number; total: number; doing: string[]; ready: string[]; inserted: number }

export function stats(map: WorkflowMap): Stats {
  const live = map.nodes.filter(n => n.status !== 'dropped')
  const ready = readyIds(map.nodes)
  return {
    done: live.filter(n => n.status === 'done').length,
    total: live.length,
    doing: map.nodes.filter(n => n.status === 'doing').map(n => n.title),
    ready: map.nodes.filter(n => ready.has(n.id)).map(n => n.title),
    inserted: map.nodes.filter(n => n.inserted).length,
  }
}

export const isActive = (map: WorkflowMap) => map.nodes.some(n => n.status === 'todo' || n.status === 'doing')

export const allDone = (map: WorkflowMap) => {
  const s = stats(map)
  return s.total > 0 && s.done === s.total
}

/** 一行摘要（終端機、替代文字、指令輸出；亦為提供給模型的文字圖首行）。 */
export function compactLine(map: WorkflowMap, lang: Lang = 'zh'): string {
  const t = STR[lang]
  const s = stats(map)
  if (allDone(map)) return `${t.allDone} ${s.done}/${s.total}${s.inserted ? ` | ${t.insertCount} ${s.inserted}` : ''}`
  const parts = [`${t.progress} ${s.done}/${s.total}`]
  if (s.doing.length) parts.push(`${t.doing}${s.doing.join(t.list)}`)
  if (s.ready.length) parts.push(`${t.next}${s.ready.join(t.list)}`)
  if (s.inserted) parts.push(`${t.insertCount} ${s.inserted}`)
  return parts.join(' | ')
}

/** 每步一行的清單，不顯示 id 或暗語符號。供終端機及全圖面板使用。 */
export function plainLines(map: WorkflowMap, lang: Lang = 'zh'): string[] {
  const t = STR[lang]
  const byId = new Map(map.nodes.map(n => [n.id, n]))
  const ready = readyIds(map.nodes)
  const doingTitles = map.nodes.filter(n => n.status === 'doing').map(n => n.title)
  // 最有用的先列：進行中 → 受阻 → 未開始 → 已完成 → 已取消（同組內按先後次序）
  const rank: Record<WorkflowStatus, number> = { doing: 0, blocked: 1, todo: 2, done: 3, dropped: 4 }
  return columns(map.nodes)
    .flat()
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rank[a.n.status] - rank[b.n.status] || a.i - b.i)
    .map(({ n }) => {
      const extra: string[] = []
      if (n.status === 'doing' && doingTitles.length > 1) extra.push(t.parallel(doingTitles.filter(x => x !== n.title).join(t.list)))
      const waiting = n.deps.map(d => byId.get(d)).filter(d => d && d.status !== 'done' && d.status !== 'dropped')
      if (n.status === 'todo' && waiting.length) extra.push(t.waits(waiting.map(d => d!.title).join(t.list)))
      if (ready.has(n.id)) extra.push(t.ready)
      if (n.inserted) extra.push(t.inserted(n.inserted.note))
      return `${GLYPH[n.status]} ${t.status[n.status]}  ${n.title}${extra.length ? `${t.open}${extra.join(lang === 'zh' ? '；' : '; ')}${t.close}` : ''}`
    })
}

/** 終端機字元：━ 已完成、● 進行中、╍ 未開始（旁邊必附文字說明）。 */
export const GLYPH: Record<WorkflowStatus, string> = { done: '━', doing: '●', todo: '╍', blocked: '✗', dropped: '·' }

/** 多行文字圖：畀 model 睇、畀終端機 fallback 用。 */
export function textDiagram(map: WorkflowMap, maxLines = 60, lang: Lang = 'zh'): string {
  if (map.nodes.length === 0) return '（工作流程為空）'
  const ready = readyIds(map.nodes)
  const lines = [compactLine(map, lang)]
  columns(map.nodes).forEach((col, i) => {
    const cells = col.map(n => {
      const tags = [ready.has(n.id) ? '可開始' : '', n.inserted ? `插:${n.inserted.note}` : ''].filter(Boolean)
      const deps = n.deps.length ? ` ←${n.deps.join(',')}` : ''
      return `${MARK[n.status]}${n.id} ${n.title}${deps}${tags.length ? ` [${tags.join('; ')}]` : ''}`
    })
    lines.push(`${'  '.repeat(Math.min(i, 6))}L${i}: ${cells.join('  ∥  ')}`)
  })
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `…+${lines.length - maxLines} 行`].join('\n') : lines.join('\n')
}

// ---------------- 操作 ----------------

export type NodeInput = {
  id: string
  title?: string
  status?: WorkflowStatus
  deps?: string[]
  lane?: string
  note?: string
}

export type Op =
  | { op: 'set_plan'; nodes: NodeInput[] }
  | { op: 'upsert'; nodes: NodeInput[] }
  | { op: 'status'; id: string; status: WorkflowStatus; note?: string }
  | { op: 'insert'; nodes: NodeInput[]; note: string; before?: string[] }
  | { op: 'remove'; ids: string[] }
  | { op: 'show' }

type Applied = { map: WorkflowMap; info?: string } | { error: string }

/** 只改有畀嘅欄位（唔用 {...incoming} 蓋成個 node）。 */
function merge(base: WorkflowNode | undefined, inp: NodeInput): WorkflowNode | string {
  if (!isStr(inp.id) || inp.id.trim() === '') return '步驟需有 id'
  if (inp.status !== undefined && !STATUSES.includes(inp.status)) return `${inp.id}: status 須為 ${STATUSES.join('/')}`
  if (inp.deps !== undefined && (!Array.isArray(inp.deps) || !inp.deps.every(isStr))) return `${inp.id}: deps 須為 id 陣列`
  const title = inp.title ?? base?.title
  if (!isStr(title) || title.trim() === '') return `${inp.id}: 新步驟需有 title`
  const out: WorkflowNode = { ...(base ?? { id: inp.id, status: 'todo', deps: [] }), title }
  if (inp.status !== undefined) out.status = inp.status
  if (inp.deps !== undefined) out.deps = [...new Set(inp.deps)]
  if (inp.lane !== undefined) out.lane = inp.lane
  if (inp.note !== undefined) out.note = inp.note
  return out
}

function finish(base: WorkflowMap, nodes: WorkflowNode[], now: string, info?: string): Applied {
  const ids = new Set(nodes.map(n => n.id))
  for (const n of nodes) {
    if (n.deps.includes(n.id)) return { error: `${n.id} 不可依賴自身` }
    const missing = n.deps.filter(d => !ids.has(d))
    if (missing.length) return { error: `${n.id} 依賴不存在的步驟：${missing.join(', ')}` }
  }
  const cycle = findCycle(nodes)
  if (cycle) return { error: `會形成依賴環：${cycle.join(' → ')}。未作任何更改。` }
  return { map: { ...base, version: 1, updatedAt: now, nodes }, info }
}

export function applyOp(map: WorkflowMap, op: Op, now: string): Applied {
  const byId = new Map(map.nodes.map(n => [n.id, n]))
  switch (op.op) {
    case 'show':
      return { map }
    case 'set_plan': {
      if (!Array.isArray(op.nodes)) return { error: 'set_plan 需要 nodes 陣列' }
      const nodes: WorkflowNode[] = []
      for (const inp of op.nodes) {
        if (nodes.some(n => n.id === inp?.id)) return { error: `id 重複：${inp.id}` }
        const m = merge(undefined, inp)
        if (typeof m === 'string') return { error: m }
        const old = byId.get(m.id)
        if (old?.inserted) m.inserted = old.inserted // 用戶插入嘅標記唔准被蓋走
        nodes.push(m)
      }
      // 新計劃冇提嘅用戶插入 node：保留，唔靜靜刪
      const kept = map.nodes.filter(n => n.inserted && !nodes.some(m => m.id === n.id))
      const keptIds = new Set([...nodes.map(n => n.id), ...kept.map(n => n.id)])
      for (const k of kept) nodes.push({ ...k, deps: k.deps.filter(d => keptIds.has(d)) })
      return finish(map, nodes, now, kept.length ? `保留 ${kept.length} 項用戶插入（${kept.map(k => k.id).join(', ')}）；如不需要請用 remove。` : undefined)
    }
    case 'upsert':
    case 'insert': {
      if (!Array.isArray(op.nodes) || op.nodes.length === 0) return { error: `${op.op} 至少需要一個步驟` }
      if (op.op === 'insert' && (!isStr(op.note) || op.note.trim() === '')) return { error: 'insert 需要 note（用戶插入的內容，簡短）' }
      const next = new Map(byId)
      for (const inp of op.nodes) {
        if (op.op === 'insert' && byId.has(inp?.id)) return { error: `insert 的 id 已存在：${inp.id}（修改現有步驟請用 upsert）` }
        const m = merge(next.get(inp?.id), inp)
        if (typeof m === 'string') return { error: m }
        if (op.op === 'insert') m.inserted = { at: now, by: 'user', note: op.note.trim() }
        next.set(m.id, m)
      }
      if (op.op === 'insert' && op.before?.length) {
        const newIds = op.nodes.map(n => n.id)
        for (const b of op.before) {
          const target = next.get(b)
          if (!target) return { error: `before 指向不存在的步驟：${b}` }
          next.set(b, { ...target, deps: [...new Set([...target.deps, ...newIds])] })
        }
      }
      return finish(map, [...next.values()], now)
    }
    case 'status': {
      const n = byId.get(op.id)
      if (!n) return { error: `無此步驟：${op.id}` }
      if (!STATUSES.includes(op.status)) return { error: `status 須為 ${STATUSES.join('/')}` }
      const upd = { ...n, status: op.status, ...(op.note !== undefined ? { note: op.note } : {}) }
      return finish(map, map.nodes.map(x => (x.id === op.id ? upd : x)), now)
    }
    case 'remove': {
      if (!Array.isArray(op.ids) || op.ids.length === 0) return { error: 'remove 需要 ids' }
      const missing = op.ids.filter(id => !byId.has(id))
      if (missing.length) return { error: `無此等步驟：${missing.join(', ')}` }
      const gone = new Set(op.ids)
      return finish(map, 
        map.nodes.filter(n => !gone.has(n.id)).map(n => ({ ...n, deps: n.deps.filter(d => !gone.has(d)) })),
        now,
      )
    }
    default:
      return { error: `未知 op：${(op as { op?: unknown }).op}；可用 set_plan/upsert/status/insert/remove/show` }
  }
}
