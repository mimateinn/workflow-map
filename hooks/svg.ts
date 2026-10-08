// 膠囊畫法：步驟是線上的膠囊（字在膠囊內）；收起 = 一行膠囊；展開 = 地鐵線 + 膠囊站。
// 透明底。types 沒有主題 API（Svg 以圖片繪製，讀不到 app 主題），所以膠囊一律用「不透明的中深色底 + 淺色字」：
// 字與膠囊底的對比 ≥ 4.5:1，與背後是深色還是淺色主題無關。線用中間調，兩種背景都看得見。
// 介面記號全部是圖形（✓、插入圓點），不用任何語言的文字當記號。
import type { WorkflowMap, WorkflowNode } from '../types/index'
import { allDone, columns, readyIds, stats } from './graph'
import { STR } from './i18n'
import type { Lang } from './i18n'

/** 色板（README 技術說明有同一份，供其他 mod 抄用）。字色對膠囊底的對比都 ≥ 4.5:1。 */
export const PALETTE = {
  accent: '#d97757', // 線（已走過）、光暈
  done: { fill: '#5c4037', text: '#fbe4da' },
  doing: { fill: '#b5532f', text: '#ffffff' },
  todo: { fill: '#3f3f46', text: '#f4f4f5' },
  ready: { fill: '#3f3f46', text: '#ffffff', stroke: '#d97757' },
  blocked: { fill: '#a3282c', text: '#ffffff' },
  dropped: { fill: '#52525b', text: '#d4d4d8' },
  ins: { fill: '#5b3fa8', text: '#ffffff', mark: '#8b5cf6' },
  warn: { fill: '#8a5a00', text: '#ffffff', dot: '#f5a524' },
  track: 'rgba(128,128,128,.35)',
  lineTodo: 'rgba(128,128,128,.55)',
} as const

const P = PALETTE
const CSS =
  '<style>' +
  'rect{stroke-width:1}' +
  `.f-done{fill:${P.done.fill};stroke:none}.t-done{fill:${P.done.text}}` +
  `.f-doing{fill:${P.doing.fill};stroke:${P.doing.fill}}.t-doing{fill:${P.doing.text};font-weight:600}` +
  `.r-doing{fill:none;stroke:${P.accent}}` +
  `.f-todo{fill:${P.todo.fill};stroke:none}.t-todo{fill:${P.todo.text}}` +
  `.f-ready{fill:${P.ready.fill};stroke:${P.ready.stroke};stroke-width:1.5}.t-ready{fill:${P.ready.text}}` +
  `.f-blocked{fill:${P.blocked.fill};stroke:none}.t-blocked{fill:${P.blocked.text}}` +
  `.f-dropped{fill:${P.dropped.fill};stroke:none}.t-dropped{fill:${P.dropped.text};text-decoration:line-through}` +
  `.f-ins{fill:${P.ins.fill};stroke:none}.t-ins{fill:${P.ins.text}}` +
  `.f-warn{fill:${P.warn.fill};stroke:none}.t-warn{fill:${P.warn.text}}` +
  `.f-prog{fill:${P.doing.fill}}.f-progbg{fill:${P.todo.fill}}.t-prog{fill:#ffffff;font-weight:600}` +
  `.f-track{fill:${P.track}}.ln-done{stroke:${P.accent}}.ln-todo{stroke:${P.lineTodo}}` +
  // 圖示（✓、→、!）用線條畫，顏色同該膠囊的字
  (['done', 'doing', 'todo', 'ready', 'blocked', 'dropped', 'ins', 'warn'] as const).map(k => `.s-${k}{stroke:${P[k].text};fill:none}`).join('') +
  '.s-prog{stroke:#ffffff;fill:none}' +
  '</style>'
const FONT = `font-family="system-ui, 'Segoe UI', 'Microsoft JhengHei', 'PingFang TC', 'Noto Sans TC', sans-serif"`

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const isWide = (ch: string) => /[⺀-￿]/.test(ch)

/** 按顯示闊度截字：CJK 算 2，其他算 1。 */
export function clip(s: string, units: number): string {
  let w = 0
  let out = ''
  for (const ch of s) {
    w += isWide(ch) ? 2 : 1
    if (w > units) return `${out}…`
    out += ch
  }
  return out
}

