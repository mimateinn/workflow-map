// 畫法：每個介面一張 SVG（圖片模式、透明底、不用 isInteractive）。
// 收起 = 一行「進行中 + 分段進度條 + 6/11」；展開 = GitHub Actions 式卡片（同一層的並行步驟疊在同一張卡）；
// 全圖 = GitLab 式階段卡，由上而下。數字一律是 SVG 內的文字，不是按鈕。
// Svg 以圖片繪製讀不到 app 主題：色板分深／淺兩套，由 register 按 /config 的 theme 選。
import type { WorkflowMap, WorkflowNode } from '../types/index'
import { allDone, columns, elapsedMin, fmtTime, impactText, insertedHot, insertedMarked, isStale, isStep, readyIds, stats } from './graph'
import type { StageView } from './graph'
import { STR } from './i18n'
import type { Lang } from './i18n'
import { fitCells } from './suggest'

export type Theme = {
  /** 淡色面（卡底、線、未開始）的基色：深色主題用白、淺色主題用黑，再配透明度 */
  ink: string
  text: string
  dim: string
  done: string
  run: string
  block: string
  ins: string
  /** 流程圖的線（不透明：幾條線合併重疊時不會越疊越亮） */
  wire: string
}

/** 淺色版 = 深色版每個色板通道 × 0.55（約暗 45%） */
const darken = (hex: string) =>
  `#${[1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.55).toString(16).padStart(2, '0')).join('')}`
const DARK: Theme = { ink: '#ffffff', text: '#e6e6e3', dim: '#a3a3a0', done: '#3fa66b', run: '#d97757', block: '#d9962b', ins: '#a78bfa', wire: '#6e6e6c' }
export const THEMES: Record<'dark' | 'light', Theme> = {
  dark: DARK,
  light: { ink: '#000000', text: '#1f1f1f', dim: '#5e5e5b', done: darken(DARK.done), run: darken(DARK.run), block: darken(DARK.block), ins: darken(DARK.ins), wire: '#a8a8a5' },
}

/** 桌面版一格約多少 px（types 沒有提供；寧小勿大：放得下好過跑出邊界） */
export const PX_PER_COL = 6.4

const FONT = "system-ui,-apple-system,'Segoe UI','Microsoft JhengHei','PingFang TC','Noto Sans CJK TC',sans-serif"
const css = (T: Theme, motion = true, fresh = false) =>
  '<style>' +
  `text{font-family:${FONT};font-size:12px;fill:${T.text};font-variant-numeric:tabular-nums}` +
  `.m{font-size:11px;fill:${T.dim}}.d{fill:${T.dim}}.b{font-weight:600}.r{fill:${T.run}}.a{fill:${T.block}}` +
  // 進行中：圓環向外擴散、淡出（CSS 動畫；圖片模式的 SVG 亦會播放）。沒有呼吸圖示的圖不帶（省樹的大小）
  (motion
    ? '@keyframes wmp{0%{opacity:.8;transform:scale(1)}70%,100%{opacity:0;transform:scale(1.8)}}' +
      '.p{transform-box:fill-box;transform-origin:center;animation:wmp 1.8s ease-out infinite}' +
      '@media (prefers-reduced-motion:reduce){.p{animation:none;opacity:0}}'
    : '') +
  // 本輪剛記錄的中途要求：紫色菱形外圈擴散三次（「已記入」的確認），之後靜止
  (fresh
    ? '@keyframes wmq{0%{opacity:.9;transform:scale(1)}80%,100%{opacity:0;transform:scale(2)}}' +
      '.q{transform-box:fill-box;transform-origin:center;opacity:0;animation:wmq 1.4s ease-out 3}' +
      '@media (prefers-reduced-motion:reduce){.q{animation:none}}'
    : '') +
  '</style>'

export type Pic = { source: string; width: number; height: number }
export const doc = (w: number, h: number, T: Theme, body: string): Pic => {
  const width = Math.max(1, Math.ceil(w))
  const height = Math.max(1, Math.ceil(h))
  return { source: `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>${css(T, body.includes("class='p'"), body.includes("class='q'"))}${body}</svg>`, width, height }
}

