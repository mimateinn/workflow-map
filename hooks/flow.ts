// 流程圖（編排圖）：純版面計算 + SVG 畫法 + 終端機大綱。冇 $，可以直接測。
// 畫法（0.5.0 定稿「階段列 + 匯流線」）：由上而下，每個階段（依賴層）一行，左邊淡色「階段 n」；同一階段的組並排
// （組 = lane：容器 + 標題 + 數目；組內格子，「A → B」鏈同一行，單格補空位）。決策 = 虛線框；提醒（note）= 琥珀框，同行並排。
// 線只有一種：相鄰兩行之間一條橫的匯流線，上一行有後續的單位一條短豎線落到線上、下一行有前置的單位由線上一條短箭咀進入框頂。
// 不畫長線：跨過階段（或向上）的依賴改為框內一行淡色「← 待 X、Y」（只列未完成的前置）；線上的標籤改為框內淡色「經：…」。
// 決定性：同一份輸入永遠同一個輸出（穩定排序，無隨機）。
import type { WorkflowMap, WorkflowNode } from '../types/index'
import { isStep, readyIds } from './graph'
import { STR } from './i18n'
import type { Lang } from './i18n'
import { cells, fitCells } from './suggest'
import { doc, fit, icon, insFresh, insHot, insMark, kindOf, text, tw } from './svg'
import type { Clock, Pic, Theme } from './svg'
import { glyph } from './tui'
import type { Seg } from './tui'

export type FlowKind = 'step' | 'decision' | 'note'
export const flowKind = (n: WorkflowNode): FlowKind => (n.kind === 'decision' || n.kind === 'note' ? n.kind : 'step')

type Rect = { x: number; y: number; w: number; h: number }
export type FlowCell = Rect & { id: string }
export type FlowUnit = Rect & {
  id: string
  /** 組名（lane）；冇 lane 的單獨步驟沒有 */
  group?: string
  /** 組員 id（計劃次序） */
  members: string[]
  cells: FlowCell[]
  /** 組內「A → B」的短箭咀 */
  links: { x1: number; x2: number; y: number }[]
  /** 階段（依賴層）與畫面上的第幾行（一個階段放不下會分幾行） */
  layer: number
  row: number
  /** 「經：…」：組員的 edgeLabel（去重，· 分隔）；空 = 沒有 */
  label: string
  /** 「← 待 …」：沒有經匯流線連上、而且未完成的前置（單位名稱）；空 = 沒有 */
  waits: string[]
}
/** 一條匯流線（相鄰兩行之間）：ups = 上一行落到線上的單位、downs = 由線上進入的單位（x = 單位中線，y = 框邊） */
export type FlowBus = { y: number; x1: number; x2: number; ups: { from: string; x: number; y: number }[]; downs: { to: string; x: number; y: number }[] }
export type FlowLayout = {
  width: number
  height: number
  cellW: number
  /** 左邊「階段 n」一欄的闊度 */
  gut: number
  stages: { label: string; y: number }[]
  units: FlowUnit[]
  buses: FlowBus[]
}

// ---- 尺寸（px） ----
const NODE_H = 28
/** 格內：圖示中心 11、文字由 24 開始、右邊留 10 */
const CHROME = 34
const CW_MIN = 96
const CW_MAX = 168
/** 組內鏈「A → B」兩格之間（有鏈的組，格與格之間都用這個距離，令格子對齊） */
const LINK_W = 22
/** 組內沒有鏈時，格與格之間（橫）；行與行之間 */
const COL_GAP = 8
const ROW_GAP = 8
const PAD = 10
/** 組名一行（含與下一行的距離）；每行淡色附註（← 待、經：） */
const HEAD_H = 22
const META_H = 16
const UNIT_GAP = 16
/** 四邊留白（紫色外框突出格外 2px，不可被切走） */
const MARGIN = 3
const ARROW = 6
/** 組內一行最多幾格 */
const MAX_PER_ROW = 4
/** 標題前淡色 ◇ 的闊度 */
const MARK_W = 13
/** 行與行之間：同一階段分行時、兩個階段之間（沒有／有匯流線） */
const SUB_GAP = 12
const STAGE_GAP = 18
const BUS_GAP = 30

type Unit = { id: string; group?: string; members: WorkflowNode[]; chains: string[][]; label: string }
export type FlowStructure = {
  units: Unit[]
  /** 每層的單位 id（已排序） */
  layers: string[][]
  /** 單位之間的依賴（去重）；back = 為了去環而反轉的線 */
  edges: { from: string; to: string; back: boolean }[]
}