/** 估算文字闊度（px）：CJK ≈ 1em，其他 ≈ 0.6em。 */
const textW = (s: string, font: number) => [...s].reduce((w, ch) => w + (isWide(ch) ? font : font * 0.6), 0)

export type Kind = 'done' | 'doing' | 'todo' | 'ready' | 'blocked' | 'dropped' | 'ins' | 'warn' | 'prog'
/** progress：0–1，膠囊內由左至右填色（進度條膠囊）；check／next／alert／ins：前面畫對應圖示（全部用 SVG 線條畫，不用文字符號） */
export type Cap = { text: string; kind: Kind; title: string; check?: boolean; ins?: boolean; next?: boolean; alert?: boolean; progress?: number; dot?: boolean }
type Geo = { h: number; font: number }

const markW = (g: Geo) => g.font * 1.15
const iconW = (g: Geo) => g.font * 1.05
const capW = (c: Cap, g: Geo) =>
  Math.round(g.h * 0.9 + textW(c.text, g.font) + [c.check, c.next, c.alert].filter(Boolean).length * iconW(g) + (c.ins ? markW(g) : 0))

/** 「有新要求未記入」的琥珀色小圓點，慢慢呼吸；與語言無關。 */
function amberDot(cx: number, cy: number, r: number): string {
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r + 2.5}" fill="${P.warn.dot}" opacity="0.35">` +
    '<animate attributeName="opacity" values="0.45;0;0.45" dur="1.8s" repeatCount="indefinite"/></circle>' +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${P.warn.dot}" stroke="rgba(0,0,0,.35)" stroke-width="1"/>`
  )
}

/** 獨立的琥珀色小圓點（展開時放在右邊按鈕旁、全圖面板標題旁）。 */
export function pendingDot(): SvgResult {
  return { source: svgDoc(14, 14, amberDot(7, 7, 3.5)), width: 14, height: 14, hidden: 0 }
}

/** 插入記號：紫色圓點內一個「+」（與語言無關）。 */
function insMark(cx: number, cy: number, r: number): string {
  const a = r * 0.55
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${P.ins.mark}" stroke="#ffffff" stroke-width="1"/>` +
    `<path d="M${cx - a},${cy} H${cx + a} M${cx},${cy - a} V${cy + a}" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round"/>`
  )
}

/** 線條圖示，左邊 x、垂直中心 cy、大小 sz（≈ 字高）。 */
function icon(kind: 'check' | 'next' | 'alert', cls: string, x: number, cy: number, sz: number): string {
  const a = `class="${cls}" stroke-width="${(sz * 0.17).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"`
  const f = (n: number) => n.toFixed(1)
  if (kind === 'check') return `<path ${a} d="M${f(x)},${f(cy)} L${f(x + sz * 0.36)},${f(cy + sz * 0.34)} L${f(x + sz)},${f(cy - sz * 0.36)}"/>`
  if (kind === 'next')
    return `<path ${a} d="M${f(x)},${f(cy)} H${f(x + sz)} M${f(x + sz * 0.56)},${f(cy - sz * 0.42)} L${f(x + sz)},${f(cy)} L${f(x + sz * 0.56)},${f(cy + sz * 0.42)}"/>`
  return `<path ${a} d="M${f(x + sz * 0.5)},${f(cy - sz * 0.48)} V${f(cy + sz * 0.12)} M${f(x + sz * 0.5)},${f(cy + sz * 0.44)} V${f(cy + sz * 0.45)}"/>`
}