export const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
export const r1 = (n: number) => Math.round(n * 10) / 10
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
export function text(x: number, y: number, s: string, cls = '', o: { size?: number; fixed?: boolean; end?: boolean } = {}): string {
  if (!s) return ''
  const len = o.fixed ? ` textLength='${tw(s, o.size ?? (cls.includes('m') ? 11 : 12))}' lengthAdjust='spacing'` : ''
  return `<text x='${r1(x)}' y='${r1(y)}'${cls ? ` class='${cls}'` : ''}${o.end ? " text-anchor='end'" : ''}${len}>${esc(s)}</text>`
}

/** 畫面當下的時間、「久未更新」門檻（分鐘，0 = 不檢查）、本輪開始的時間（插入的步驟只在本輪用紫色） */
export type Clock = { now: number; staleMin: number; turnAt?: number }

/** 紫色 ◇（本輪插入或本輪完成的插入步驟） */
export const insHot = (n: WorkflowNode, c: Clock) => insertedHot(n, c.turnAt)
/** 本輪剛插入、仍未完成的步驟：圖示外圈擴散三次（記錄了的確認） */
export const insFresh = (n: WorkflowNode, c: Clock) =>
  !!n.inserted && !!c.turnAt && (Date.parse(n.inserted.at) || 0) >= c.turnAt && n.status !== 'done' && n.status !== 'dropped'
/** 標題前的淡色 ◇（舊輪插入、仍未完成） */
export const insMark = (n: WorkflowNode, c: Clock) => insertedMarked(n, c.turnAt)
/** 標題前加淡色記號的寬度（px，12px 字） */
const MARK_W = 13
const NO_CLOCK: Clock = { now: 0, staleMin: 0 }

export type Kind = 'done' | 'doing' | 'stale' | 'ready' | 'todo' | 'blocked'
export const kindOf = (n: WorkflowNode, ready: Set<string>, c: Clock = NO_CLOCK): Kind =>
  n.status === 'todo' || n.status === 'dropped'
    ? ready.has(n.id)
      ? 'ready'
      : 'todo'
    : n.status === 'doing' && isStale(n, c.now, c.staleMin)
      ? 'stale'
      : n.status

/** 卡片／列右邊的小字：負責人（最多 10 格）· 用時（精簡：1h34m、1時34分）；一行，不換行 */
export function metaOf(n: WorkflowNode, lang: Lang, c: Clock): string {
  const min = c.now ? elapsedMin(n, c.now) : undefined
  return [n.owner ? fitCells(n.owner, 10) : '', min === undefined ? '' : STR[lang].durShort(min)].filter(Boolean).join(' · ')
}

/**
 * 狀態圖示（12px，中心 cx, cy）：✓ 實心圓、進行中 擴散圓環、未開始 空心圓、受阻 琥珀「!」。
 * 用戶插入的步驟改用菱形（形狀不同，不只靠顏色）。
 */
