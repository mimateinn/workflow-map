// 純邏輯：資料驗證、操作、環偵測、拓撲分層、文字摘要。冇 $，可以直接測。
import type { WorkflowMap, WorkflowNode, WorkflowStatus } from '../types/index'
import { STR } from './i18n'
import type { Lang } from './i18n'

export const STATUSES: readonly WorkflowStatus[] = ['todo', 'doing', 'done', 'blocked', 'dropped']
const MARK: Record<WorkflowStatus, string> = { done: '✓', doing: '▶', todo: '○', blocked: '✗', dropped: '–' }
/** 流程圖的形狀（見 flow.ts）；note = 提醒，只畫在流程圖，不算一步 */
export const KINDS = ['step', 'decision', 'note'] as const

/** 算作「一步」：未取消、亦不是提醒（note）。進度、可開始、階段、聚焦都只看這些。 */
export const isStep = (n: WorkflowNode) => n.status !== 'dropped' && n.kind !== 'note'
/**
 * 插入的步驟用紫色 ◇ 只限「本輪」：本輪插入的，或本輪完成的（turnAt = 本輪開始的時間；0 = 未有一輪 → 都不是）。
 * 下一輪開始就回到一般樣式：完成的 = 一般完成（沒有記號）；舊輪插入、未完成的 = 一般狀態 + 標題前一個淡色 ◇（insertedMarked）。
 * 取消的一律一般樣式。插入紀錄仍在詳情、時間線、匯出。
 */
export function insertedHot(n: WorkflowNode, turnAt = 0): boolean {
  if (!n.inserted || n.status === 'dropped' || !turnAt) return false
  const at = (iso?: string) => Date.parse(iso ?? '') || 0
  return at(n.inserted.at) >= turnAt || (n.status === 'done' && at(n.doneAt) >= turnAt)
}
export const insertedMarked = (n: WorkflowNode, turnAt = 0) => !!n.inserted && n.status !== 'done' && n.status !== 'dropped' && !insertedHot(n, turnAt)
/** 依賴已不用等：完成、取消、或是提醒 */
const settledNode = (n: WorkflowNode | undefined) => !n || n.status === 'done' || !isStep(n)

/** 檔案格式版本：2 = 加入 planId、title、createdAt、tombstones、每步 updatedAt（見 docs/FORMAT.md） */
export const SCHEMA_VERSION = 2