/** 一粒膠囊：左上角 (x, y)，高 g.h，半徑 = 高 / 2；全名放在 <title>。 */
function capsule(c: Cap, x: number, y: number, g: Geo): string {
  const w = capW(c, g)
  const r = g.h / 2
  const base = y + r + g.font * 0.36
  let tx = x + g.h * 0.45
  const box = `x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${g.h - 1}" rx="${r - 0.5}"`
  const out = [`<g><title>${esc(c.title)}</title>`]
  if (c.kind === 'doing') {
    // 「現在在這裏」：外圈慢慢呼吸的光暈（SMIL；不支援動畫時仍是一圈框）
    out.push(
      `<rect class="r-doing" x="${x - 2}" y="${y - 2}" width="${w + 4}" height="${g.h + 4}" rx="${r + 2}" stroke-width="2" opacity="0.5">` +
        '<animate attributeName="opacity" values="0.6;0.1;0.6" dur="2.2s" repeatCount="indefinite"/></rect>',
    )
  }
  if (c.progress !== undefined) {
    const id = `pc${Math.round(x)}_${Math.round(y)}`
    out.push(`<clipPath id="${id}"><rect ${box}/></clipPath>`)
    out.push(`<rect class="f-progbg" ${box}/>`)
    out.push(`<rect class="f-prog" x="${x}" y="${y}" width="${(w * Math.min(1, Math.max(0, c.progress))).toFixed(1)}" height="${g.h}" clip-path="url(#${id})"/>`)
  } else {
    out.push(`<rect class="f-${c.kind}" ${box}/>`)
  }
  const sz = g.font * 0.72
  for (const k of ['check', 'next', 'alert'] as const) {
    if (!c[k]) continue
    out.push(icon(k, `s-${c.kind}`, tx, y + r, sz))
    tx += iconW(g)
  }
  if (c.ins) {
    const mr = g.font * 0.42
    out.push(insMark(tx + mr, y + r, mr))
    tx += markW(g)
  }
  out.push(`<text class="t-${c.kind}" x="${tx}" y="${base}" font-size="${g.font}">${esc(c.text)}</text>`)
  if (c.dot) out.push(amberDot(x + w - 3, y + 3, 3.5))
  out.push('</g>')
  return out.join('')
}

/** 步驟 → 膠囊。插入的步驟用紫色（進行中／已完成則保留其狀態色，只加插入記號）。 */
export function nodeCap(n: WorkflowNode, isReady: boolean, lang: Lang, units = 16): Cap {
  const t = STR[lang]
  const kind: Kind =
    n.inserted && n.status !== 'doing' && n.status !== 'done' ? 'ins' : n.status === 'todo' && isReady ? 'ready' : n.status
  const title = [`${n.title} — ${isReady ? t.ready : t.status[n.status]}`, n.inserted ? t.inserted(n.inserted.note) : '', n.note ?? '']
    .filter(Boolean)
    .join('\n')
  return { text: clip(n.title, units), kind, title, check: n.status === 'done', ins: !!n.inserted }
}