export function icon(k: Kind, ins: boolean, cx: number, cy: number, T: Theme, fresh = false): string {
  if (fresh) {
    const d = `M${r1(cx)},${r1(cy - 6.2)} L${r1(cx + 6.2)},${r1(cy)} L${r1(cx)},${r1(cy + 6.2)} L${r1(cx - 6.2)},${r1(cy)} Z`
    return `<path class='q' d='${d}' fill='none' stroke='${T.ins}' stroke-width='1.5' stroke-linejoin='round'/>${icon(k, ins, cx, cy, T)}`
  }
  const f = (n: number) => r1(n)
  const check = `<path d='M${f(cx - 2.7)},${f(cy + 0.2)} L${f(cx - 0.8)},${f(cy + 2.1)} L${f(cx + 2.8)},${f(cy - 2)}' stroke='#ffffff' stroke-width='1.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/>`
  const bang = (c: string) => `<path d='M${f(cx)},${f(cy - 3)} V${f(cy + 0.7)} M${f(cx)},${f(cy + 2.9)} V${f(cy + 3)}' stroke='${c}' stroke-width='1.7' stroke-linecap='round'/>`
  if (ins) {
    if (k === 'stale') k = 'doing'
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
  // 進行中但久未更新：琥珀色圓環（不再呼吸）
  if (k === 'stale')
    return `<circle cx='${f(cx)}' cy='${f(cy)}' r='5.25' fill='none' stroke='${T.block}' stroke-width='1.5'/><circle cx='${f(cx)}' cy='${f(cy)}' r='2.5' fill='${T.block}'/>`
  const op = k === 'ready' ? 0.6 : 0.35
  return `<circle cx='${f(cx)}' cy='${f(cy)}' r='5.25' fill='none' stroke='${T.ink}' stroke-opacity='${op}' stroke-width='1.5'/>`
}

const live = (map: WorkflowMap) => columns(map.nodes.filter(isStep)).flat()

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
export function headline(map: WorkflowMap, view: StageView, lang: Lang, c: Clock = NO_CLOCK) {
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
  return { k: kindOf(lead, ready, c), ins: insHot(lead, c), name: `${insMark(lead, c) ? '◇ ' : ''}${lead.title}`, plus: Math.max(0, doing.length - 1), next }
}

const ROW_H = 24
/**
 * 輸入框上方各行的共同左邊：每張圖內左邊留 BAND_INSET px，標題行的狀態點與卡片圖的第一張卡都由這條線開始
 * （與 next-steps 等其他橫條的文字左邊對齊）。
 */
export const BAND_INSET = 0
/** 卡片內：圖示中心、文字開始（相對卡的左邊） */
const ICON_X = 11
const LABEL_X = 24
/** 標題行：狀態點左邊 = BAND_INSET（呼吸圓環擴散時仍在圖內），文字跟在後面 */
const HEAD_ICON_X = BAND_INSET + 7
const HEAD_LABEL_X = HEAD_ICON_X + 13

/**
 * 標題行（24px 高），分成兩張圖：左 = 狀態點 + 名稱（+N）+「下一步：」；右 = 分段進度條 + 6/11（+ 琥珀點）。
 * 中間由介面的空白撐開，右邊永遠貼住按鈕；avail 估大估細只影響進度條長度。
 */
export function bandHeader(map: WorkflowMap, view: StageView, lang: Lang, T: Theme, avail: number, pending: boolean, c: Clock = NO_CLOCK, eta = '') {
  const t = STR[lang]
  const s = stats(map)
  const h = headline(map, view, lang, c)
  const count = `${s.done}/${s.total}`
  const countW = tw(count)
  const etaW = eta ? 8 + tw(eta, 11) : 0
  const meterTail = 10 + countW + etaW + (pending ? 12 : 0)
  const cy = ROW_H / 2
  // 名稱最多佔四成；「下一步」只在放得下（進度條仍有 120px）時才出現
  const name = fit(h.name, 12, Math.min(280, Math.max(60, avail * 0.4)))
  const plus = h.plus ? `+${h.plus}` : ''
  let x = HEAD_LABEL_X + tw(name) + (plus ? 6 + tw(plus) : 0)
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
    icon(h.k, h.ins, HEAD_ICON_X, cy, T) +
      text(HEAD_LABEL_X, cy + 4, name, h.k === 'done' ? '' : 'b', { fixed: true }) +
      (plus ? text(HEAD_LABEL_X + tw(name) + 6, cy + 4, plus, 'd', { fixed: true }) : '') +
      (nextText ? text(x - tw(nextText, 11), cy + 4, nextText, 'm', { fixed: true }) : ''),
  )
  const barW = Math.round(Math.min(360, Math.max(80, avail - x - 24 - meterTail)))
  const meter = doc(
    barW + meterTail,
    ROW_H,
    T,
    segBar(0, cy, barW, map, T) +
      text(barW + 10, cy + 4, count, '', { fixed: true }) +
      (eta ? text(barW + 10 + countW + 8, cy + 4, eta, 'm', { fixed: true }) : '') +
      (pending ? amber(barW + 10 + countW + etaW + 8, cy, T) : ''),
  )
  return { lead, meter }
}

// ---------------- 展開：GitHub Actions 式卡片 ----------------

type CardRow = { k?: Kind; ins?: boolean; fresh?: boolean; mark?: boolean; label: string; cls?: string; meta?: string }
type Card = { rows: CardRow[]; w: number; hot: boolean }

const CARD_ROW = 18
const CARD_GAP = 24
const MAX_LABEL = 150