const planIdFor = (at: string) => `p-${(Date.parse(at) || 0).toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export const emptyMap = (now = new Date(0).toISOString(), title = ''): WorkflowMap => ({
  schemaVersion: SCHEMA_VERSION,
  version: 1,
  planId: planIdFor(now),
  title,
  createdAt: now,
  updatedAt: now,
  nodes: [],
  tombstones: [],
})

const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 信任邊界：檔案入面嘅嘢一律當唔可信。合格就返 map，唔合格返原因。 */
export function validateMap(raw: unknown): WorkflowMap | string {
  if (!isObj(raw)) return 'top level is not an object'
  if (!Array.isArray(raw.nodes)) return 'nodes is not an array'
  const seen = new Set<string>()
  const nodes: WorkflowNode[] = []
  for (const [i, n] of raw.nodes.entries()) {
    if (!isObj(n)) return `nodes[${i}] is not an object`
    if (!isStr(n.id) || n.id === '') return `nodes[${i}].id is invalid`
    if (seen.has(n.id)) return `duplicate id: ${n.id}`
    seen.add(n.id)
    if (!isStr(n.title)) return `${n.id}.title is invalid`
    if (!STATUSES.includes(n.status as WorkflowStatus)) return `${n.id}.status is invalid`
    if (!Array.isArray(n.deps) || !n.deps.every(isStr)) return `${n.id}.deps is invalid`
    for (const k of ['lane', 'note', 'kind', 'edgeLabel'] as const) if (n[k] !== undefined && !isStr(n[k])) return `${n.id}.${k} is invalid`
    if (n.impact !== undefined) {
      const im = n.impact
      if (!isObj(im) || !(['added', 'rewired', 'downstream'] as const).every(k => Array.isArray(im[k]) && (im[k] as unknown[]).every(isStr))) return `${n.id}.impact is invalid`
    }
    if (n.inserted !== undefined) {
      const ins = n.inserted
      if (!isObj(ins) || !isStr(ins.at) || !isStr(ins.note)) return `${n.id}.inserted is invalid`
    }
    for (const k of ['owner', 'updatedAt', 'startedAt', 'doneAt'] as const) if (n[k] !== undefined && !isStr(n[k])) return `${n.id}.${k} is invalid`
    if (n.log !== undefined && (!Array.isArray(n.log) || !n.log.every(x => isObj(x) && isStr(x.at) && STATUSES.includes(x.status as WorkflowStatus))))
      return `${n.id}.log is invalid`
    // 保留未知欄位：其他 AI 可能加咗嘢，唔好靜靜食走
    nodes.push({ ...(n as WorkflowNode) })
  }
  if (raw.schemaVersion !== undefined && typeof raw.schemaVersion !== 'number') return 'schemaVersion is invalid'
  for (const k of ['planId', 'title', 'createdAt'] as const) if (raw[k] !== undefined && !isStr(raw[k])) return `${k} is invalid`
  if (raw.tombstones !== undefined && (!Array.isArray(raw.tombstones) || !raw.tombstones.every(x => isObj(x) && isStr(x.id) && isStr(x.at))))
    return 'tombstones is invalid'
  const version = typeof raw.version === 'number' ? raw.version : 1
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : new Date(0).toISOString()
  return { ...(raw as object), version, updatedAt, nodes } as WorkflowMap
}

/**
 * 舊格式 → 新格式（只加欄位，不刪任何東西）。v1 → v2：planId、title、createdAt、tombstones、每步 updatedAt。
 * 比本程式新的格式原樣返回（不降級）。
 */
export function migrate(map: WorkflowMap, now: string): { map: WorkflowMap; from: number } {
  const from = map.schemaVersion ?? 1
  if (from >= SCHEMA_VERSION) return { map, from }
  const at = map.updatedAt && Date.parse(map.updatedAt) > 0 ? map.updatedAt : now
  return {
    from,
    map: {
      ...map,
      schemaVersion: SCHEMA_VERSION,
      version: 1,
      planId: map.planId ?? planIdFor(map.createdAt ?? at),
      title: map.title ?? '',
      createdAt: map.createdAt ?? at,
      tombstones: map.tombstones ?? [],
      nodes: map.nodes.map(n => ({ ...n, updatedAt: n.updatedAt ?? at })),
    },
  }
}

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0)

/**
 * 兩個寫入者的合併（同一個計劃內）：每步取 updatedAt 較新者（相同時取 ours），
 * 刪除記錄（tombstone）不比該步最新修改舊時，該步保持刪除；依賴指向已刪步驟的會拿走。
 * 次序：ours 的次序，之後是只在 disk 的步驟。
 */
export function mergeMaps(disk: WorkflowMap, ours: WorkflowMap): WorkflowMap {
  const dById = new Map(disk.nodes.map(n => [n.id, n]))
  const oById = new Map(ours.nodes.map(n => [n.id, n]))
  const tombs = new Map<string, string>()
  for (const x of [...(disk.tombstones ?? []), ...(ours.tombstones ?? [])]) if (!tombs.has(x.id) || ms(x.at) > ms(tombs.get(x.id))) tombs.set(x.id, x.at)
  const order = [...ours.nodes.map(n => n.id), ...disk.nodes.map(n => n.id).filter(id => !oById.has(id))]
  const nodes: WorkflowNode[] = []
  for (const id of order) {
    const a = oById.get(id)
    const b = dById.get(id)
    const pick = !b ? a! : !a ? b : ms(b.updatedAt) > ms(a.updatedAt) ? b : a
    const dead = tombs.get(id)
    if (dead !== undefined && ms(dead) >= ms(pick.updatedAt)) continue
    tombs.delete(id)
    nodes.push(pick)
  }
  const ids = new Set(nodes.map(n => n.id))
  return {
    ...disk,
    ...ours,
    updatedAt: ms(disk.updatedAt) > ms(ours.updatedAt) ? disk.updatedAt : ours.updatedAt,
    nodes: nodes.map(n => (n.deps.every(d => ids.has(d)) ? n : { ...n, deps: n.deps.filter(d => ids.has(d)) })),
    tombstones: [...tombs].map(([id, at]) => ({ id, at })),
  }
}

/** 全部步驟都完成或取消（有步驟才算） */
export const planFinished = (map: WorkflowMap) => map.nodes.length > 0 && map.nodes.every(n => n.status === 'done' || !isStep(n))

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

/** 可以開工：todo 的步驟（提醒不算）而且所有（有效）依賴都完／棄。 */
export function readyIds(nodes: readonly WorkflowNode[]): Set<string> {
  const byId = new Map(nodes.map(n => [n.id, n]))
  return new Set(
    nodes
      .filter(n => n.status === 'todo' && n.kind !== 'note' && n.deps.every(d => settledNode(byId.get(d))))
      .map(n => n.id),
  )
}

export type Stats = { done: number; total: number; doing: string[]; ready: string[]; inserted: number }

export function stats(map: WorkflowMap): Stats {
  const live = map.nodes.filter(isStep)
  const ready = readyIds(map.nodes)
  return {
    done: live.filter(n => n.status === 'done').length,
    total: live.length,
    doing: map.nodes.filter(n => n.status === 'doing').map(n => n.title),
    ready: map.nodes.filter(n => ready.has(n.id)).map(n => n.title),
    inserted: map.nodes.filter(n => n.inserted).length,
  }
}

export const isActive = (map: WorkflowMap) => map.nodes.some(n => isStep(n) && (n.status === 'todo' || n.status === 'doing'))

export const allDone = (map: WorkflowMap) => {
  const s = stats(map)
  return s.total > 0 && s.done === s.total
}

/** 一行摘要（終端機、替代文字、指令輸出；亦為提供給模型的文字圖首行）。 */
export function compactLine(map: WorkflowMap, lang: Lang = 'en'): string {
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
export function plainLines(map: WorkflowMap, lang: Lang = 'en'): string[] {
  const t = STR[lang]
  const byId = new Map(map.nodes.map(n => [n.id, n]))
  const ready = readyIds(map.nodes)
  const doingTitles = map.nodes.filter(n => n.status === 'doing').map(n => n.title)
  // 最有用的先列：進行中 → 受阻 → 未開始 → 已完成 → 已取消（同組內按先後次序）
  const rank: Record<WorkflowStatus, number> = { doing: 0, blocked: 1, todo: 2, done: 3, dropped: 4 }
  return columns(map.nodes.filter(n => n.kind !== 'note'))
    .flat()
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rank[a.n.status] - rank[b.n.status] || a.i - b.i)
    .map(({ n }) => {
      const extra: string[] = []
      if (n.status === 'doing' && doingTitles.length > 1) extra.push(t.parallel(doingTitles.filter(x => x !== n.title).join(t.list)))
      const waiting = n.deps.map(d => byId.get(d)).filter(d => !settledNode(d))
      if (n.status === 'todo' && waiting.length) extra.push(t.waits(waiting.map(d => d!.title).join(t.list)))
      if (ready.has(n.id)) extra.push(t.ready)
      if (n.inserted) extra.push(t.inserted(n.inserted.note))
      return `${GLYPH[n.status]} ${t.status[n.status]}  ${n.title}${extra.length ? `${t.open}${extra.join(t.sep)}${t.close}` : ''}`
    })
}

/** 終端機字元：━ 已完成、● 進行中、╍ 未開始（旁邊必附文字說明）。 */
export const GLYPH: Record<WorkflowStatus, string> = { done: '━', doing: '●', todo: '╍', blocked: '✗', dropped: '·' }

/** 一步的文字（給模型）：✓A 標題 ←依賴 [ready; owner: x; inserted: …] */
function nodeText(n: WorkflowNode, ready: Set<string>): string {
  const tags = [
    ready.has(n.id) ? 'ready' : '',
    n.kind && n.kind !== 'step' ? n.kind : '',
    n.lane ? `lane: ${n.lane}` : '',
    n.owner ? `owner: ${n.owner}` : '',
    n.inserted ? `inserted: ${n.inserted.note}` : '',
  ].filter(Boolean)
  const deps = n.deps.length ? ` ←${n.deps.join(',')}` : ''
  return `${MARK[n.status]}${n.id} ${n.title}${deps}${tags.length ? ` [${tags.join('; ')}]` : ''}`
}

/**
 * 工具回覆（省 token）：一行摘要 + 這次改到的步驟及其直接前後步驟；刪除的只列 id。完整圖只在 show。
 */
export function opSummary(map: WorkflowMap, changed: readonly string[], removed: readonly string[] = []): string {
  const ready = readyIds(map.nodes)
  const want = new Set(changed)
  for (const id of changed) {
    for (const d of map.nodes.find(n => n.id === id)?.deps ?? []) want.add(d)
    for (const m of map.nodes) if (m.deps.includes(id)) want.add(m.id)
  }
  const lines = [compactLine(map, 'en'), ...map.nodes.filter(n => want.has(n.id)).map(n => `${changed.includes(n.id) ? '* ' : '  '}${nodeText(n, ready)}`)]
  if (removed.length) lines.push(`removed: ${removed.join(', ')}`)
  return lines.length > 40 ? [...lines.slice(0, 40), `…+${lines.length - 40} lines (op show for the full map)`].join('\n') : lines.join('\n')
}

/** 多行文字圖：畀 model 睇（op show）、畀終端機 fallback 用。 */
export function textDiagram(map: WorkflowMap, maxLines = 60, lang: Lang = 'en'): string {
  if (map.nodes.length === 0) return '(the workflow map is empty)'
  const ready = readyIds(map.nodes)
  const lines = [compactLine(map, lang)]
  columns(map.nodes).forEach((col, i) => {
    const cells = col.map(n => nodeText(n, ready))
    lines.push(`${'  '.repeat(Math.min(i, 6))}L${i}: ${cells.join('  ∥  ')}`)
  })
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `…+${lines.length - maxLines} lines`].join('\n') : lines.join('\n')
}

// ---------------- 操作 ----------------

export type NodeInput = {
  id: string
  title?: string
  status?: WorkflowStatus
  deps?: string[]
  lane?: string
  kind?: (typeof KINDS)[number]
  edgeLabel?: string
  note?: string
  owner?: string
}

export type Op =
  | { op: 'set_plan'; nodes: NodeInput[] }
  | { op: 'new_plan'; title?: string; nodes: NodeInput[] }
  | { op: 'upsert'; nodes: NodeInput[] }
  | { op: 'status'; id: string; status: WorkflowStatus; note?: string }
  | { op: 'insert'; nodes: NodeInput[]; note: string; before?: string[] }
  | { op: 'remove'; ids: string[] }
  | { op: 'show' }
  /** 內部（還原）：整份步驟換成快照的內容，作為一次新的寫入（改到的步驟有新的 updatedAt，消失的留 tombstone） */
  | { op: 'restore'; nodes: WorkflowNode[]; title?: string }

/** changed = 這次新增或改到的步驟；removed = 刪除的；archive = 先把原本的計劃封存到歷史 */
export type Applied = { map: WorkflowMap; info?: string; changed: string[]; removed: string[]; archive: boolean } | { error: string }

/** 只改有畀嘅欄位（唔用 {...incoming} 蓋成個 node）。 */
function merge(base: WorkflowNode | undefined, inp: NodeInput): WorkflowNode | string {
  if (!isStr(inp.id) || inp.id.trim() === '') return 'every node needs an id'
  if (inp.status !== undefined && !STATUSES.includes(inp.status)) return `${inp.id}: status must be ${STATUSES.join('/')}`
  if (inp.deps !== undefined && (!Array.isArray(inp.deps) || !inp.deps.every(isStr))) return `${inp.id}: deps must be an array of ids`
  for (const k of ['lane', 'note', 'edgeLabel'] as const) if (inp[k] !== undefined && !isStr(inp[k])) return `${inp.id}: ${k} must be text`
  if (inp.kind !== undefined && !KINDS.includes(inp.kind)) return `${inp.id}: kind must be ${KINDS.join('/')}`
  const title = inp.title ?? base?.title
  if (!isStr(title) || title.trim() === '') return `${inp.id}: a new node needs a title`
  const out: WorkflowNode = { ...(base ?? { id: inp.id, status: 'todo', deps: [] }), title }
  if (inp.status !== undefined) out.status = inp.status
  if (inp.deps !== undefined) out.deps = [...new Set(inp.deps)]
  if (inp.note !== undefined) out.note = inp.note
  // 組名、線上標籤：空字串 = 拿走；kind step = 預設（不寫入檔）
  for (const k of ['lane', 'edgeLabel'] as const) {
    const v = inp[k]?.trim()
    if (v) out[k] = v
    else if (v !== undefined) delete out[k]
  }
  if (inp.kind === 'step') delete out.kind
  else if (inp.kind !== undefined) out.kind = inp.kind
  if (inp.owner !== undefined) {
    if (!isStr(inp.owner)) return `${inp.id}: owner must be text`
    if (inp.owner.trim()) out.owner = inp.owner.trim()
    else delete out.owner
  }
  return out
}

/** 比較用：鍵排序、略去 undefined 及時間／紀錄欄位 */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : isObj(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .filter(k => v[k] !== undefined)
            .map(k => [k, canon(v[k])]),
        )
      : v
const sameNode = (a: WorkflowNode, b: WorkflowNode) => {
  const strip = (n: WorkflowNode) => ({ ...n, updatedAt: undefined, startedAt: undefined, doneAt: undefined, log: undefined })
  return JSON.stringify(canon(strip(a))) === JSON.stringify(canon(strip(b)))
}

/**
 * 驗證後蓋章：改到的步驟 updatedAt = now（狀態改變時記時間與紀錄）；刪除的步驟留 tombstone。
 * by = 誰改的（例如子代理名稱），記入紀錄。
 */
function finish(base: WorkflowMap, nodes: WorkflowNode[], now: string, o: { info?: string; by?: string; archive?: boolean } = {}): Applied {
  const ids = new Set(nodes.map(n => n.id))
  for (const n of nodes) {
    if (n.deps.includes(n.id)) return { error: `${n.id} cannot depend on itself` }
    const missing = n.deps.filter(d => !ids.has(d))
    if (missing.length) return { error: `${n.id} depends on unknown node(s): ${missing.join(', ')}` }
  }
  const cycle = findCycle(nodes)
  if (cycle) return { error: `this would create a dependency cycle: ${cycle.join(' → ')}. Nothing was changed.` }
  const before = new Map(base.nodes.map(n => [n.id, n]))
  const changed: string[] = []
  const out = nodes.map(n => {
    const old = before.get(n.id)
    if (old && sameNode(old, n)) return n
    changed.push(n.id)
    return stamp(old, { ...n, updatedAt: now }, now, o.by)
  })
  const removed = base.nodes.filter(n => !ids.has(n.id)).map(n => n.id)
  const tombstones = [...(base.tombstones ?? []).filter(t => !ids.has(t.id) && !removed.includes(t.id)), ...removed.map(id => ({ id, at: now }))]
  return {
    map: { ...base, schemaVersion: SCHEMA_VERSION, version: 1, updatedAt: now, nodes: out, tombstones },
    info: o.info,
    changed,
    removed,
    archive: !!o.archive,
  }
}

/** 由 ids 出發、沿「誰等它」一路往後的全部未完成步驟（不含 ids 本身；計劃次序；有環也不會無限走） */
export function downstreamOf(nodes: readonly WorkflowNode[], ids: readonly string[]): string[] {
  const after = new Map<string, string[]>()
  for (const m of nodes) for (const d of m.deps) after.set(d, [...(after.get(d) ?? []), m.id])
  const seen = new Set(ids)
  const queue = [...ids]
  while (queue.length)
    for (const m of after.get(queue.shift()!) ?? [])
      if (!seen.has(m)) {
        seen.add(m)
        queue.push(m)
      }
  return nodes.filter(n => seen.has(n.id) && !ids.includes(n.id) && isStep(n) && n.status !== 'done').map(n => n.id)
}

/**
 * 兩份計劃的差異（插入前的快照 → 現在），用來在現在的計劃上標出一個中途要求改了甚麼：
 * added = 之後才有的步驟；rewired = 本來已有、而依賴多了新步驟的（via = 那些新步驟）；
 * moved = 依賴深度變深、移到後面階段的（階段 = 依賴深度 + 1，只算未取消的步驟）；
 * blocked = 因新步驟而要等的全部未完成後續步驟（不含 added、rewired）；removed = 之前有、現在沒有或已取消的。
 */
export type PlanDiff = {
  added: string[]
  rewired: { id: string; via: string[] }[]
  moved: { id: string; from: number; to: number }[]
  blocked: string[]
  removed: { id: string; title: string }[]
}
/** 預設的階段：依賴深度 + 1（只算未取消的步驟）。畫面可傳入自己的編號（階段卡、流程圖的行），令「3 → 4」與畫面一致 */
const depthStages = (m: WorkflowMap) => new Map([...depths(m.nodes.filter(n => n.status !== 'dropped'))].map(([id, d]) => [id, d + 1]))

export function planDiff(before: WorkflowMap, after: WorkflowMap, stageOf: (m: WorkflowMap) => Map<string, number> = depthStages): PlanDiff {
  const liveB = before.nodes.filter(n => n.status !== 'dropped')
  const liveA = after.nodes.filter(n => n.status !== 'dropped')
  const bById = new Map(liveB.map(n => [n.id, n]))
  const aIds = new Set(liveA.map(n => n.id))
  const added = liveA.filter(n => !bById.has(n.id)).map(n => n.id)
  const isNew = new Set(added)
  const kept = liveA.filter(n => bById.has(n.id))
  const rewired = kept.map(n => ({ id: n.id, via: n.deps.filter(d => isNew.has(d) && !bById.get(n.id)!.deps.includes(d)) })).filter(r => r.via.length)
  const sb = stageOf(before)
  const sa = stageOf(after)
  const moved = kept.flatMap(n => {
    const from = sb.get(n.id)
    const to = sa.get(n.id)
    return from !== undefined && to !== undefined && to > from ? [{ id: n.id, from, to }] : []
  })
  const rew = new Set(rewired.map(r => r.id))
  const blocked = downstreamOf(liveA, added).filter(id => !rew.has(id))
  const removed = liveB.filter(n => !aIds.has(n.id)).map(n => ({ id: n.id, title: n.title }))
  return { added, rewired, moved, blocked, removed }
}

/** 每步最多保留幾筆狀態紀錄 */
export const LOG_MAX = 10

/**
 * 狀態改變時的附帶欄位：第一次 doing → startedAt；done → doneAt；離開 done → 刪 doneAt；
 * 紀錄加一筆（時間、狀態、誰），只留最後 LOG_MAX 筆。
 */
function stamp(old: WorkflowNode | undefined, n: WorkflowNode, now: string, by?: string): WorkflowNode {
  if (old?.status === n.status) return n
  const out = { ...n, log: [...(n.log ?? old?.log ?? []), { at: now, status: n.status, ...(by ? { by } : {}) }].slice(-LOG_MAX) }
  if (n.status === 'doing' && !out.startedAt) out.startedAt = now
  if (n.status === 'done') out.doneAt = now
  else delete out.doneAt
  return out
}

/** 用了多少分鐘：進行中 = 由 startedAt 到現在；已完成 = startedAt 到 doneAt。其他狀態或未有開始時間 → undefined。 */
export function elapsedMin(n: WorkflowNode, nowMs: number): number | undefined {
  const start = ms(n.startedAt)
  if (!start) return undefined
  const end = n.status === 'doing' ? nowMs : n.status === 'done' ? ms(n.doneAt) : 0
  return end ? Math.max(0, Math.floor((end - start) / 60_000)) : undefined
}

/** 剩餘時間範圍（分鐘）：lo–hi；n = 用來估算的已完成步驟數；rough = 少於 ETA_SURE 步（只是粗估） */
export type EtaRange = { lo: number; hi: number; n: number; rough: boolean }
/** 至少幾個有時間的已完成步驟才估；少於 ETA_SURE 個時標「約／rough」 */
export const ETA_MIN_STEPS = 3
export const ETA_SURE = 6

/** 已排序數列的分位數（線性內插） */
function quantile(sorted: readonly number[], p: number): number {
  const i = (sorted.length - 1) * p
  const a = sorted[Math.floor(i)]!
  const b = sorted[Math.ceil(i)]!
  return a + (b - a) * (i - Math.floor(i))
}

/**
 * 剩餘時間範圍：已完成而且有開始／完成時間的步驟 ≥ 3 才估（否則 undefined）。
 * 一步的用時取已完成步驟用時的 p25（lo）與 p75（hi）——用時越參差，範圍越闊。
 * 沿依賴分層（關鍵路徑）相加：同一層的並行步驟只算最長的一步；進行中的扣去已用時間（最少 0）。
 */
export function etaRange(map: WorkflowMap, nowMs: number): EtaRange | undefined {
  const durs = map.nodes
    .filter(n => n.status === 'done' && n.startedAt && n.doneAt)
    .map(n => (ms(n.doneAt) - ms(n.startedAt)) / 60_000)
    .filter(d => d >= 0)
    .sort((a, b) => a - b)
  if (durs.length < ETA_MIN_STEPS) return undefined
  const open = map.nodes.filter(n => isStep(n) && n.status !== 'done')
  if (open.length === 0) return undefined
  const levels = columns(open)
  const along = (step: number) =>
    levels.reduce((sum, level) => sum + Math.max(...level.map(n => (n.status === 'doing' && n.startedAt ? Math.max(0, step - (nowMs - ms(n.startedAt)) / 60_000) : step))), 0)
  const lo = Math.round(along(quantile(durs, 0.25)))
  return { lo, hi: Math.max(lo, Math.round(along(quantile(durs, 0.75)))), n: durs.length, rough: durs.length < ETA_SURE }
}

/** 剩餘時間的字：「≈ 40–70 分鐘」；粗估（少於 6 步）改為「約 40–70 分鐘」；short = 橫條用的短格式。沒有估算 → '' */
export function etaText(map: WorkflowMap, nowMs: number, lang: Lang, short = false): string {
  const r = etaRange(map, nowMs)
  if (!r) return ''
  const t = STR[lang]
  const d = short ? t.durShort : t.dur
  const range = r.lo === r.hi ? d(r.lo) : r.hi < 60 ? `${r.lo}–${d(r.hi)}` : `${d(r.lo)}–${d(r.hi)}`
  return `${r.rough ? t.roughMark : '≈'} ${range}`
}

/** 進行中但超過 staleMin 分鐘沒有更新（0 = 不檢查）。 */
export const isStale = (n: WorkflowNode, nowMs: number, staleMin: number) =>
  n.status === 'doing' && staleMin > 0 && nowMs - (ms(n.updatedAt) || ms(n.startedAt) || nowMs) > staleMin * 60_000

function freshNodes(inputs: unknown): WorkflowNode[] | string {
  if (!Array.isArray(inputs)) return 'needs a nodes array'
  const nodes: WorkflowNode[] = []
  for (const inp of inputs as NodeInput[]) {
    if (nodes.some(n => n.id === inp?.id)) return `duplicate id: ${inp.id}`
    const m = merge(undefined, inp)
    if (typeof m === 'string') return m
    nodes.push(m)
  }
  return nodes
}

export function applyOp(map: WorkflowMap, op: Op, now: string, by?: string): Applied {
  const byId = new Map(map.nodes.map(n => [n.id, n]))
  // 開新計劃：原本的計劃（有步驟時）先封存到歷史；新計劃不帶任何舊步驟
  const startNew = (title: string, inputs: unknown, info?: string): Applied => {
    const nodes = freshNodes(inputs)
    if (typeof nodes === 'string') return { error: `${op.op}: ${nodes}` }
    return finish(emptyMap(now, title), nodes, now, { info, by, archive: map.nodes.length > 0 })
  }
  switch (op.op) {
    case 'show':
      return { map, changed: [], removed: [], archive: false }
    case 'new_plan':
      return startNew(isStr(op.title) ? op.title.trim() : '', op.nodes, map.nodes.length ? 'Archived the previous plan to history; started a new plan.' : undefined)
    case 'set_plan': {
      if (!Array.isArray(op.nodes)) return { error: 'set_plan needs a nodes array' }
      // 舊計劃已全部完成：這是新工作，封存舊的，不帶回任何舊步驟（包括用戶插入的）
      if (planFinished(map)) return startNew('', op.nodes, 'The previous plan was finished: archived it to history and started a new plan.')
      const nodes = freshNodes(op.nodes)
      if (typeof nodes === 'string') return { error: `set_plan: ${nodes}` }
      for (const m of nodes) {
        const old = byId.get(m.id)
        if (old?.inserted) m.inserted = old.inserted // 用戶插入嘅標記唔准被蓋走
        if (old?.impact) m.impact = old.impact
        // 同一步驟的時間、負責人、紀錄沿用
        for (const k of ['startedAt', 'doneAt', 'log', 'owner'] as const) if (old?.[k] !== undefined && m[k] === undefined) (m as Record<string, unknown>)[k] = old[k]
      }
      // 同一個計劃內，新計劃冇提嘅用戶插入 node：保留，唔靜靜刪
      const kept = map.nodes.filter(n => n.inserted && !nodes.some(m => m.id === n.id))
      const keptIds = new Set([...nodes.map(n => n.id), ...kept.map(n => n.id)])
      for (const k of kept) nodes.push({ ...k, deps: k.deps.filter(d => keptIds.has(d)) })
      return finish(map, nodes, now, {
        by,
        info: kept.length ? `Kept ${kept.length} user-inserted node(s) (${kept.map(k => k.id).join(', ')}); use remove if they are no longer wanted.` : undefined,
      })
    }
    case 'upsert':
    case 'insert': {
      if (!Array.isArray(op.nodes) || op.nodes.length === 0) return { error: `${op.op} needs at least one node` }
      if (op.op === 'insert' && (!isStr(op.note) || op.note.trim() === '')) return { error: 'insert needs a note (what the user asked, short)' }
      const next = new Map(byId)
      for (const inp of op.nodes) {
        if (op.op === 'insert' && byId.has(inp?.id)) return { error: `insert id already exists: ${inp.id} (use upsert to change an existing node)` }
        const m = merge(next.get(inp?.id), inp)
        if (typeof m === 'string') return { error: m }
        if (op.op === 'insert') m.inserted = { at: now, by: 'user', note: op.note.trim() }
        next.set(m.id, m)
      }
      if (op.op === 'insert' && op.before?.length) {
        const newIds = op.nodes.map(n => n.id)
        for (const b of op.before) {
          const target = next.get(b)
          if (!target) return { error: `before names an unknown node: ${b}` }
          next.set(b, { ...target, deps: [...new Set([...target.deps, ...newIds])] })
        }
      }
      if (op.op === 'insert') {
        // 插入的影響（插入當刻）：新增的步驟、改為要等它的步驟、因此要等的全部未完成後續步驟
        const added = op.nodes.map(n => n.id)
        const impact = { added, rewired: [...new Set(op.before ?? [])], downstream: downstreamOf([...next.values()], added) }
        for (const id of added) next.set(id, { ...next.get(id)!, impact })
      }
      return finish(map, [...next.values()], now, { by })
    }
    case 'status': {
      const n = byId.get(op.id)
      if (!n) return { error: `no such node: ${op.id}` }
      if (!STATUSES.includes(op.status)) return { error: `status must be ${STATUSES.join('/')}` }
      const upd = { ...n, status: op.status, ...(op.note !== undefined ? { note: op.note } : {}) }
      return finish(map, map.nodes.map(x => (x.id === op.id ? upd : x)), now, { by })
    }
    case 'remove': {
      if (!Array.isArray(op.ids) || op.ids.length === 0) return { error: 'remove needs ids' }
      const missing = op.ids.filter(id => !byId.has(id))
      if (missing.length) return { error: `no such node(s): ${missing.join(', ')}` }
      const gone = new Set(op.ids)
      return finish(
        map,
        map.nodes.filter(n => !gone.has(n.id)).map(n => ({ ...n, deps: n.deps.filter(d => !gone.has(d)) })),
        now,
        { by },
      )
    }
    case 'restore': {
      if (!Array.isArray(op.nodes)) return { error: 'restore needs nodes' }
      const restored = { ...map, title: op.title ?? map.title }
      return finish(restored, op.nodes.map(n => ({ ...n, deps: [...n.deps] })), now, { by })
    }
    default:
      return { error: `unknown op: ${(op as { op?: unknown }).op}; use new_plan/set_plan/upsert/status/insert/remove/show` }
  }
}

// ---------------- 聚焦（只影響畫面；給模型的文字圖永遠完整） ----------------

export type Focus = {
  /** 要畫出的步驟 id */
  visible: Set<string>
  /** 收起的已完成步驟（插入的也算） */
  doneFolded: string[]
  /** 收起的較遠未來步驟 */
  futureFolded: string[]
}

export type FocusOptions = {
  /** 本輪開始時間（ms）；此後插入、未完成的步驟一定顯示 */
  freshSince?: number
  expandDone?: boolean
  expandFuture?: boolean
  /** 步驟數 ≤ 此值時全部顯示（預設 6） */
  smallPlan?: number
}

/**
 * 聚焦集合：進行中 + 受阻 + 可開始 + 再多一層後續；本輪新插入的一定顯示。
 * 沒有進行中也沒有可開始（全部受阻）時，加上受阻步驟未完成的前置步驟。
 * 已完成全部收成一粒；更遠的未來收成一粒。步驟數 ≤ 6 時不收。
 */
export function focusSet(map: WorkflowMap, o: FocusOptions = {}): Focus {
  const live = map.nodes.filter(isStep)
  const done = live.filter(n => n.status === 'done')
  const open = live.filter(n => n.status !== 'done')
  if (live.length <= (o.smallPlan ?? 6)) return { visible: new Set(live.map(n => n.id)), doneFolded: [], futureFolded: [] }

  const byId = new Map(live.map(n => [n.id, n]))
  const ready = readyIds(live)
  const core = new Set(open.filter(n => n.status === 'doing' || n.status === 'blocked' || ready.has(n.id)).map(n => n.id))
  if (!open.some(n => n.status === 'doing' || ready.has(n.id))) {
    for (const n of open.filter(x => x.status === 'blocked'))
      for (const d of n.deps) if (byId.get(d) && byId.get(d)!.status !== 'done') core.add(d)
  }
  const visible = new Set(core)
  for (const n of open) {
    if (n.deps.some(d => core.has(d) && (byId.get(d)?.status === 'doing' || ready.has(d)))) visible.add(n.id)
    if (n.inserted && o.freshSince !== undefined && Date.parse(n.inserted.at) >= o.freshSince) visible.add(n.id)
  }
  if (o.expandDone) for (const n of done) visible.add(n.id)
  if (o.expandFuture) for (const n of open) visible.add(n.id)
  return {
    visible,
    doneFolded: o.expandDone ? [] : done.map(n => n.id),
    futureFolded: open.filter(n => !visible.has(n.id)).map(n => n.id),
  }
}

// ---------------- 階段（畫面用：已完成一組 + 未完成按依賴分層） ----------------

export type StageView = {
  /** 已完成（按計劃先後） */
  done: WorkflowNode[]
  /** true = 已完成收成一張卡（步驟多而且未要求展開） */
  foldDone: boolean
  /** 要畫的階段：未完成步驟按「未完成依賴」分層；同層 = 可並行。層內：進行中 → 受阻 → 可開始 → 其餘 */
  levels: WorkflowNode[][]
  /** 收起的較遠階段（攤平） */
  later: WorkflowNode[]
}

/**
 * 階段視圖：已完成全部歸一組；未完成按依賴分層，畫到聚焦集合（focusSet）最遠可見的一層為止，
 * 之後的層收成「稍後」。聚焦規則（小計劃不收、本輪插入一定顯示、展開）沿用 focusSet。
 */
export function stageView(map: WorkflowMap, o: FocusOptions = {}): StageView {
  const live = map.nodes.filter(isStep)
  const open = live.filter(n => n.status !== 'done')
  const ready = readyIds(map.nodes)
  const rank = (n: WorkflowNode) => (n.status === 'doing' ? 0 : n.status === 'blocked' ? 1 : ready.has(n.id) ? 2 : 3)
  // columns() 只計清單內的依賴：已完成的依賴不再佔一層
  const all = columns(open).map(c => [...c].sort((a, b) => rank(a) - rank(b)))
  const f = focusSet(map, o)
  let last = -1
  all.forEach((lv, i) => {
    if (lv.some(n => f.visible.has(n.id))) last = i
  })
  if (last < 0) last = all.length - 1
  return {
    done: columns(live).flat().filter(n => n.status === 'done'),
    foldDone: f.doneFolded.length > 0,
    levels: all.slice(0, last + 1),
    later: all.slice(last + 1).flat(),
  }
}

/** 插入的影響一句：「影響：+1 步 · 1 步改為等它 · 後續 3 步（甲、乙、丙）」 */
export function impactText(map: WorkflowMap, n: WorkflowNode, lang: Lang): string {
  const t = STR[lang]
  const im = n.impact
  if (!im) return ''
  const byId = new Map(map.nodes.map(m => [m.id, m.title]))
  const names = im.downstream.map(id => byId.get(id)).filter(Boolean)
  return `${t.dImpact(im.added.length, im.rewired.length, im.downstream.length)}${names.length ? `${t.open}${names.join(t.list)}${t.close}` : ''}`
}

/** ISO → 本地 MM-DD HH:MM；缺少或無效（含 1970 起點）時回傳空字串。 */
export function fmtTime(iso: string | undefined): string {
  const d = new Date(iso ?? '')
  if (!iso || Number.isNaN(d.getTime()) || d.getTime() <= 86_400_000) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 把計劃寫成 Markdown（給 HANDOFF 的「In progress」、PR 說明）：標題、進度、全部階段（勾選框）、負責人、用時、
 * 用戶中途加的要求。全部階段都列出，不收起。
 */
export function exportMarkdown(map: WorkflowMap, lang: Lang, nowMs: number): string {
  const t = STR[lang]
  const s = stats(map)
  const view = stageView(map, { expandDone: true, expandFuture: true, smallPlan: Infinity })
  const ready = readyIds(map.nodes)
  const byId = new Map(map.nodes.map(n => [n.id, n]))
  const eta = etaText(map, nowMs, lang)
  const blocked = map.nodes.filter(n => n.status === 'blocked').length
  const line = (n: WorkflowNode): string[] => {
    const min = elapsedMin(n, nowMs)
    const state = n.status === 'todo' ? (ready.has(n.id) ? t.ready : '') : n.status === 'done' ? '' : t.status[n.status]
    const waiting = n.deps.map(d => byId.get(d)).filter((d): d is WorkflowNode => !settledNode(d))
    const meta = [n.owner ?? '', state, min === undefined ? '' : t.dur(min), n.status !== 'done' && waiting.length ? t.waitShort(waiting.map(d => d.title).join(t.list)) : '']
      .filter(Boolean)
      .join(' · ')
    const out = [`- [${n.status === 'done' ? 'x' : ' '}] ${n.title.replace(/\s+/g, ' ')}${meta ? ` — ${meta}` : ''}`]
    if (n.inserted) out.push(`  - ◇ ${t.helpLegend.ins}${fmtTime(n.inserted.at) ? ` (${fmtTime(n.inserted.at)})` : ''}: “${n.inserted.note}”`)
    if (n.impact) out.push(`  - ${impactText(map, n, lang)}`)
    if (n.note && n.status !== 'done') out.push(`  - ${n.note}`)
    return out
  }
  const out = [
    `# ${map.title || t.paneTitle}`,
    '',
    `**${t.progress}:** ${s.done}/${s.total}${[t.statusLine(s.doing.length, blocked, ready.size), eta]
      .filter(Boolean)
      .map(x => ` · ${x}`)
      .join('')}`,
  ]
  if (view.done.length) out.push('', `## ✓ ${t.doneStage(view.done.length)}`, ...view.done.flatMap(line))
  view.levels.forEach((lv, i) => out.push('', `## ${t.stage(i + 1, lv.length)}`, ...lv.flatMap(line)))
  const tl = timeline(map, lang)
  if (tl.length) out.push('', `## ${t.timelineBtn}`, ...tl.map(e => `- ${fmtTime(e.at)} ${e.text}`))
  return `${out.join('\n')}\n`
}