const key = (a: string, b: string) => `${a}\u0000${b}`

/** 單位、分層、層內次序、單位之間的線（版面與終端機大綱共用）。只看未取消的步驟（提醒也畫）。 */
export function flowStructure(map: WorkflowMap): FlowStructure {
  const nodes = map.nodes.filter(n => n.status !== 'dropped')
  const ids = new Set(nodes.map(n => n.id))
  const depsOf = (n: WorkflowNode) => n.deps.filter(d => ids.has(d) && d !== n.id)
  const units: Unit[] = []
  const byUnit = new Map<string, Unit>()
  const unitOf = new Map<string, string>()
  for (const n of nodes) {
    const lane = n.lane?.trim()
    const id = lane ? `g:${lane}` : `n:${n.id}`
    let u = byUnit.get(id)
    if (!u) {
      u = { id, group: lane || undefined, members: [], chains: [], label: '' }
      byUnit.set(id, u)
      units.push(u)
    }
    u.members.push(n)
    unitOf.set(n.id, id)
  }
  for (const u of units) {
    const inU = new Set(u.members.map(m => m.id))
    const intra = (n: WorkflowNode) => depsOf(n).filter(d => inU.has(d))
    // 鏈：由組內沒有依賴的組員開始，沿「只等前一個」的組員接下去（開發 n → 測試 n）
    const used = new Set<string>()
    const heads = [...u.members.filter(m => intra(m).length === 0), ...u.members.filter(m => intra(m).length > 0)]
    for (const m of heads) {
      if (used.has(m.id)) continue
      const chain = [m.id]
      used.add(m.id)
      for (let cur = m.id; ; ) {
        const nx = u.members.find(x => !used.has(x.id) && intra(x).length === 1 && intra(x)[0] === cur)
        if (!nx) break
        chain.push(nx.id)
        used.add(nx.id)
        cur = nx.id
      }
      u.chains.push(chain)
    }
    u.label = [...new Set(u.members.map(m => m.edgeLabel?.trim() ?? '').filter(Boolean))].join(' · ')
  }
  // 單位之間的線（去重，按計劃次序）
  const seen = new Set<string>()
  const raw: { from: string; to: string }[] = []
  for (const n of nodes)
    for (const d of depsOf(n)) {
      const a = unitOf.get(d)!
      const b = unitOf.get(n.id)!
      if (a === b || seen.has(key(a, b))) continue
      seen.add(key(a, b))
      raw.push({ from: a, to: b })
    }
  // 去環：深度優先，指向「行緊」的單位的線 = 回頭線
  const succ = new Map(units.map(u => [u.id, [] as string[]]))
  for (const e of raw) succ.get(e.from)!.push(e.to)
  const state = new Map<string, 1 | 2>()
  const back = new Set<string>()
  const visit = (u: string) => {
    state.set(u, 1)
    for (const v of succ.get(u)!) {
      const s = state.get(v)
      if (s === 1) back.add(key(u, v))
      else if (s === undefined) visit(v)
    }
    state.set(u, 2)
  }
  for (const u of units) if (!state.has(u.id)) visit(u.id)
  const edges = raw.map(e => ({ ...e, back: back.has(key(e.from, e.to)) }))
  // 分層：最長路徑（只看順向的線）
  const preds = new Map(units.map(u => [u.id, [] as string[]]))
  const succs = new Map(units.map(u => [u.id, [] as string[]]))
  for (const e of edges)
    if (!e.back) {
      preds.get(e.to)!.push(e.from)
      succs.get(e.from)!.push(e.to)
    }
  const layerOf = new Map<string, number>()
  const lay = (u: string): number => {
    const k = layerOf.get(u)
    if (k !== undefined) return k
    layerOf.set(u, 0)
    const v = Math.max(-1, ...preds.get(u)!.map(lay)) + 1
    layerOf.set(u, v)
    return v
  }
  for (const u of units) lay(u.id)
  const layers: string[][] = Array.from({ length: Math.max(0, ...layerOf.values()) + (units.length ? 1 : 0) }, () => [])
  for (const u of units) layers[layerOf.get(u.id)!]!.push(u.id)
  // 層內次序：重心法，下 → 上 → 下 三次掃描（穩定排序）
  const pos = new Map<string, number>()
  const setPos = (l: string[]) => l.forEach((u, i) => pos.set(u, (i + 0.5) / l.length))
  layers.forEach(setPos)
  const sweep = (order: number[], nb: Map<string, string[]>) => {
    for (const i of order) {
      const l = layers[i]!
      const bc = new Map(l.map(u => [u, nb.get(u)!.length ? nb.get(u)!.reduce((s, x) => s + pos.get(x)!, 0) / nb.get(u)!.length : pos.get(u)!]))
      l.sort((a, b) => bc.get(a)! - bc.get(b)!)
      setPos(l)
    }
  }
  const down = layers.map((_, i) => i).slice(1)
  const up = layers.map((_, i) => i).reverse().slice(1)
  sweep(down, preds)
  sweep(up, succs)
  sweep(down, preds)
  return { units, layers, edges }
}