function card(rows: CardRow[], hot: boolean): Card {
  const fitted = rows.map(r => ({ ...r, label: fit(r.label, 12, MAX_LABEL), meta: r.meta ? fit(r.meta, 11, 80) : '' }))
  const w = Math.max(...fitted.map(r => (r.k ? LABEL_X : 10) + (r.mark ? MARK_W : 0) + tw(r.label) + (r.meta ? 6 + tw(r.meta, 11) : 0) + 10))
  return { rows: fitted, w, hot }
}

/**
 * 卡片圖，分成三張圖（同一行，中間沒有空隙，線接得上）：
 *   [✓ 5 已完成 ——]   [同層並行步驟一張卡 — … —●]   [- - +2 稍後（虛線幽靈卡）]
 * 左右兩張各自放在有 key 的 Box 內，指著時彈出清單（已完成／稍後的步驟）。
 * 中間的卡頂對齊，連接點在第一行中線，線都是直的。放不下的層算進「稍後」。
 * 線與連接點只畫在兩端都有看得見的卡時（全部完成：只有已完成小卡，沒有線）。
 */
export type BandGraph = {
  /** 「✓ N 已完成」小卡（後面有卡才有線；沒有已完成步驟時 undefined） */
  done?: Pic
  /** 各層的卡（全部完成時沒有：只剩已完成小卡） */
  main?: Pic
  /** 「+N 稍後」虛線幽靈卡＋虛線（沒有收起的步驟時 undefined） */
  ghost?: Pic
  /** 收起的步驟（計劃次序），給彈出清單用 */
  hiddenSteps: WorkflowNode[]
  /** 中間那張圖畫了幾張卡、幾條卡與卡之間的線 */
  cards: number
  edges: number
}