const svgDoc = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT}>${CSS}${body}</svg>`

export type SvgResult = { source: string; width: number; height: number; hidden: number }

/** 一行膠囊；放不下的不畫，數目回傳為 hidden（由介面畫一個可按的「+N」按鈕開全圖）。 */
export function capsRow(caps: Cap[], maxWidth: number, g: Geo = { h: 20, font: 11.5 }): SvgResult {
  const gap = 16
  const parts: string[] = []
  let x = 2 // 留 2px 給進行中膠囊的光暈
  let shown = 0
  for (const c of caps) {
    if (x + capW(c, g) > maxWidth - 2) break
    parts.push(capsule(c, x, 2, g))
    x += capW(c, g) + gap
    shown++
  }
  const width = Math.max(1, Math.round(x - gap + 2))
  return { source: svgDoc(width, g.h + 4, parts.join('')), width, height: g.h + 4, hidden: caps.length - shown }
}

// ---------------- 收起：一行膠囊 ----------------

/** [進度 5/10，膠囊內填色] → 每個進行中 → [→ 下一步] → [插入記號 N]（→ [未記錄]） */
export function summaryCaps(map: WorkflowMap, pending: boolean, lang: Lang): Cap[] {
  const t = STR[lang]
  const s = stats(map)
  const ready = readyIds(map.nodes)
  if (allDone(map)) return [{ text: `${s.done}/${s.total}`, kind: 'done', check: true, title: t.allDone }]
  const caps: Cap[] = [
    {
      text: `${s.done}/${s.total}`,
      kind: 'prog',
      progress: s.total ? s.done / s.total : 0,
      title: pending ? `${t.progressTip(s.done, s.total)}\n${t.unloggedTip}` : t.progressTip(s.done, s.total),
      dot: pending,
    },
  ]
  for (const n of map.nodes.filter(n => n.status === 'doing')) caps.push(nodeCap(n, false, lang, 14))
  for (const n of map.nodes.filter(n => n.status === 'blocked')) caps.push(nodeCap(n, false, lang, 14))
  const next = columns(map.nodes).flat().find(n => ready.has(n.id))
  if (next) caps.push({ ...nodeCap(next, true, lang, 12), kind: 'ready', next: true, ins: false })
  if (s.inserted) {
    const tip = map.nodes.filter(n => n.inserted).map(n => t.inserted(n.inserted!.note)).join('\n')
    caps.push({ text: String(s.inserted), kind: 'ins', ins: true, title: tip })
  }
  return caps
}

/** 終端機版：[✓3/10] [▶改介面] → [發佈] · [+2] */
export function summaryText(map: WorkflowMap, pending: boolean, lang: Lang): string {
  return summaryCaps(map, pending, lang)
    .map(c => {
      if (c.kind === 'doing') return `[▶${c.text}]`
      if (c.next) return `→ [${c.text}]`
      if (c.kind === 'ins') return `· [+${c.text}]`
      if (c.alert) return `[! ${c.text}]`
      return `[${c.check || c.kind === 'prog' ? '✓' : ''}${c.text}]`
    })
    .join(' ')
}

// ---------------- 展開：地鐵線 + 膠囊 ----------------

/**
 * 分線：步驟盡量沿依賴那條線延續；分叉開新線；某條線的末端已無待畫的後續、且空出一欄以上，才可再用。
 * 無依賴但有後續的步驟（例如中途插入的獨立工作）放在後續的前一欄，避免一條長線橫跨全圖。
 */
export function lanes(map: WorkflowMap): Map<string, { col: number; lane: number }> {
  const depthCols = columns(map.nodes)
  const col = new Map<string, number>()
  depthCols.forEach((c, i) => c.forEach(n => col.set(n.id, i)))
  const succ = new Map<string, string[]>()
  for (const n of map.nodes) for (const d of n.deps) if (col.has(d)) succ.set(d, [...(succ.get(d) ?? []), n.id])
  for (const n of map.nodes) {
    const next = succ.get(n.id)
    if (n.deps.length === 0 && next) col.set(n.id, Math.max(0, Math.min(...next.map(s => col.get(s) ?? 0)) - 1))
  }
  const order = map.nodes.map((n, i) => ({ n, i })).sort((a, b) => col.get(a.n.id)! - col.get(b.n.id)! || a.i - b.i)

  const out = new Map<string, { col: number; lane: number }>()
  const tails: { id: string; col: number }[] = []
  const open = (id: string) => (succ.get(id) ?? []).some(s => !out.has(s))
  for (const { n } of order) {
    const ci = col.get(n.id)!
    let pick = -1
    for (const d of n.deps) {
      const l = out.get(d)?.lane
      if (l !== undefined && tails[l]?.id === d && (pick < 0 || l < pick)) pick = l
    }
    if (pick < 0) pick = tails.findIndex(t => t.col < ci - 1 && !open(t.id))
    if (pick < 0) pick = tails.length
    out.set(n.id, { col: ci, lane: pick })
    tails[pick] = { id: n.id, col: ci }
  }
  return out
}

export type MetroOptions = {
  /** 最多顯示幾條線 */
  lanes: number
  /** 圖的最大闊度（px）；放不下的欄不畫，數目回傳為 hidden */
  maxWidth: number
  /** true = 輸入框上方的精簡版（膠囊高 20、線距 28）；false = 全圖面板 */
  compact: boolean
  lang: Lang
  /** true = 放不下的欄換到下一段（全圖面板用，保證畫出全部步驟）；false = 收起為 hidden */
  wrap?: boolean
}

export function metroSvg(map: WorkflowMap, o: MetroOptions): SvgResult {
  const g = o.compact ? { h: 20, font: 11.5, pitch: 28, gap: 30, pad: 4, units: 16, s: 9 } : { h: 26, font: 13, pitch: 34, gap: 36, pad: 4, units: 60, s: 12 }
  const geo = { h: g.h, font: g.font }
  const ready = readyIds(map.nodes)
  const live = map.nodes.filter(n => !(o.compact && n.status === 'dropped'))
  const pos = lanes({ ...map, nodes: live })
  const byIdLive = new Map(live.map(n => [n.id, n]))

  // 線太多時：保留主線（第 0 條）和有「進行中」步驟的線
  const laneOf = (id: string) => pos.get(id)?.lane ?? 0
  const hasDoing = (l: number) => live.some(n => laneOf(n.id) === l && n.status === 'doing')
  const used = [...new Set([...pos.values()].map(p => p.lane))].sort((a, b) => a - b)
  const shownLanes = used
    .slice()
    .sort((a, b) => Number(b === 0) - Number(a === 0) || Number(hasDoing(b)) - Number(hasDoing(a)) || a - b)
    .slice(0, o.lanes)
    .sort((a, b) => a - b)
  const row = new Map(shownLanes.map((l, i) => [l, i]))

  // 每欄闊度 = 該欄最闊的膠囊 + 欄距，平行線上的膠囊不會撞
  const caps = new Map(live.map(n => [n.id, nodeCap(n, ready.has(n.id), o.lang, g.units)]))
  const colW: number[] = []
  for (const n of live) {
    const p = pos.get(n.id)!
    if (row.has(p.lane)) colW[p.col] = Math.max(colW[p.col] ?? 0, capW(caps.get(n.id)!, geo))
  }
  // 欄位置；wrap 時放不下的欄換到下一段（像文字換行）。續段左邊縮入，畫一個「↳」表示接上一段。
  const INDENT = 20
  const colX: number[] = []
  const colSeg: number[] = []
  let x = 3 // 留位給進行中膠囊的光暈
  let seg = 0
  let lastCol = -1
  for (let c = 0; c < colW.length; c++) {
    const w = colW[c] ?? 0
    if (x + w > o.maxWidth - 3) {
      if (!o.wrap) break
      if (x > (seg ? 3 + INDENT : 3)) {
        seg++
        x = 3 + INDENT
      }
    }
    colX[c] = x
    colSeg[c] = seg
    lastCol = c
    x += w + g.gap
  }

  // 每段的行：第一段照線的次序壓緊；續段按「線的次序」排在最上面，且子步驟不會高過同段內的父步驟。
  const rowOf = new Map<string, number>()
  const segRowsUsed: number[] = []
  const inSeg = (n: WorkflowNode) => {
    const p = pos.get(n.id)!
    return row.has(p.lane) && p.col <= lastCol ? colSeg[p.col]! : -1
  }
  for (let s = 0; s <= seg; s++) {
    const nodes = live.filter(n => inSeg(n) === s).sort((a, b) => pos.get(a.id)!.col - pos.get(b.id)!.col || row.get(pos.get(a.id)!.lane)! - row.get(pos.get(b.id)!.lane)!)
    const lanesHere = [...new Set(nodes.map(n => row.get(pos.get(n.id)!.lane)!))].sort((a, b) => a - b)
    const taken = new Set<string>()
    for (const n of nodes) {
      const c = pos.get(n.id)!.col
      let r = lanesHere.indexOf(row.get(pos.get(n.id)!.lane)!)
      if (s > 0) for (const d of n.deps) if (rowOf.has(d) && inSeg(byIdLive.get(d)!) === s) r = Math.max(r, rowOf.get(d)!)
      while (taken.has(`${c}:${r}`)) r++
      taken.add(`${c}:${r}`)
      rowOf.set(n.id, r)
      segRowsUsed[s] = Math.max(segRowsUsed[s] ?? 0, r + 1)
    }
  }
  const segGap = 10
  const segH = (s: number) => g.pad * 2 + Math.max(0, (segRowsUsed[s] ?? 1) - 1) * g.pitch + g.h
  const segY: number[] = [0]
  for (let s = 1; s <= seg; s++) segY[s] = segY[s - 1]! + segH(s - 1) + segGap

  type Placed = { n: WorkflowNode; x: number; y: number; w: number; cap: Cap; seg: number }
  const placed = new Map<string, Placed>()
  for (const n of live) {
    const s = inSeg(n)
    if (s < 0) continue
    const p = pos.get(n.id)!
    const cap = caps.get(n.id)!
    placed.set(n.id, { n, x: colX[p.col]!, y: segY[s]! + g.pad + rowOf.get(n.id)! * g.pitch, w: capW(cap, geo), cap, seg: s })
  }
  const hidden = live.length - placed.size
  const all = [...placed.values()]
  const width = Math.ceil(Math.max(1, ...all.map(p => p.x + p.w)) + 4)
  const height = segY[seg]! + segH(seg)
  // 續段的「↳」（SVG 線條，淡色）
  const cont: string[] = []
  for (let s = 1; s <= seg; s++) {
    const cy = segY[s]! + g.pad + g.h / 2
    cont.push(
      `<path d="M5,${cy - 9} V${cy} H${3 + INDENT - 6} M${3 + INDENT - 10},${cy - 4} L${3 + INDENT - 6},${cy} L${3 + INDENT - 10},${cy + 4}" ` +
        `stroke="${P.lineTodo}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
  }

  const lines: string[] = []
  const mid = g.h / 2
  for (const to of all) {
    for (const d of to.n.deps) {
      const from = placed.get(d)
      if (!from) continue
      const cls =
        to.n.status === 'done' || to.n.status === 'doing'
          ? 'class="ln-done" stroke-width="2"'
          : 'class="ln-todo" stroke-width="1.5" stroke-dasharray="3 3"'
      const x1 = from.x + from.w
      const y1 = from.y + mid
      const y2 = to.y + mid
      if (from.seg !== to.seg) {
        // 跨段不畫線（不留懸空的斷線）；段與段由上而下閱讀，先後關係由清單補充
        continue
      } else if (y1 === y2) {
        lines.push(`<line x1="${x1}" y1="${y1}" x2="${to.x}" y2="${y2}" ${cls}/>`)
      } else {
        const xm = to.x - g.gap / 2
        lines.push(`<path d="M${x1},${y1} H${xm - g.s} C${xm},${y1} ${xm},${y2} ${xm + g.s},${y2} H${to.x}" fill="none" ${cls}/>`)
      }
    }
  }
  const body = cont.join('') + lines.join('') + all.map(p => capsule(p.cap, p.x, p.y, geo)).join('')
  return { source: svgDoc(width, height, body), width, height, hidden }
}