export type TimelineEvent = { at: string; text: string }

/**
 * 時間線（由舊到新）：開計劃、加入步驟（每步紀錄的第一筆）、用戶中途的要求（原話）、狀態變化（誰）、還原。
 * 只由檔案已有的資料推算（每步最多 LOG_MAX 筆紀錄，更早的不在）；沒有時間的略過。
 */
export function timeline(map: WorkflowMap, lang: Lang): TimelineEvent[] {
  const t = STR[lang]
  const ev: { at: string; ms: number; seq: number; text: string }[] = []
  const push = (at: string | undefined, text: string) => {
    const v = Date.parse(at ?? '')
    if (at && v > 86_400_000) ev.push({ at, ms: v, seq: ev.length, text })
  }
  push(map.createdAt, t.tlCreated(map.title && map.title !== 'demo' ? map.title : ''))
  for (const n of map.nodes) {
    if (n.inserted) push(n.inserted.at, t.tlInserted(n.title, n.inserted.note))
    ;(n.log ?? []).forEach((e, i) => {
      if (i === 0 && !n.inserted) push(e.at, t.tlAdded(n.title))
      if (i === 0 && e.status === 'todo') return
      push(e.at, e.by === 'undo' ? t.tlUndo(n.title, t.status[e.status]) : t.tlStatus(n.title, t.status[e.status], e.by ?? ''))
    })
  }
  return ev.sort((a, b) => a.ms - b.ms || a.seq - b.seq).map(({ at, text }) => ({ at, text }))
}