export function bandGraph(map: WorkflowMap, view: StageView, lang: Lang, T: Theme, maxW: number, clk: Clock = NO_CLOCK): BandGraph {
  const t = STR[lang]
  const ready = readyIds(map.nodes)
  const portY = 0.5 + 1 + CARD_ROW / 2
  const TOP = 4 // 與標題行之間 4px
  const line = (hot: boolean, dashed = false) =>
    `${hot ? `stroke='${T.run}'` : `stroke='${T.ink}' stroke-opacity='.22'`} stroke-width='1.5'${dashed ? " stroke-dasharray='3 3'" : ''}`
  const dot = (cx: number, hot: boolean) => `<circle cx='${r1(cx)}' cy='${r1(portY)}' r='2.5' ${hot ? `fill='${T.run}'` : `fill='${T.ink}' fill-opacity='.3'`}/>`
  const drawCard = (c: Card, x: number, parts: string[], ghost = false) => {
    const h = 2 + c.rows.length * CARD_ROW
    parts.push(
      ghost
        ? `<rect x='${r1(x + 0.5)}' y='0.5' width='${r1(c.w - 1)}' height='${h}' rx='4' fill='${T.ink}' fill-opacity='.035' stroke='${T.ink}' stroke-opacity='.35' stroke-dasharray='3 2'/>`
        : // 卡面：比四周略亮的填色，沒有外框（與 app 自己的卡片一致）
          `<rect x='${r1(x + 0.5)}' y='0.5' width='${r1(c.w - 1)}' height='${h}' rx='4' fill='${T.ink}' fill-opacity='.07'/>`,
    )
    c.rows.forEach((r, j) => {
      const cy = 0.5 + 1 + j * CARD_ROW + CARD_ROW / 2
      if (r.k) parts.push(icon(r.k, !!r.ins, x + ICON_X, cy, T, !!r.fresh))
      // textLength 只在後面還有字時才用（否則估算誤差會把字距拉開）
      const lx = x + (r.k ? LABEL_X : 10) + (r.mark ? MARK_W : 0)
      if (r.mark) parts.push(text(lx - MARK_W, cy + 4, '◇', 'm'))
      parts.push(text(lx, cy + 4, r.label, r.cls ?? '', { fixed: !!r.meta }))
      if (r.meta) parts.push(text(lx + tw(r.label) + 6, cy + 4, r.meta, 'm', { fixed: true }))
    })
    return h + 1
  }
  const pic = (w: number, h: number, parts: string[], x0 = 0) =>
    doc(w, h + TOP, T, `<g transform='translate(${x0},${TOP})'>${parts.join('')}</g>`)

  // 中間各層的卡：放得下多少就畫多少（左右兩張小卡的位先留起）
  const levelCards = view.levels.map(lv => {
    const shown = lv.length > 3 ? lv.slice(0, 2) : lv
    const cr: CardRow[] = shown.map(n => ({ k: kindOf(n, ready, clk), ins: insHot(n, clk), fresh: insFresh(n, clk), mark: insMark(n, clk), label: n.title, meta: metaOf(n, lang, clk) }))
    if (lv.length > 3) cr.push({ label: t.moreRows(lv.length - 2), cls: 'd' })
    return { c: card(cr, lv.some(n => n.status === 'doing')), steps: lv }
  })
  const doneCard = view.done.length ? card([{ k: 'done', label: t.doneCard(view.done.length) }], false) : undefined
  const doneW = doneCard ? doneCard.w + CARD_GAP : 0
  const ghostReserve = (n: number) => CARD_GAP + 20 + tw(t.laterCard(n)) + 20
  const placed: Card[] = []
  const hiddenSteps: WorkflowNode[] = []
  let used = BAND_INSET + doneW
  levelCards.forEach(({ c, steps }, i) => {
    const rest = levelCards.slice(i + 1).reduce((n, x) => n + x.steps.length, 0) + view.later.length
    const fits = used + (placed.length ? CARD_GAP : 0) + c.w + (rest ? ghostReserve(rest + steps.length) : 0) <= maxW
    if (hiddenSteps.length || (placed.length && !fits)) return void hiddenSteps.push(...steps)
    placed.push(c)
    used += (placed.length > 1 ? CARD_GAP : 0) + c.w
  })
  hiddenSteps.push(...view.later)
  const hidden = hiddenSteps.filter((n, i, a) => a.indexOf(n) === i)

  // 左：已完成小卡 + 接到第一張卡的線（後面沒有卡就不畫線）
  let done: Pic | undefined
  if (doneCard) {
    const parts: string[] = []
    const h = drawCard(doneCard, 0, parts)
    const next = placed[0]
    if (next)
      parts.push(`<path d='M${r1(doneCard.w)},${r1(portY)} H${r1(doneCard.w + CARD_GAP)}' ${line(next.hot)}/>`, dot(doneCard.w, next.hot), dot(doneCard.w + CARD_GAP - 2.5, next.hot))
    done = pic(BAND_INSET + doneCard.w + (next ? CARD_GAP : 0), h, parts, BAND_INSET)
  }
  // 中：各層的卡與卡之間的線
  const parts: string[] = []
  const wires: string[] = []
  let x = doneCard ? 0 : BAND_INSET
  let h = 0
  let edges = 0
  placed.forEach((c, i) => {
    if (i > 0) {
      const x1 = x - CARD_GAP
      wires.push(`<path d='M${r1(x1)},${r1(portY)} H${r1(x)}' ${line(c.hot)}/>`, dot(x1, c.hot), dot(x, c.hot))
      edges++
    }
    h = Math.max(h, drawCard(c, x, parts))
    x += c.w + CARD_GAP
  })
  const end = Math.max(0, x - CARD_GAP)
  if (hidden.length) wires.push(dot(end, false))
  const main = placed.length ? pic(end + (hidden.length ? 3 : 1), h, [...parts, ...wires]) : undefined
  // 右：虛線 + 「+N 稍後」幽靈卡
  let ghost: Pic | undefined
  if (hidden.length) {
    const ins = hidden.some(n => insHot(n, clk))
    const gc = card([{ k: ins ? 'todo' : undefined, ins, label: t.laterCard(hidden.length), cls: 'd' }], false)
    // 虛線只在左邊有卡時畫
    const gx = placed.length || doneCard ? CARD_GAP - 3 : 0
    const gp: string[] = gx ? [`<path d='M0,${r1(portY)} H${r1(gx)}' ${line(false, true)}/>`] : []
    const gh = drawCard(gc, gx, gp, true)
    ghost = pic(gx + gc.w + 1, gh, gp)
  }
  return { done, main, ghost, hiddenSteps: hidden, cards: placed.length, edges }
}