/** 流程圖上每一步在第幾個階段（它的組／單位所在的層 + 1），給改動標記的「3→4」用，與左邊的「階段 n」一致 */
export function diagramStages(map: WorkflowMap): Map<string, number> {
  const st = flowStructure(map)
  const out = new Map<string, number>()
  st.layers.forEach((l, i) => l.forEach(uid => st.units.find(u => u.id === uid)!.members.forEach(m => out.set(m.id, i + 1))))
  return out
}

/**
 * 組內排格：每行 cap 格；長的鏈先放、整條放同一行（不拆開），單格補進前面有空位的行（first-fit）。
 * 回傳每條鏈的行與起始欄（按行、欄排序）。
 */
export function packChains(chains: readonly (readonly string[])[], cap: number): { chain: number; row: number; col: number }[] {
  const order = chains.map((_, i) => i).sort((a, b) => chains[b]!.length - chains[a]!.length || a - b)
  const used: number[] = []
  const out: { chain: number; row: number; col: number }[] = []
  for (const i of order) {
    const len = chains[i]!.length
    let row = used.findIndex(u => u + len <= cap)
    if (row < 0) {
      row = used.length
      used.push(0)
    }
    out.push({ chain: i, row, col: used[row]! })
    used[row] = used[row]! + len
  }
  return out.sort((a, b) => a.row - b.row || a.col - b.col)
}

/** 單位已經不用等：全部組員完成、取消或是提醒 */
const unitDone = (u: Unit) => u.members.every(m => m.status === 'done' || !isStep(m))
const unitName = (u: Unit) => u.group ?? u.members[0]!.title

/**
 * 版面：width = 圖的闊度（px）。每個階段一行（放不下就分幾行，置中）；組的每行格數由最少開始，同一行放得下時把最高的組加闊
 * （最多每行 4 格）。匯流線只連相鄰兩行；其他依賴（跨階段、分行後不相鄰、向上）變成框內的「← 待 …」（只列未完成的）。
 * 「← 待」一行會改變框的大小、從而改變分行：重算到穩定為止（只會增加，最多 4 次）。
 */
