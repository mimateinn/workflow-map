// 畫法：每個介面一張 SVG（圖片模式、透明底、不用 isInteractive）。
// 收起 = 一行「進行中 + 分段進度條 + 6/11」；展開 = GitHub Actions 式卡片（同一層的並行步驟疊在同一張卡）；
// 全圖 = GitLab 式階段卡，由上而下。數字一律是 SVG 內的文字，不是按鈕。
// Svg 以圖片繪製讀不到 app 主題：色板分深／淺兩套，由 register 按 /config 的 theme 選。
import type { WorkflowMap, WorkflowNode } from '../types/index'
import { allDone, columns, readyIds, stats } from './graph'
import type { StageView } from './graph'
import { STR } from './i18n'
import type { Lang } from './i18n'

export type Theme = {
  /** 淡色面（卡底、線、未開始）的基色：深色主題用白、淺色主題用黑，再配透明度 */
  ink: string
  text: string
  dim: string
  done: string
  run: string
  block: string
  ins: string
}

/** 淺色版 = 深色版每個色板通道 × 0.55（約暗 45%） */
const darken = (hex: string) =>
  `#${[1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.55).toString(16).padStart(2, '0')).join('')}`
const DARK: Theme = { ink: '#ffffff', text: '#e6e6e3', dim: '#a3a3a0', done: '#3fa66b', run: '#d97757', block: '#d9962b', ins: '#a78bfa' }
export const THEMES: Record<'dark' | 'light', Theme> = {
  dark: DARK,
  light: { ink: '#000000', text: '#1f1f1f', dim: '#5e5e5b', done: darken(DARK.done), run: darken(DARK.run), block: darken(DARK.block), ins: darken(DARK.ins) },
}

/** 桌面版一格約多少 px（types 沒有提供；寧小勿大：放得下好過跑出邊界） */
export const PX_PER_COL = 6.4
/** 全圖面板：真機 6.4 只用到約七成闊度，改用 7.5（仍偏小） */
export const PANE_PX_PER_COL = 7.5

const FONT = "system-ui,-apple-system,'Segoe UI','Microsoft JhengHei','PingFang TC','Noto Sans CJK TC',sans-serif"
const css = (T: Theme) =>
  '<style>' +
  `text{font-family:${FONT};font-size:12px;fill:${T.text};font-variant-numeric:tabular-nums}` +
  `.m{font-size:11px;fill:${T.dim}}.d{fill:${T.dim}}.b{font-weight:600}.r{fill:${T.run}}.a{fill:${T.block}}` +
  // 進行中：圓環向外擴散、淡出（CSS 動畫；圖片模式的 SVG 亦會播放）
  '@keyframes wmp{0%{opacity:.8;transform:scale(1)}70%,100%{opacity:0;transform:scale(1.8)}}' +
  '.p{transform-box:fill-box;transform-origin:center;animation:wmp 1.8s ease-out infinite}' +
  '@media (prefers-reduced-motion:reduce){.p{animation:none;opacity:0}}' +
  '</style>'