// ---------------- 全圖：GitLab 式階段卡（由上而下） ----------------
// 卡框由介面的 Box（圓角邊框）畫、由介面撐滿面板闊度：不再估算 px，不會有接縫或右邊空位。
// 這裏只出資料（每張卡、每一步的文字與狀態）和小圖（狀態圖示、進度條）。

export { fmtTime } from './graph'

/**
 * 全圖標題行的分段進度條（只有條；數字與狀態字由介面的 Text 畫）。preserveAspectRatio none：
 * 介面給的格比 width 窄時橫向縮，條不會被切掉、數字不會被擠到下一行。
 */
export function paneBar(map: WorkflowMap, T: Theme, width: number): Pic {
  const p = doc(width, 20, T, segBar(0, 10, Math.max(40, width), map, T))
  return { ...p, source: p.source.replace('<svg ', "<svg preserveAspectRatio='none' ") }
}

/** 一個狀態圖示（20×20，留位給呼吸圓環）。 */
export function iconPic(k: Kind, ins: boolean, T: Theme, fresh = false): Pic {
  return doc(20, 20, T, icon(k, ins, 10, 10, T, fresh))
}

/** 專案總覽的小進度條（60×20）。 */
export function miniBar(done: number, total: number, T: Theme): Pic {
  const w = total ? Math.round((56 * done) / total) : 0
  return doc(60, 20, T, `<rect x='2' y='7' width='56' height='6' rx='3' fill='${T.ink}' fill-opacity='.3'/>` + (w ? `<rect x='2' y='7' width='${Math.max(6, w)}' height='6' rx='3' fill='${T.done}' fill-opacity='.7'/>` : ''))
}

/** 收起／展開的記號：細線「V」（像 app 下拉選單的箭咀），收起時向下、展開時向上；14×20，淡色。 */
export function chevronPic(open: boolean, T: Theme): Pic {
  const d = open ? 'M3,12 L7,8 L11,12' : 'M3,8 L7,12 L11,8'
  return doc(14, 20, T, `<path d='${d}' fill='none' stroke='${T.dim}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/>`)
}

/** 圖示欄的空位（20×20，沒有圖示的行用它，令文字對齊）。 */
export const slotPic = (T: Theme): Pic => doc(20, 20, T, '')

/** 建議行的 ✦（與標題行的狀態點同一欄：中心 HEAD_ICON_X）；圖闊 STAR_W = 標題行文字開始的位置。 */
export const STAR_W = HEAD_LABEL_X
export function starPic(T: Theme): Pic {
  const cx = HEAD_ICON_X
  const cy = 10
  const r = 6
  const d = `M${cx},${cy - r} Q${cx},${cy} ${cx + r},${cy} Q${cx},${cy} ${cx},${cy + r} Q${cx},${cy} ${cx - r},${cy} Q${cx},${cy} ${cx},${cy - r} Z`
  return doc(STAR_W, 20, T, `<path d='${d}' fill='${T.run}'/>`)
}

/** 說明卡用：「你剛發出的要求未記入」的琥珀點（20×20）。 */
export const amberPic = (T: Theme): Pic => doc(20, 20, T, amber(10, 10, T))

/** 全圖標題行右邊的狀態字：「3 進行中 · 1 受阻」（全部完成時「全部完成」）。 */
export function paneStatus(map: WorkflowMap, lang: Lang): string {
  const t = STR[lang]
  const s = stats(map)
  if (allDone(map)) return t.allDone
  return t.statusLine(s.doing.length, map.nodes.filter(n => n.status === 'blocked').length, readyIds(map.nodes).size)
}

export type PaneRow = {
  n: WorkflowNode
  k: Kind
  /** 紫色 ◇（本輪插入／完成）；mark = 舊輪插入、未完成：一般樣式 + 標題前淡色 ◇ */
  ins: boolean
  /** 本輪剛記錄（圖示外圈擴散三次） */
  fresh: boolean
  mark: boolean
  /** 右邊的狀態字與顏色（主題色名稱）；空 = 不顯示 */
  status: string
  statusColor?: 'claude' | 'warning'
  /** 負責人 · 用時 */
  info: string
  /** 第二行：插入的時間 · 用戶的話；未能開始時「← 待 A、B」 */
  sub: string
}
export type PaneCard = { key: string; head: string; headIcon?: Kind; headDim: boolean; rows: PaneRow[]; note?: string }