export function layoutFlow(map: WorkflowMap, o: { width: number; lang: Lang }): FlowLayout {
  const t = STR[o.lang]
  const W = Math.max(200, Math.floor(o.width))
  const st = flowStructure(map)
  const byId = new Map(st.units.map(u => [u.id, u]))
  const layerOf = new Map<string, number>()
  st.layers.forEach((l, i) => l.forEach(u => layerOf.set(u, i)))
  const stageLabels = st.layers.map((_, i) => t.stage(i + 1, 1))
  const gut = st.layers.length ? Math.max(40, ...stageLabels.map(s => tw(s, 11) + 10)) : 0
  const left = MARGIN + gut
  const avail = W - left - MARGIN
  // 組內一條鏈最多幾格（放得下）；更長的鏈分段
  const cap0 = Math.max(1, Math.min(MAX_PER_ROW, Math.floor((avail - 2 * PAD + LINK_W) / (CW_MIN + LINK_W))))
  const chainsOf = new Map(st.units.map(u => [u.id, u.chains.flatMap(c => Array.from({ length: Math.ceil(c.length / cap0) }, (_, i) => c.slice(i * cap0, i * cap0 + cap0)))]))
  const lenOf = (id: string) => Math.max(1, ...chainsOf.get(id)!.map(c => c.length))
  const grouped = st.units.filter(u => u.group !== undefined)
  const wantCW = Math.min(CW_MAX, Math.max(CW_MIN, ...grouped.flatMap(u => u.members.filter(m => flowKind(m) !== 'note')).map(n => tw(n.title) + CHROME)))
  const maxLen = Math.max(1, ...grouped.map(u => lenOf(u.id)))
  const CW = Math.max(56, Math.min(wantCW, Math.floor((avail - 2 * PAD - (maxLen - 1) * LINK_W) / maxLen)))
  const pitchGap = (u: Unit) => (chainsOf.get(u.id)!.some(c => c.length > 1) ? LINK_W : COL_GAP)
  const headW = (u: Unit) => 2 * PAD + tw(u.group ?? '') + 8 + tw(t.flowCount(u.members.length), 11)
  // 單獨步驟的格寬：舊輪插入的留位給標題前的淡色 ◇（組內的格不為它加闊，標題截短）
  const singleW = (n: WorkflowNode) =>
    Math.min(avail, Math.max(flowKind(n) === 'note' ? 0 : CW, tw(n.title) + (flowKind(n) === 'note' ? 20 : CHROME) + (n.inserted ? MARK_W : 0)))
  const metaLines = (u: Unit, waits: string[]) => [waits.length ? waitsText(t, waits) : '', u.label ? t.flowVia(u.label) : ''].filter(Boolean)

  type Plan = { u: Unit; cap: number; waits: string[] }
  const size = (p: Plan) => {
    const meta = metaLines(p.u, p.waits)
    if (p.u.group === undefined) {
      const w = singleW(p.u.members[0]!)
      return { w: Math.max(w, Math.min(avail, Math.max(0, ...meta.map(m => tw(m, 11) + 4)))), h: NODE_H + meta.length * META_H }
    }
    const rows = Math.max(...packChains(chainsOf.get(p.u.id)!, p.cap).map(x => x.row)) + 1
    return {
      w: Math.max(2 * PAD + p.cap * CW + (p.cap - 1) * pitchGap(p.u), Math.min(avail, headW(p.u))),
      h: PAD + HEAD_H + meta.length * META_H + rows * NODE_H + (rows - 1) * ROW_GAP + PAD,
    }
  }
  const maxCap = (u: Unit) => Math.max(lenOf(u.id), Math.min(MAX_PER_ROW, chainsOf.get(u.id)!.reduce((s, c) => s + c.length, 0)))
  const rowsOfCap = (u: Unit, cap: number) => Math.max(...packChains(chainsOf.get(u.id)!, cap).map(x => x.row)) + 1
  /** 下一個會令行數減少的每行格數（例如一對 + 兩個單格：2 → 4，跳過不會減少行數的 3）；沒有 = 0 */
  const nextCap = (u: Unit, cap: number) => {
    for (let c = cap + 1; c <= maxCap(u); c++) if (rowsOfCap(u, c) < rowsOfCap(u, cap)) return c
    return 0
  }

  // 「← 待」：未完成的前置，而它與這個單位之間沒有匯流線（跨階段、向上、或分行後不相鄰）
  const forced = new Set<string>()
  const waitsOf = (u: Unit) =>
    st.edges
      .filter(e => e.to === u.id && (e.back || layerOf.get(e.to)! - layerOf.get(e.from)! !== 1 || forced.has(key(e.from, e.to))))
      .map(e => byId.get(e.from)!)
      .filter(p => !unitDone(p))
      .map(unitName)
  let rows: Plan[][] = []
  for (let pass = 0; pass < 4; pass++) {
    rows = []
    const rowW = (r: Plan[]) => r.reduce((s, p, i) => s + (i ? UNIT_GAP : 0) + size(p).w, 0)
    for (const l of st.layers) {
      let cur: Plan[] = []
      for (const id of l) {
        const u = byId.get(id)!
        const p: Plan = { u, cap: u.group === undefined ? 1 : lenOf(id), waits: waitsOf(u) }
        if (cur.length && rowW([...cur, p]) > avail) {
          rows.push(cur)
          cur = []
        }
        cur.push(p)
      }
      if (cur.length) rows.push(cur)
    }
    // 加闊：每次挑同一行最高、加闊後行數會減少的組，放得下就加
    for (const r of rows) {
      const stuck = new Set<Plan>()
      for (;;) {
        const cand = r.filter(p => p.u.group !== undefined && !stuck.has(p) && nextCap(p.u, p.cap)).sort((a, b) => size(b).h - size(a).h)[0]
        if (!cand) break
        const was = cand.cap
        cand.cap = nextCap(cand.u, was)
        if (rowW(r) > avail) {
          cand.cap = was
          stuck.add(cand)
        }
      }
    }
    // 相鄰兩階段之間、但分行後不在相鄰兩行的線：改為「← 待」，重算
    const rowOf = new Map<string, number>()
    rows.forEach((r, i) => r.forEach(p => rowOf.set(p.u.id, i)))
    const more = st.edges.filter(e => !e.back && layerOf.get(e.to)! - layerOf.get(e.from)! === 1 && rowOf.get(e.to)! !== rowOf.get(e.from)! + 1 && !forced.has(key(e.from, e.to)))
    if (!more.length) break
    for (const e of more) forced.add(key(e.from, e.to))
  }

  // ---- 位置 ----
  const cx = (u: Rect) => Math.round(u.x + u.w / 2)
  const units: FlowUnit[] = []
  const unit = new Map<string, FlowUnit>()
  const stages: FlowLayout['stages'] = []
  const buses: FlowBus[] = []
  const busEdges = (r: number) =>
    r + 1 < rows.length
      ? st.edges.filter(e => !e.back && rows[r]!.some(p => p.u.id === e.from) && rows[r + 1]!.some(p => p.u.id === e.to) && layerOf.get(e.to)! - layerOf.get(e.from)! === 1)
      : []
  let y = MARGIN
  rows.forEach((r, ri) => {
    const sizes = r.map(size)
    const total = sizes.reduce((s, z, i) => s + (i ? UNIT_GAP : 0) + z.w, 0)
    let x = left + Math.max(0, Math.floor((avail - total) / 2))
    const layer = layerOf.get(r[0]!.u.id)!
    if (!ri || layerOf.get(rows[ri - 1]![0]!.u.id)! !== layer) stages.push({ label: stageLabels[layer]!, y })
    r.forEach((p, i) => {
      const z = sizes[i]!
      const fu: FlowUnit = { id: p.u.id, group: p.u.group, members: p.u.members.map(m => m.id), cells: [], links: [], layer, row: ri, label: p.u.label, waits: p.waits, x, y, w: z.w, h: z.h }
      const meta = metaLines(p.u, p.waits).length
      if (p.u.group === undefined) {
        const cw = singleW(p.u.members[0]!)
        fu.cells.push({ id: fu.members[0]!, x: x + Math.round((z.w - cw) / 2), y, w: cw, h: NODE_H })
      } else {
        const g = pitchGap(p.u)
        const chains = chainsOf.get(p.u.id)!
        for (const slot of packChains(chains, p.cap)) {
          const cy = y + PAD + HEAD_H + meta * META_H + slot.row * (NODE_H + ROW_GAP)
          chains[slot.chain]!.forEach((id, j) => {
            const cxl = x + PAD + (slot.col + j) * (CW + g)
            fu.cells.push({ id, x: cxl, y: cy, w: CW, h: NODE_H })
            if (j) fu.links.push({ x1: cxl - g + 3, x2: cxl - 3, y: cy + NODE_H / 2 })
          })
        }
      }
      units.push(fu)
      unit.set(fu.id, fu)
      x += z.w + UNIT_GAP
    })
    const bottom = y + Math.max(...sizes.map(z => z.h))
    if (ri + 1 === rows.length) {
      y = bottom
      return
    }
    const sameStage = layerOf.get(rows[ri + 1]![0]!.u.id)! === layer
    const bus = busEdges(ri)
    if (bus.length) {
      const by = bottom + BUS_GAP / 2
      const ups = [...new Set(bus.map(e => e.from))].map(id => unit.get(id)!).map(u => ({ from: u.id, x: cx(u), y: u.y + u.h }))
      // 下一行的單位還未有位置：先記 id，下一行排好後補上
      buses.push({ y: by, x1: 0, x2: 0, ups, downs: [...new Set(bus.map(e => e.to))].map(to => ({ to, x: 0, y: 0 })) })
      y = bottom + BUS_GAP
    } else y = bottom + (sameStage ? SUB_GAP : STAGE_GAP)
  })
  for (const b of buses) {
    // 入口在框頂中間；上面的短線就在附近（≤ 12px）而且仍在框頂範圍內時對齊它，免得線上出現一個小拐彎
    b.downs = b.downs.map(d => {
      const u = unit.get(d.to)!
      const near = b.ups.map(p => p.x).find(x => Math.abs(x - cx(u)) <= 12 && x >= u.x + 14 && x <= u.x + u.w - 14)
      return { to: d.to, x: near ?? cx(u), y: u.y }
    })
    const xs = [...b.ups.map(u => u.x), ...b.downs.map(d => d.x)]
    b.x1 = Math.min(...xs)
    b.x2 = Math.max(...xs)
  }
  return { width: W, height: Math.max(1, y + MARGIN), cellW: CW, gut, stages, units, buses }
}

