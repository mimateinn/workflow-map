/**
 * 終端機（CLI）版的畫法：標題行的字元進度條與卡片圖，全部以「格」計（CJK = 2 格，見 suggest.ts 的 cells）。
 * 純函數：只出「一段段帶顏色的字」，介面元素（Box／Text）由 register 組裝。顏色一律用 app 主題的鍵
 * （success／claude／warning／merged／subtle），跟用戶自己的終端機主題走，不寫死色碼。
 * 規則與桌面版相同：同層並行的步驟一張卡、已完成收成「✓ N 已完成」、放不下的收成虛線「+N 稍後」卡；
 * 線只畫在兩端都有卡時（沒有懸空的線）。
 */
import type { WorkflowMap, WorkflowNode } from '../types/index'
import { columns, readyIds } from './graph'
import type { StageView } from './graph'
import { STR } from './i18n'
import type { Lang } from './i18n'
import { cells, fitCells } from './suggest'
import { headline, kindOf, metaOf } from './svg'
import type { Clock, Kind } from './svg'

/** 一段字；color 是主題鍵 */
export type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean }

export const segCells = (segs: readonly Seg[]) => segs.reduce((n, s) => n + cells(s.text), 0)

/** 狀態符號：✓ 完成、◉ 進行中（久未更新變琥珀）、○ 未開始（可開始的較亮）、! 受阻；用戶插入的步驟用菱形 ◇／◆ */
export function glyph(k: Kind, ins: boolean): Seg {
  if (ins) {
    if (k === 'done') return { text: '◆', color: 'merged' }
    return { text: '◇', color: k === 'doing' ? 'claude' : k === 'blocked' || k === 'stale' ? 'warning' : 'merged' }
  }
  if (k === 'done') return { text: '✓', color: 'success' }
  if (k === 'doing') return { text: '◉', color: 'claude' }
  if (k === 'stale') return { text: '◉', color: 'warning' }
  if (k === 'blocked') return { text: '!', color: 'warning', bold: true }
  return k === 'ready' ? { text: '○' } : { text: '○', dim: true }
}

const paint = (s: WorkflowNode['status']) => (s === 'done' ? 'success' : s === 'doing' ? 'claude' : s === 'blocked' ? 'warning' : 'subtle')

/**
 * 分段進度條（━）：每步一段、段與段之間空一格（完成 → 進行中 → 受阻 → 未開始）；
 * 每段不夠 2 格時，同狀態併成連續一段，按步數比例分格。
 */
export function barSegs(map: WorkflowMap, width: number): Seg[] {
  const order = { done: 0, doing: 1, blocked: 2, todo: 3, dropped: 4 } as const
  const steps = columns(map.nodes.filter(n => n.status !== 'dropped'))
    .flat()
    .sort((a, b) => order[a.status] - order[b.status])
  const n = steps.length
  if (n === 0 || width < 1) return [{ text: '━'.repeat(Math.max(0, width)), color: 'subtle' }]
  const per = Math.floor((width - (n - 1)) / n)
  if (per >= 2) return steps.flatMap((s, i) => [...(i ? [{ text: ' ' }] : []), { text: '━'.repeat(per), color: paint(s.status) }])
  const runs: { s: WorkflowNode['status']; k: number }[] = []
  for (const s of steps) {
    const last = runs[runs.length - 1]
    if (last && last.s === s.status) last.k++
    else runs.push({ s: s.status, k: 1 })
  }
  const out: Seg[] = []
  let done = 0
  let used = 0
  for (const r of runs) {
    done += r.k
    const end = Math.max(used + 1, Math.round((width * done) / n))
    out.push({ text: '━'.repeat(end - used), color: paint(r.s) })
    used = end
  }
  return out
}

/**
 * 標題行：左 = 狀態符號 + 名稱（+N）+「下一步：…」（放得下才有）；右 = 進度條 + 5/12 + ≈ 時間（+ 琥珀 ●）。
 * cols = 這一行可用的格數（已扣去右邊的按鈕）。
 */
export function headerSegs(map: WorkflowMap, view: StageView, lang: Lang, clk: Clock, cols: number, pending: boolean, eta: string) {
  const t = STR[lang]
  const h = headline(map, view, lang, clk)
  const s = map.nodes.filter(n => n.status !== 'dropped')
  const count = `${s.filter(n => n.status === 'done').length}/${s.length}`
  const tail: Seg[] = [{ text: ' ' }, { text: count, bold: true }, ...(eta ? [{ text: ` ${eta}`, dim: true }] : []), ...(pending ? [{ text: ' ●', color: 'warning' }] : [])]
  const name = fitCells(h.name, Math.max(8, Math.floor(cols * 0.4)))
  const left: Seg[] = [glyph(h.k, h.ins), { text: ' ' }, { text: name, bold: h.k !== 'done' }, ...(h.plus ? [{ text: ` +${h.plus}`, dim: true }] : [])]
  // 進度條至少 10 格；「下一步」只在進度條仍有 16 格時出現
  const room = cols - segCells(left) - segCells(tail) - 2 - 16 - 2
  if (h.next.length && room >= 12) {
    let next = fitCells(`${t.upNext}${h.next[0]}`, Math.min(room, 48))
    for (const more of h.next.slice(1)) {
      const longer = `${next} · ${more}`
      if (cells(longer) > Math.min(room, 48)) break
      next = longer
    }
    left.push({ text: `  ${next}`, dim: true })
  }
  const barW = Math.max(10, Math.min(36, cols - segCells(left) - segCells(tail) - 2))
  return { left, right: [...barSegs(map, barW), ...tail] }
}