export const DONE_ID = '__done__'
export const MORE_ID = '__more__'

/**
 * 依聚焦集合造一張「畫面用」的圖：只留可見步驟；收起的已完成變成最左一粒 DONE_ID，
 * 收起的未來變成最右一粒 MORE_ID，線由它們接到可見步驟。
 */
export function focusedMap(map: WorkflowMap, f: Focus): WorkflowMap {
  const folded = new Set(f.doneFolded)
  const future = new Set(f.futureFolded)
  const nodes: WorkflowNode[] = []
  if (f.doneFolded.length) nodes.push({ id: DONE_ID, title: String(f.doneFolded.length), status: 'done', deps: [] })
  for (const n of map.nodes) {
    if (!f.visible.has(n.id)) continue
    const deps = n.deps.filter(d => f.visible.has(d))
    if (n.deps.some(d => folded.has(d)) && f.doneFolded.length) deps.unshift(DONE_ID)
    nodes.push({ ...n, deps })
  }
  if (f.futureFolded.length) {
    let anchors = map.nodes.filter(n => f.visible.has(n.id) && map.nodes.some(m => future.has(m.id) && m.deps.includes(n.id))).map(n => n.id)
    if (!anchors.length) {
      const last = columns(nodes.filter(n => n.id !== DONE_ID)).flat().pop()
      anchors = last ? [last.id] : []
    }
    nodes.push({ id: MORE_ID, title: String(f.futureFolded.length), status: 'todo', deps: anchors })
  }
  return { ...map, nodes }
}