/** 「← 待 X、Y」 */
const waitsText = (t: (typeof STR)[Lang], names: readonly string[]) => `← ${t.waitShort(names.join(t.list))}`

/**
 * 畫成一張 SVG（圖片模式、透明底）。顏色跟其他介面：進行中 = 強調色、完成 = 綠、受阻 = 琥珀、未開始 = 中性；
 * 本輪插入／完成的插入步驟用紫色 ◇，舊輪插入未完成的標題前淡色 ◇。highlight = 要加紫色外框的步驟（插入的影響）。
 */
/** 流程圖上的改動標記（插入後）：+ 新增（綠框）、~ 改為等它（紫框）、移後的階段「3→4」、● 因此要等、已移除的（刪除線，畫在最底一行） */
export type FlowMarks = {
  added: ReadonlySet<string>
  rewired: ReadonlySet<string>
  moved: ReadonlyMap<string, string>
  blocked: ReadonlySet<string>
  removed: readonly string[]
}

export function flowSvg(map: WorkflowMap, lay: FlowLayout, lang: Lang, T: Theme, clk: Clock, highlight: ReadonlySet<string> = new Set(), marks?: FlowMarks): Pic {
  const t = STR[lang]
  const ready = readyIds(map.nodes)
  const byId = new Map(map.nodes.map(n => [n.id, n]))
  const unitById = new Map(lay.units.map(u => [u.id, u]))
  const hot = (uid: string) => (unitById.get(uid)?.members ?? []).some(id => byId.get(id)?.status === 'doing')
  const noteUnit = (uid: string) => {
    const u = unitById.get(uid)
    return !!u && u.group === undefined && flowKind(byId.get(u.members[0]!)!) === 'note'
  }
  const ink = (op: number) => `fill='${T.ink}' fill-opacity='${op}'`
  const out: string[] = []
  for (const s of lay.stages) out.push(text(MARGIN, s.y + 18, fit(s.label, 11, lay.gut - 8), 'm'))
  // 匯流線：一條橫線 + 上面落下的短豎線 + 進入下一行框頂的短箭咀（進行中的目標用強調色；提醒用點線、沒有箭咀）
  for (const b of lay.buses) {
    const any = b.downs.some(d => hot(d.to))
    const col = any ? T.run : T.wire
    if (b.x2 > b.x1) out.push(`<path d='M${b.x1},${b.y} H${b.x2}' fill='none' stroke='${col}' stroke-width='1.5'/>`)
    for (const u of b.ups) out.push(`<path d='M${u.x},${u.y} V${b.y}' fill='none' stroke='${col}' stroke-width='1.5'/>`)
    for (const d of b.downs) {
      if (noteUnit(d.to)) {
        out.push(`<path d='M${d.x},${b.y} V${d.y}' fill='none' stroke='${T.wire}' stroke-width='1.5' stroke-dasharray='2 3'/>`)
        continue
      }
      const c = hot(d.to) ? T.run : T.wire
      out.push(`<path d='M${d.x},${b.y} V${d.y - ARROW + 1}' fill='none' stroke='${c}' stroke-width='1.5'/>`, `<path d='M${d.x - 4},${d.y - ARROW} L${d.x + 4},${d.y - ARROW} L${d.x},${d.y} Z' fill='${c}'/>`)
    }
  }
  for (const u of lay.units) {
    const meta = [u.waits.length ? waitsText(t, u.waits) : '', u.label ? t.flowVia(u.label) : ''].filter(Boolean)
    if (u.group !== undefined) {
      out.push(`<rect x='${u.x}' y='${u.y}' width='${u.w}' height='${u.h}' rx='8' ${ink(0.04)}/>`)
      const count = t.flowCount(u.members.length)
      const title = fit(u.group, 12, u.w - 2 * PAD - 8 - tw(count, 11))
      out.push(text(u.x + PAD, u.y + PAD + 11, title, 'b', { fixed: true }), text(u.x + PAD + tw(title) + 8, u.y + PAD + 11, count, 'm', { fixed: true }))
      meta.forEach((m, i) => out.push(text(u.x + PAD, u.y + PAD + 11 + (i + 1) * META_H, fit(m, 11, u.w - 2 * PAD), 'm')))
    } else
      meta.forEach((m, i) => {
        const s = fit(m, 11, u.w)
        out.push(text(u.x + Math.round((u.w - tw(s, 11)) / 2), u.y + NODE_H + 12 + i * META_H, s, 'm', { fixed: true }))
      })
    for (const l of u.links)
      out.push(
        `<path d='M${l.x1},${l.y} H${l.x2 - 4}' fill='none' stroke='${T.wire}' stroke-width='1.5'/>`,
        `<path d='M${l.x2 - 5},${l.y - 3.5} L${l.x2},${l.y} L${l.x2 - 5},${l.y + 3.5} Z' fill='${T.wire}'/>`,
      )
    for (const c of u.cells) {
      const n = byId.get(c.id)
      if (!n) continue
      const cy = c.y + c.h / 2
      const fk = flowKind(n)
      if (fk === 'note') {
        out.push(
          `<rect x='${c.x + 0.75}' y='${c.y + 0.75}' width='${c.w - 1.5}' height='${c.h - 1.5}' rx='6' fill='${T.block}' fill-opacity='.08' stroke='${T.block}' stroke-opacity='.8' stroke-width='1.5'/>`,
          text(c.x + 10, cy + 4, fit(n.title, 12, c.w - 20)),
        )
        continue
      }
      const k = kindOf(n, ready, clk)
      const tint = k === 'done' ? `fill='${T.done}' fill-opacity='.16'` : k === 'doing' ? `fill='${T.run}' fill-opacity='.16'` : k === 'blocked' || k === 'stale' ? `fill='${T.block}' fill-opacity='.14'` : ink(0.07)
      out.push(
        fk === 'decision'
          ? `<rect x='${c.x + 0.75}' y='${c.y + 0.75}' width='${c.w - 1.5}' height='${c.h - 1.5}' rx='6' ${tint} stroke='${T.ink}' stroke-opacity='.5' stroke-width='1.5' stroke-dasharray='4 3'/>`
          : `<rect x='${c.x}' y='${c.y}' width='${c.w}' height='${c.h}' rx='6' ${tint}/>`,
        icon(k, insHot(n, clk), c.x + 11, cy, T, insFresh(n, clk)),
      )
      // 舊輪插入、仍未完成：標題前一個淡色 ◇
      const mark = insMark(n, clk) ? MARK_W : 0
      if (mark) out.push(text(c.x + 24, cy + 4, '◇', 'm'))
      out.push(text(c.x + 24 + mark, cy + 4, fit(n.title, 12, c.w - CHROME - mark), k === 'todo' ? 'd' : ''))
      if (highlight.has(c.id)) out.push(`<rect x='${c.x - 2}' y='${c.y - 2}' width='${c.w + 4}' height='${c.h + 4}' rx='8' fill='none' stroke='${T.ins}' stroke-width='1.5'/>`)
      if (marks) out.push(markCell(c, marks, T))
    }
  }
  // 已移除的步驟：最底一行，虛線框 + 刪除線
  let height = lay.height
  if (marks?.removed.length) {
    const label = STR[lang].removedTitle
    let x = lay.gut
    let y = lay.height + 8
    out.push(text(MARGIN, y + 16, fit(label, 11, lay.gut - 8), 'm'))
    for (const title of marks.removed) {
      const s = fit(title, 12, lay.width - lay.gut - 24)
      const w = tw(s) + 20
      if (x > lay.gut && x + w > lay.width - MARGIN) {
        x = lay.gut
        y += 30
      }
      out.push(
        `<rect x='${x + 0.5}' y='${y + 0.5}' width='${w - 1}' height='23' rx='6' fill='none' stroke='${T.ink}' stroke-opacity='.35' stroke-dasharray='3 2'/>`,
        text(x + 10, y + 16, s, 'd', { fixed: true }),
        `<path d='M${x + 8},${y + 12} H${x + w - 8}' stroke='${T.dim}' stroke-width='1'/>`,
      )
      x += w + 8
    }
    height = y + 24 + MARGIN
  }
  return doc(lay.width, height, T, out.join(''))
}