/** 全圖面板的圖例：一行膠囊（狀態名稱按語言）。 */
export function legendSvg(lang: Lang): SvgResult {
  const t = STR[lang]
  const caps: Cap[] = [
    { text: t.status.done, kind: 'done', check: true, title: t.status.done },
    { text: t.status.doing, kind: 'doing', title: t.status.doing },
    { text: t.ready, kind: 'ready', next: true, title: t.ready },
    { text: t.status.todo, kind: 'todo', title: t.status.todo },
    { text: t.status.blocked, kind: 'blocked', title: t.status.blocked },
    { text: t.insertCount, kind: 'ins', ins: true, title: t.insertCount },
  ]
  return capsRow(caps, 4000, { h: 20, font: 11 })
}

/** 全圖面板頂部的整體進度細條（數字由介面的 Text 顯示，跟主題配色）。 */
export function progressSvg(map: WorkflowMap, width = 420): SvgResult {
  const s = stats(map)
  const ratio = s.total ? s.done / s.total : 0
  const source = svgDoc(
    width,
    10,
    `<rect class="f-track" x="0" y="2" width="${width}" height="6" rx="3"/>` +
      `<rect class="f-prog" x="0" y="2" width="${(width * ratio).toFixed(1)}" height="6" rx="3"/>`,
  )
  return { source, width, height: 10, hidden: 0 }
}