/** 卡：外框字元（虛線卡用 ┄ ┆）、每行 = [左框][空格][內容][補空格][空格][右框]；第 1 行的左右框可換成接口 ┤ ├ */
type TCard = { rows: Seg[][]; w: number; h: number; hot: boolean; dashed: boolean }

function tcard(rows: Seg[][], hot: boolean, dashed = false): TCard {
  const inner = Math.max(...rows.map(segCells))
  return { rows, w: inner + 4, h: rows.length + 2, hot, dashed }
}

function cardLines(c: TCard, inPort: boolean, outPort: boolean): Seg[][] {
  const inner = c.w - 4
  const edge = c.dashed ? { dim: true } : { color: 'subtle' }
  const [hz, vt] = c.dashed ? ['┄', '┆'] : ['─', '│']
  return [
    [{ text: `╭${hz.repeat(c.w - 2)}╮`, ...edge }],
    ...c.rows.map((r, i) => [
      { text: i === 0 && inPort ? '┤' : vt, ...edge },
      { text: ' ' },
      ...r,
      { text: ' '.repeat(inner - segCells(r) + 1) },
      { text: i === 0 && outPort ? '├' : vt, ...edge },
    ]),
    [{ text: `╰${hz.repeat(c.w - 2)}╯`, ...edge }],
  ]
}

/** 卡與卡之間的線（格） */
const LINK = 3

/**
 * 展開時的卡片圖：[✓ N 已完成]──[同層並行一張卡]──…┄┄[+N 稍後]，卡頂對齊，線接在第一行。
 * 放不下 cols 格的層收進「稍後」（不會在卡中間換行）。回傳每一行的字段。
 */
export function bandCards(map: WorkflowMap, view: StageView, lang: Lang, clk: Clock, cols: number) {
  const t = STR[lang]
  const ready = readyIds(map.nodes)
  // 一行一步：[符號] [名稱（補空格，令同一張卡的「負責人 · 用時」對齊）]  [負責人 · 用時]
  const stepRow = (n: WorkflowNode, titleW: number): Seg[] => {
    const k = kindOf(n, ready, clk)
    const meta = fitCells(metaOf(n, lang, clk), 16)
    const title = fitCells(n.title, 22)
    return [glyph(k, !!n.inserted), { text: ' ' }, { text: meta ? title + ' '.repeat(titleW - cells(title)) : title, dim: k === 'todo' }, ...(meta ? [{ text: `  ${meta}`, dim: true }] : [])]
  }
  const levels = view.levels.map(lv => {
    const shown = lv.length > 3 ? lv.slice(0, 2) : lv
    const titleW = Math.max(...shown.map(n => cells(fitCells(n.title, 22))))
    const rows = shown.map(n => stepRow(n, titleW))
    if (lv.length > 3) rows.push([{ text: '  ' }, { text: t.moreRows(lv.length - 2), dim: true }])
    return { c: tcard(rows, lv.some(n => n.status === 'doing')), steps: lv }
  })
  const done = view.done.length ? tcard([[glyph('done', false), { text: ` ${t.doneCard(view.done.length)}` }]], false) : undefined
  const ghostW = (n: number) => cells(t.laterCard(n)) + 4
  const placed: TCard[] = []
  const hiddenSteps: WorkflowNode[] = []
  let used = done ? done.w + LINK : 0
  levels.forEach(({ c, steps }, i) => {
    const rest = levels.slice(i + 1).reduce((n, x) => n + x.steps.length, 0) + view.later.length
    const fits = used + c.w + (rest ? LINK + ghostW(rest + steps.length) : 0) <= cols
    if (hiddenSteps.length || (placed.length && !fits)) return void hiddenSteps.push(...steps)
    placed.push(c)
    used += c.w + LINK
  })
  hiddenSteps.push(...view.later)
  const hidden = hiddenSteps.filter((n, i, a) => a.indexOf(n) === i)
  const ghost = hidden.length ? tcard([[{ text: t.laterCard(hidden.length), dim: true }]], false, true) : undefined
  // 一串卡，相鄰兩張之間一條線：實線（下一張有進行中 → 強調色）；接到幽靈卡的是虛線
  const chain = [done, ...placed, ghost].filter((c): c is TCard => !!c)
  const links = chain.slice(1).map(c => (c.dashed ? { text: '┄'.repeat(LINK), dim: true } : { text: '─'.repeat(LINK), color: c.hot ? 'claude' : 'subtle' }))
  const drawn = chain.map((c, i) => cardLines(c, i > 0, i < chain.length - 1))
  const height = Math.max(0, ...chain.map(c => c.h))
  const lines: Seg[][] = []
  for (let y = 0; y < height; y++) {
    const line: Seg[] = []
    chain.forEach((c, i) => {
      line.push(...(drawn[i]![y] ?? [{ text: ' '.repeat(c.w) }]))
      if (i < links.length) line.push(y === 1 ? links[i]! : { text: ' '.repeat(LINK) })
    })
    // 行尾的空白不畫（免得窄終端機換行）
    while (line.length && line[line.length - 1]!.text.trim() === '') line.pop()
    lines.push(line)
  }
  return { lines, cards: placed.length, links: links.length, hidden, width: Math.max(0, ...lines.map(segCells)) }
}