/** 一格的改動標記：外框（新增 = 綠、改為等它 = 紫）＋ 右上角的小記號（+、~、3→4、●），由右向左排 */
function markCell(c: FlowCell, m: FlowMarks, T: Theme): string {
  const out: string[] = []
  const ring = m.added.has(c.id) ? T.done : m.rewired.has(c.id) ? T.ins : ''
  if (ring) out.push(`<rect x='${c.x - 2}' y='${c.y - 2}' width='${c.w + 4}' height='${c.h + 4}' rx='8' fill='none' stroke='${ring}' stroke-width='1.5'/>`)
  let right = c.x + c.w + 2
  const top = c.y - 2
  const chip = (w: number, body: (x: number) => string) => {
    out.push(body(right - w))
    right -= w + 3
  }
  if (m.added.has(c.id))
    chip(14, x => `<circle cx='${x + 7}' cy='${top}' r='7' fill='${T.done}'/><path d='M${x + 4},${top} H${x + 10} M${x + 7},${top - 3} V${top + 3}' stroke='#ffffff' stroke-width='1.6' stroke-linecap='round'/>`)
  if (m.rewired.has(c.id)) chip(14, x => `<circle cx='${x + 7}' cy='${top}' r='7' fill='${T.ins}'/><text x='${x + 7}' y='${top + 4}' text-anchor='middle' style='font-size:11px;fill:#ffffff;font-weight:600'>~</text>`)
  const mv = m.moved.get(c.id)
  if (mv) {
    const w = tw(mv, 10) + 10
    chip(w, x => `<rect x='${x}' y='${top - 7}' width='${w}' height='14' rx='7' fill='${T.block}'/><text x='${x + w / 2}' y='${top + 3.5}' text-anchor='middle' style='font-size:10px;fill:#1f1f1f;font-weight:600'>${mv}</text>`)
  }
  if (m.blocked.has(c.id)) chip(8, x => `<circle cx='${x + 4}' cy='${top}' r='4' fill='${T.block}'/>`)
  return out.join('')
}