/** 清單用的狀態小圖示（16×16）：✓ 已完成、▶ 進行中、→ 可開始、○ 未開始、! 受阻、– 已取消。全部 SVG 線條／形狀。 */
export function statusIcon(kind: 'done' | 'doing' | 'ready' | 'todo' | 'blocked' | 'dropped'): SvgResult {
  const body =
    kind === 'done'
      ? `<path d="M3,8.5 L6.5,12 L13,4.5" stroke="${P.accent}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
      : kind === 'doing'
        ? `<circle cx="8" cy="8" r="7" fill="${P.doing.fill}"/><path d="M6.3,4.8 L11.2,8 L6.3,11.2 Z" fill="#ffffff"/>`
        : kind === 'ready'
          ? `<path d="M2.5,8 H13 M9,4 L13,8 L9,12" stroke="${P.accent}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
          : kind === 'blocked'
            ? `<circle cx="8" cy="8" r="7" fill="${P.blocked.fill}"/><path d="M8,4 V9 M8,11.8 V12" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>`
            : kind === 'dropped'
              ? `<path d="M4,8 H12" stroke="rgba(128,128,128,.8)" stroke-width="2" stroke-linecap="round"/>`
              : `<circle cx="8" cy="8" r="5.5" fill="none" stroke="rgba(128,128,128,.85)" stroke-width="1.6"/>`
  return { source: svgDoc(16, 16, body), width: 16, height: 16, hidden: 0 }
}

/** 插入記號 ⊕（16×16），與膠囊內的一致。 */
export function insertIcon(): SvgResult {
  return { source: svgDoc(16, 16, insMark(8, 8, 6.5)), width: 16, height: 16, hidden: 0 }
}