export type Pic = { source: string; width: number; height: number }
const doc = (w: number, h: number, T: Theme, body: string): Pic => {
  const width = Math.max(1, Math.ceil(w))
  const height = Math.max(1, Math.ceil(h))
  return { source: `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>${css(T)}${body}</svg>`, width, height }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const r1 = (n: number) => Math.round(n * 10) / 10
const WIDE = /[⺀-鿿가-힯豈-﫿︰-﹏＀-｠￠-￦]/

/** 估算文字闊度（px）：CJK = 1em；拉丁字按字形粗分（系統無襯線字體）。 */
export function tw(s: string, size = 12): number {
  let em = 0
  for (const ch of s) {
    if (WIDE.test(ch)) em += 1
    else if ("il.,:;|!'·".includes(ch)) em += 0.28
    else if ('fjrt -/()[]'.includes(ch)) em += 0.36
    else if ('mwMW'.includes(ch)) em += 0.86
    else if (ch >= 'A' && ch <= 'Z') em += 0.66
    else em += 0.56
  }
  return Math.ceil(em * size)
}

/** 截到 maxPx 以內，超出加「…」。 */
export function fit(s: string, size: number, maxPx: number): string {
  if (tw(s, size) <= maxPx) return s
  const chars = [...s]
  while (chars.length && tw(`${chars.join('')}…`, size) > maxPx) chars.pop()
  return chars.length ? `${chars.join('').trimEnd()}…` : ''
}

/**
 * 文字。fixed = 估算闊度，用 textLength（只調字距）鎖死，後面接的東西位置就準；
 * 右對齊用 text-anchor，不需估算。
 */
function text(x: number, y: number, s: string, cls = '', o: { size?: number; fixed?: boolean; end?: boolean } = {}): string {
  if (!s) return ''
  const len = o.fixed ? ` textLength='${tw(s, o.size ?? (cls.includes('m') ? 11 : 12))}' lengthAdjust='spacing'` : ''
  return `<text x='${r1(x)}' y='${r1(y)}'${cls ? ` class='${cls}'` : ''}${o.end ? " text-anchor='end'" : ''}${len}>${esc(s)}</text>`
}

export type Kind = 'done' | 'doing' | 'ready' | 'todo' | 'blocked'
export const kindOf = (n: WorkflowNode, ready: Set<string>): Kind =>
  n.status === 'todo' || n.status === 'dropped' ? (ready.has(n.id) ? 'ready' : 'todo') : n.status

/**
 * 狀態圖示（12px，中心 cx, cy）：✓ 實心圓、進行中 擴散圓環、未開始 空心圓、受阻 琥珀「!」。
 * 用戶插入的步驟改用菱形（形狀不同，不只靠顏色）。
 */
export function icon(k: Kind, ins: boolean, cx: number, cy: number, T: Theme): string {
  const f = (n: number) => r1(n)
  const check = `<path d='M${f(cx - 2.7)},${f(cy + 0.2)} L${f(cx - 0.8)},${f(cy + 2.1)} L${f(cx + 2.8)},${f(cy - 2)}' stroke='#ffffff' stroke-width='1.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/>`
  const bang = (c: string) => `<path d='M${f(cx)},${f(cy - 3)} V${f(cy + 0.7)} M${f(cx)},${f(cy + 2.9)} V${f(cy + 3)}' stroke='${c}' stroke-width='1.7' stroke-linecap='round'/>`
  if (ins) {
    const d = (r: number) => `M${f(cx)},${f(cy - r)} L${f(cx + r)},${f(cy)} L${f(cx)},${f(cy + r)} L${f(cx - r)},${f(cy)} Z`
    if (k === 'done') return `<path d='${d(6.4)}' fill='${T.ins}' stroke-linejoin='round'/>${check}`
    if (k === 'doing')
      return (
        `<path class='p' d='${d(6.2)}' fill='none' stroke='${T.run}' stroke-width='1.5' stroke-linejoin='round'/>` +
        `<path d='${d(6.2)}' fill='none' stroke='${T.run}' stroke-width='1.5' stroke-linejoin='round'/><path d='${d(3.2)}' fill='${T.ins}'/>`
      )
    return `<path d='${d(5.6)}' fill='none' stroke='${T.ins}' stroke-width='1.5' stroke-linejoin='round'/>${k === 'blocked' ? bang(T.block) : ''}`
  }
  if (k === 'done') return `<circle cx='${f(cx)}' cy='${f(cy)}' r='6' fill='${T.done}' fill-opacity='.7'/>${check}`
  if (k === 'doing')
    return (
      `<circle class='p' cx='${f(cx)}' cy='${f(cy)}' r='5.25' fill='none' stroke='${T.run}' stroke-width='1.5'/>` +
      `<circle cx='${f(cx)}' cy='${f(cy)}' r='5.25' fill='none' stroke='${T.run}' stroke-width='1.5'/>` +
      `<circle cx='${f(cx)}' cy='${f(cy)}' r='2.5' fill='${T.run}'/>`
    )
  if (k === 'blocked') return `<circle cx='${f(cx)}' cy='${f(cy)}' r='6' fill='${T.block}'/>${bang('#1f1f1f')}`
  const op = k === 'ready' ? 0.6 : 0.35
  return `<circle cx='${f(cx)}' cy='${f(cy)}' r='5.25' fill='none' stroke='${T.ink}' stroke-opacity='${op}' stroke-width='1.5'/>`
}

const live = (map: WorkflowMap) => columns(map.nodes.filter(n => n.status !== 'dropped')).flat()

/**
 * 分段進度條：每步一段（已完成 → 進行中 → 受阻 → 未開始）；段太窄時同狀態併成一段。
 */
function segBar(x: number, cy: number, w: number, map: WorkflowMap, T: Theme): string {
  const order = { done: 0, doing: 1, blocked: 2, todo: 3, dropped: 4 } as const
  const steps = live(map).sort((a, b) => order[a.status] - order[b.status])
  const paint = (s: WorkflowNode['status']) =>
    s === 'done'
      ? `fill='${T.done}' fill-opacity='.7'`
      : s === 'doing'
        ? `fill='${T.run}'`
        : s === 'blocked'
          ? `fill='${T.block}'`
          : `fill='${T.ink}' fill-opacity='.3'`
  const h = 6
  const gap = 2
  const n = steps.length
  if (n === 0) return `<rect x='${r1(x)}' y='${r1(cy - h / 2)}' width='${r1(w)}' height='${h}' rx='3' ${paint('todo')}/>`
  let runs: { s: WorkflowNode['status']; k: number }[] = steps.map(s => ({ s: s.status, k: 1 }))
  // 步驟多（> 12）或每段太窄時，同狀態併成連續一段，不畫成一串點
  if (n > 12 || (w - gap * (n - 1)) / n < 5) {
    runs = []
    for (const s of steps) {
      const last = runs[runs.length - 1]
      if (last && last.s === s.status) last.k++
      else runs.push({ s: s.status, k: 1 })
    }
  }
  const unit = (w - gap * (runs.length - 1)) / n
  let at = x
  return runs
    .map(r => {
      const sw = Math.max(3, unit * r.k)
      const out = `<rect x='${r1(at)}' y='${r1(cy - h / 2)}' width='${r1(sw)}' height='${h}' rx='${r1(Math.min(3, sw / 2))}' ${paint(r.s)}/>`
      at += sw + gap
      return out
    })
    .join('')
}

const amber = (cx: number, cy: number, T: Theme) => `<circle cx='${r1(cx)}' cy='${r1(cy)}' r='3' fill='${T.block}'/>`

// ---------------- 收起／展開的標題行 ----------------

/** 標題行左邊說甚麼：進行中（多個時「+N」）；沒有進行中時是下一步或受阻；全部完成。 */
export function headline(map: WorkflowMap, view: StageView, lang: Lang) {
  const t = STR[lang]
  const ready = readyIds(map.nodes)
  if (allDone(map)) return { k: 'done' as Kind, ins: false, name: t.allDone, plus: 0, next: [] as string[] }
  const doing = live(map).filter(n => n.status === 'doing')
  const first = view.levels[0] ?? []
  const lead = doing[0] ?? first.find(n => ready.has(n.id)) ?? first[0]
  if (!lead) return { k: 'todo' as Kind, ins: false, name: '', plus: 0, next: [] }
  const next = [...first.filter(n => n !== lead && n.status !== 'doing' && ready.has(n.id)), ...(view.levels[1] ?? [])]
    .filter(n => n.status !== 'blocked')
    .map(n => n.title)
  return { k: kindOf(lead, ready), ins: !!lead.inserted, name: lead.title, plus: Math.max(0, doing.length - 1), next }
}

const ROW_H = 24
const ICON_X = 11
const LABEL_X = 24

/**
 * 標題行（24px 高），分成兩張圖：左 = 狀態點 + 名稱（+N）+「下一步：」；右 = 分段進度條 + 6/11（+ 琥珀點）。
 * 中間由介面的空白撐開，右邊永遠貼住按鈕；avail 估大估細只影響進度條長度。
 */
export function bandHeader(map: WorkflowMap, view: StageView, lang: Lang, T: Theme, avail: number, pending: boolean) {
  const t = STR[lang]
  const s = stats(map)
  const h = headline(map, view, lang)
  const count = `${s.done}/${s.total}`
  const countW = tw(count)
  const meterTail = 10 + countW + (pending ? 12 : 0)
  const cy = ROW_H / 2
  // 名稱最多佔四成；「下一步」只在放得下（進度條仍有 120px）時才出現
  const name = fit(h.name, 12, Math.min(280, Math.max(60, avail * 0.4)))
  const plus = h.plus ? `+${h.plus}` : ''
  let x = LABEL_X + tw(name) + (plus ? 6 + tw(plus) : 0)
  let nextText = ''
  const room = avail - x - 16 - (120 + meterTail) - 16
  if (h.next.length && room >= 80) {
    const max = Math.min(room, 320)
    nextText = fit(`${t.upNext}${h.next[0]}`, 11, max)
    for (const more of h.next.slice(1)) {
      const longer = `${nextText} · ${more}`
      if (tw(longer, 11) > max) break
      nextText = longer
    }
    if (nextText) x += 16 + tw(nextText, 11)
  }
  const lead = doc(
    x + 2,
    ROW_H,
    T,
    icon(h.k, h.ins, ICON_X, cy, T) +
      text(LABEL_X, cy + 4, name, h.k === 'done' ? '' : 'b', { fixed: true }) +
      (plus ? text(LABEL_X + tw(name) + 6, cy + 4, plus, 'd', { fixed: true }) : '') +
      (nextText ? text(x - tw(nextText, 11), cy + 4, nextText, 'm', { fixed: true }) : ''),
  )
  const barW = Math.round(Math.min(360, Math.max(80, avail - x - 24 - meterTail)))
  const meter = doc(
    barW + meterTail,
    ROW_H,
    T,
    segBar(0, cy, barW, map, T) + text(barW + 10, cy + 4, count, '', { fixed: true }) + (pending ? amber(barW + 10 + countW + 8, cy, T) : ''),
  )
  return { lead, meter }
}

// ---------------- 展開：GitHub Actions 式卡片 ----------------

type CardRow = { k?: Kind; ins?: boolean; label: string; cls?: string }
type Card = { rows: CardRow[]; w: number; hot: boolean }

const CARD_ROW = 18
const CARD_GAP = 24
const MAX_LABEL = 150

function card(rows: CardRow[], hot: boolean): Card {
  const fitted = rows.map(r => ({ ...r, label: fit(r.label, 12, MAX_LABEL) }))
  const w = Math.max(...fitted.map(r => (r.k ? LABEL_X : 10) + tw(r.label) + 10))
  return { rows: fitted, w, hot }
}

/**
 * 卡片圖（≤ 3 行高）：[✓ 9 已完成] — [同層並行步驟一張卡] — … — [+5 稍後]。
 * 卡頂對齊，連接點在第一行中線，所以線都是直的、不會交叉。放不下的層算進「稍後」。
 */
export function bandGraph(map: WorkflowMap, view: StageView, lang: Lang, T: Theme, maxW: number): Pic & { hidden: number } {
  const t = STR[lang]
  const ready = readyIds(map.nodes)
  const cards: Card[] = []
  let used = 0
  const push = (c: Card) => {
    cards.push(c)
    used += (cards.length > 1 ? CARD_GAP : 0) + c.w
  }
  if (view.done.length) push(card([{ k: 'done', label: t.doneCard(view.done.length) }], false))
  let later = [...view.later]
  view.levels.forEach((lv, i) => {
    if (later.length > view.later.length) return later.push(...lv)
    const shown = lv.length > 3 ? lv.slice(0, 2) : lv
    const rows: CardRow[] = shown.map(n => ({ k: kindOf(n, ready), ins: !!n.inserted, label: n.title }))
    if (lv.length > 3) rows.push({ label: t.moreRows(lv.length - 2), cls: 'd' })
    const c = card(rows, lv.some(n => n.status === 'doing'))
    const rest = later.length + view.levels.slice(i + 1).flat().length
    const reserve = rest ? CARD_GAP + 20 + tw(t.laterCard(rest + lv.length)) + 20 : 0
    if (i > 0 && used + CARD_GAP + c.w + reserve > maxW) return later.push(...lv)
    push(c)
  })
  later = later.filter((n, i, a) => a.indexOf(n) === i)
  if (later.length) {
    const ins = later.some(n => n.inserted)
    push(card([{ k: ins ? 'todo' : undefined, ins, label: t.laterCard(later.length), cls: 'd' }], false))
  }
  // 卡先畫，線與連接點後畫（點蓋在卡邊上）
  const parts: string[] = []
  const wires: string[] = []
  const portY = 0.5 + 1 + CARD_ROW / 2
  let x = 0
  let height = 0
  const dot = (cx: number, hot: boolean) =>
    `<circle cx='${r1(cx)}' cy='${portY}' r='2.5' ${hot ? `fill='${T.run}'` : `fill='${T.ink}' fill-opacity='.3'`}/>`
  cards.forEach((c, i) => {
    if (i > 0) {
      const x1 = x - CARD_GAP
      const stroke = c.hot ? `stroke='${T.run}'` : `stroke='${T.ink}' stroke-opacity='.22'`
      wires.push(`<path d='M${r1(x1)},${portY} H${r1(x)}' ${stroke} stroke-width='1.5'/>`, dot(x1, c.hot), dot(x, c.hot))
    }
    const h = 2 + c.rows.length * CARD_ROW
    height = Math.max(height, h + 1)
    parts.push(
      `<rect x='${r1(x + 0.5)}' y='0.5' width='${r1(c.w - 1)}' height='${h}' rx='4' fill='${T.ink}' fill-opacity='.06' stroke='${T.ink}' stroke-opacity='.16'/>`,
    )
    c.rows.forEach((r, j) => {
      const cy = 0.5 + 1 + j * CARD_ROW + CARD_ROW / 2
      if (r.k) parts.push(icon(r.k, !!r.ins, x + ICON_X, cy, T))
      parts.push(text(x + (r.k ? LABEL_X : 10), cy + 4, r.label, r.cls ?? '', { fixed: true }))
    })
    x += c.w + CARD_GAP
  })
  const hidden = later.length
  // 與標題行之間留 4px
  return { ...doc(x - CARD_GAP + 1, height + 4, T, `<g transform='translate(0,4)'>${parts.join('')}${wires.join('')}</g>`), hidden }
}

// ---------------- 全圖：GitLab 式階段卡（由上而下） ----------------

/** ISO → 本地 MM-DD HH:MM；缺少或無效（含 1970 起點）時回傳空字串。 */
export function fmtTime(iso: string | undefined): string {
  const d = new Date(iso ?? '')
  if (!iso || Number.isNaN(d.getTime()) || d.getTime() <= 86_400_000) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 全圖標題行左邊（24px 高）：分段進度條撐滿 + 16 / 23 + 「3 進行中 · 1 受阻」（+ 琥珀點、未記錄）。 */
export function paneMeter(map: WorkflowMap, lang: Lang, T: Theme, width: number, pending: boolean): Pic {
  const t = STR[lang]
  const s = stats(map)
  const ready = readyIds(map.nodes)
  const blocked = map.nodes.filter(n => n.status === 'blocked').length
  const count = `${s.done} / ${s.total}`
  const status = allDone(map) ? t.allDone : t.statusLine(s.doing.length, blocked, ready.size)
  // 太窄時先丟「未記錄」字樣、再丟狀態字，進度條至少 96px
  const tails = [[status, pending ? t.unlogged : ''], [status], []].map(a => a.filter(Boolean).join(' · '))
  const wOf = (tail: string) => 12 + tw(count) + (pending ? 14 : 0) + (tail ? 12 + tw(tail, 11) : 0)
  const tail = tails.find(x => width - wOf(x) >= 96) ?? ''
  const textW = wOf(tail)
  const barW = Math.max(80, Math.round(width - textW))
  const cy = ROW_H / 2
  let x = barW + 12
  let body = segBar(0, cy, barW, map, T) + text(x, cy + 4, count, 'b', { fixed: true })
  x += tw(count)
  if (pending) {
    body += amber(x + 8, cy, T)
    x += 14
  }
  if (tail) body += text(x + 12, cy + 4, tail, 'm', { fixed: true })
  return doc(barW + textW, ROW_H, T, body)
}

type PaneRow = { k: Kind; ins: boolean; title: string; meta: string; metaCls: string; sub: string }
type PaneCard = { head: string; headIcon?: Kind; headCls: string; rows: PaneRow[]; note?: string; hot: boolean }

const HEAD = 28
const PROW = 24
const PROW2 = 40
const PAD_B = 6
const STACK_GAP = 16
const P_ICON = 20
const P_TEXT = 34

/**
 * 階段卡：[已完成 9 項]（收起；展開時列出）→ 階段 1…（每層一張，列出步驟）→ [稍後 5 項]。
 * 每列：狀態圖示 + 名稱 + 右邊淡色狀態；插入的步驟左邊紫色細線 + 菱形 + 第二行（時間 · 用戶的話）；
 * 未能開始的步驟第二行「← 待 A、B」。卡與卡之間一小段直線。
 */
export function paneStages(map: WorkflowMap, view: StageView, o: { lang: Lang; T: Theme; width: number; doneOpen: boolean }): Pic {
  const t = STR[o.lang]
  const T = o.T
  const W = Math.round(o.width)
  const ready = readyIds(map.nodes)
  const byId = new Map(map.nodes.map(n => [n.id, n]))
  const row = (n: WorkflowNode): PaneRow => {
    const k = kindOf(n, ready)
    const waiting = n.deps.map(d => byId.get(d)).filter((d): d is WorkflowNode => !!d && d.status !== 'done' && d.status !== 'dropped')
    const sub = [
      n.inserted ? [fmtTime(n.inserted.at), n.inserted.note].filter(Boolean).join(' · ') : '',
      (k === 'todo' || k === 'blocked') && waiting.length ? `← ${t.waitShort(waiting.map(d => d.title).join(t.list))}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const meta = k === 'doing' ? t.status.doing : k === 'blocked' ? t.status.blocked : k === 'ready' ? t.ready : ''
    return { k, ins: !!n.inserted, title: n.title, meta, metaCls: k === 'doing' ? 'm r' : k === 'blocked' ? 'm a' : 'm', sub }
  }
  const cards: PaneCard[] = []
  if (view.done.length) {
    const open = o.doneOpen || !view.foldDone
    cards.push({ head: t.doneStage(view.done.length), headIcon: open ? undefined : 'done', headCls: 'b', rows: open ? view.done.map(row) : [], hot: false })
  }
  view.levels.forEach((lv, i) =>
    cards.push({ head: t.stage(i + 1, lv.length), headCls: 'b', rows: lv.map(row), hot: lv.some(n => n.status === 'doing') }),
  )
  if (view.later.length)
    cards.push({ head: t.laterStage(view.later.length), headCls: 'b d', rows: [], note: view.later.map(n => n.title).join(' · '), hot: false })

  const parts: string[] = []
  const wires: string[] = []
  let y = 8.5 // 與標題行之間 8px
  const line = (hot: boolean) => (hot ? `stroke='${T.run}'` : `stroke='${T.ink}' stroke-opacity='.22'`)
  const dot = (cy: number, hot: boolean) => `<circle cx='${P_ICON}' cy='${r1(cy)}' r='2.5' ${hot ? `fill='${T.run}'` : `fill='${T.ink}' fill-opacity='.3'`}/>`
  cards.forEach((c, i) => {
    if (i > 0) {
      const top = y - STACK_GAP
      wires.push(`<path d='M${P_ICON},${r1(top)} V${r1(y)}' ${line(c.hot)} stroke-width='1.5'/>`, dot(top, c.hot), dot(y, c.hot))
    }
    const rowsH = c.rows.reduce((s, r) => s + (r.sub ? PROW2 : PROW), 0)
    const h = c.rows.length ? HEAD + 2 + rowsH + PAD_B : c.note ? HEAD + 20 : 32
    parts.push(`<rect x='0.5' y='${r1(y)}' width='${W - 1}' height='${h}' rx='8' fill='${T.ink}' fill-opacity='.05' stroke='${T.ink}' stroke-opacity='.16'/>`)
    const headY = y + 20
    if (c.headIcon) parts.push(icon(c.headIcon, false, P_ICON, headY - 4, T))
    parts.push(text(c.headIcon ? P_TEXT : 14, headY, fit(c.head, 12, W - 48), c.headCls))
    if (c.note) parts.push(text(14, y + HEAD + 9, fit(c.note, 11, W - 28), 'm'))
    let ry = y + HEAD + 2
    for (const r of c.rows) {
      const rh = r.sub ? PROW2 : PROW
      const cy = ry + PROW / 2
      if (r.ins) parts.push(`<rect x='4' y='${r1(ry + 4)}' width='2' height='${rh - 8}' rx='1' fill='${T.ins}'/>`)
      parts.push(icon(r.k, r.ins, P_ICON, cy, T))
      const metaW = r.meta ? tw(r.meta, 11) + 12 : 0
      parts.push(text(P_TEXT, cy + 4, fit(r.title, 12, W - P_TEXT - 14 - metaW), r.k === 'todo' ? 'd' : ''))
      if (r.meta) parts.push(text(W - 14, cy + 4, r.meta, r.metaCls, { end: true }))
      if (r.sub) parts.push(text(P_TEXT, cy + 20, fit(r.sub, 11, W - P_TEXT - 14), 'm'))
      ry += rh
    }
    y += h + STACK_GAP
  })
  return doc(W, y - STACK_GAP + 1, T, parts.join('') + wires.join(''))
}