/** 一行字段截到 cols 格以內（最後一段加「…」） */
function fitSegs(segs: readonly Seg[], cols: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const s of segs) {
    const w = cells(s.text)
    if (used + w <= cols) {
      out.push(s)
      used += w
      continue
    }
    const cut = fitCells(s.text, cols - used)
    if (cut) out.push({ ...s, text: cut })
    break
  }
  return out
}

/**
 * 終端機版：按層、按組的縮排大綱（不畫圖）。層與層之間一行「↓」；組 = 粗體組名 · 數目（← 標籤），
 * 組員一條鏈一行「◉ 開發 1 → ○ 測試 1」；提醒用琥珀色「※」。每行截到 cols 格，不換行。
 */
export function flowOutline(map: WorkflowMap, lang: Lang, cols: number, clk: Clock): Seg[][] {
  const t = STR[lang]
  const st = flowStructure(map)
  const ready = readyIds(map.nodes)
  const unitById = new Map(st.units.map(u => [u.id, u]))
  const byId = new Map(map.nodes.map(n => [n.id, n]))
  const step = (id: string): Seg[] => {
    const n = byId.get(id)!
    if (flowKind(n) === 'note') return [{ text: '※ ', color: 'warning' }, { text: n.title, color: 'warning' }]
    const k = kindOf(n, ready, clk)
    return [glyph(k, insHot(n, clk)), { text: ' ' }, ...(insMark(n, clk) ? [{ text: '◇ ', dim: true }] : []), { text: n.title, dim: k === 'todo' }]
  }
  const label = (u: Unit): Seg[] => (u.label ? [{ text: `  ← ${u.label}`, dim: true }] : [])
  const lines: Seg[][] = []
  st.layers.forEach((l, i) => {
    if (i) lines.push([{ text: '  ↓', dim: true }])
    for (const id of l) {
      const u = unitById.get(id)!
      if (u.group === undefined) {
        lines.push([...step(u.members[0]!.id), ...label(u)])
        continue
      }
      lines.push([{ text: u.group, bold: true }, { text: ` · ${t.flowCount(u.members.length)}`, dim: true }, ...label(u)])
      for (const chain of u.chains) lines.push([{ text: '    ' }, ...chain.flatMap((cid, j) => [...(j ? [{ text: ' → ', dim: true }] : []), ...step(cid)])])
    }
  })
  return lines.map(l => fitSegs(l, cols))
}

/** 給替代文字：大綱的純文字 */
export const outlineText = (lines: readonly Seg[][]) => lines.map(l => l.map(s => s.text).join('')).join('\n')