/** 階段卡的內容：[已完成 9 項]（收起；展開時列出）→ 階段 1…（每層一張）→ [稍後 5 項]。 */
export function paneCards(map: WorkflowMap, view: StageView, o: { lang: Lang; doneOpen: boolean; clock?: Clock }): PaneCard[] {
  const c = o.clock ?? NO_CLOCK
  const t = STR[o.lang]
  const ready = readyIds(map.nodes)
  const byId = new Map(map.nodes.map(n => [n.id, n]))
  const row = (n: WorkflowNode): PaneRow => {
    const k = kindOf(n, ready, c)
    const waiting = n.deps.map(d => byId.get(d)).filter((d): d is WorkflowNode => !!d && isStep(d) && d.status !== 'done')
    const sub = [
      n.inserted && (insHot(n, c) || insMark(n, c)) ? [fmtTime(n.inserted.at), n.inserted.note].filter(Boolean).join(' · ') : '',
      (k === 'todo' || k === 'blocked') && waiting.length ? `← ${t.waitShort(waiting.map(d => d.title).join(t.list))}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const status = k === 'doing' ? t.status.doing : k === 'stale' ? t.stale : k === 'blocked' ? t.status.blocked : k === 'ready' ? t.ready : ''
    const statusColor = k === 'doing' ? 'claude' : k === 'blocked' || k === 'stale' ? 'warning' : undefined
    return { n, k, ins: insHot(n, c), fresh: insFresh(n, c), mark: insMark(n, c), status, statusColor, info: metaOf(n, o.lang, c), sub }
  }
  const cards: PaneCard[] = []
  if (view.done.length) {
    const open = o.doneOpen || !view.foldDone
    cards.push({ key: 'done', head: t.doneStage(view.done.length), headIcon: open ? undefined : 'done', headDim: false, rows: open ? view.done.map(row) : [] })
  }
  view.levels.forEach((lv, i) => cards.push({ key: `stage:${i}`, head: t.stage(i + 1, lv.length), headDim: false, rows: lv.map(row) }))
  if (view.later.length) cards.push({ key: 'later', head: t.laterStage(view.later.length), headDim: true, rows: [], note: view.later.map(n => n.title).join(' · ') })
  return cards
}

/** 一步的詳情（按「詳情」後在該步下面列出）：用戶原話、等待／完成後可開始、負責人、時間、狀態紀錄。 */
export function detailLines(map: WorkflowMap, n: WorkflowNode, lang: Lang, c: Clock = NO_CLOCK): string[] {
  const t = STR[lang]
  const byId = new Map(map.nodes.map(m => [m.id, m]))
  const after = map.nodes.filter(m => m.deps.includes(n.id)).map(m => m.title)
  const min = c.now ? elapsedMin(n, c.now) : undefined
  const times = [n.startedAt ? `${t.dStarted} ${fmtTime(n.startedAt)}` : '', n.doneAt ? `${t.dDone} ${fmtTime(n.doneAt)}` : '', min === undefined ? '' : t.dur(min)]
  const log = (n.log ?? []).slice(-5).map(e => `${fmtTime(e.at).slice(6)} ${t.status[e.status]}${e.by ? ` (${e.by})` : ''}`)
  return [
    n.inserted ? `${t.dWords}${n.inserted.note}${fmtTime(n.inserted.at) ? ` (${fmtTime(n.inserted.at)})` : ''}` : '',
    impactText(map, n, lang),
    n.deps.length ? `${t.dWaits}${n.deps.map(d => byId.get(d)?.title ?? d).join(t.list)}` : '',
    after.length ? `${t.dUnblocks}${after.join(t.list)}` : '',
    n.owner ? `${t.dOwner}${n.owner}` : '',
    times.filter(Boolean).join(' · '),
    n.note ?? '',
    log.length ? `${t.dLog}${log.join(' → ')}` : '',
  ].filter(Boolean)
}
