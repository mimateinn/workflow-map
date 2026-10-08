import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WorkflowMap, WorkflowNode } from '../types/index'
import { DEMO_MAP } from './demo'
import { allDone, applyOp, columns, compactLine, emptyMap, GLYPH, isActive, plainLines, readyIds, STATUSES, textDiagram, validateMap } from './graph'
import type { Op } from './graph'
import { pickLang, STR } from './i18n'
import type { Lang } from './i18n'
import { capsRow, insertIcon, metroSvg, pendingDot, progressSvg, statusIcon, summaryCaps, summaryText } from './svg'

const TOOL = 'mcp__workflow-map__workflow_map'
const PANE = 'workflow-map'
const FILE = '.claude/workflow-map.json'

const MAP = atom({ plugin: 'workflow-map', key: 'map' } as const, emptyMap())
const EXPANDED = atom({ plugin: 'workflow-map', key: 'expanded' } as const, false)
const PENDING = atom({ plugin: 'workflow-map', key: 'pending' } as const, false)
const DONE_TURNS = atom({ plugin: 'workflow-map', key: 'doneTurns' } as const, 0)
/** /workflow-demo：只在畫面顯示示範資料，不寫檔、不碰真資料 */
const DEMO = atom({ plugin: 'workflow-map', key: 'demo' } as const, false)
const DONE_OPEN = atom({ plugin: 'workflow-map', key: 'doneOpen' } as const, false)
/** 次要文字色：深色背景約 4.9:1、白底約 3.4:1（types 沒有主題 API，以使用者的深色主題為準） */
const DIM = '#8e8e96'
const INS_ICON = insertIcon()
const PENDING_DOT = pendingDot()
/** 桌面版一格字約多少 px（types 沒有提供，保守估算） */
const CELL_PX = 7

const WORDING =
  "Titles and notes: in the user's own language (its written form), concise, plain words, no jargon or file names; " +
  'titles at most 8 CJK characters or 20 Latin characters; notes at most 20 CJK or 60 Latin characters.'

const DESCRIPTION =
  'Live dependency graph of the current work, shown to the user as a metro-line diagram and saved to .claude/workflow-map.json. ' +
  'ops: set_plan {nodes} replaces the plan; upsert {nodes} adds/updates (only given fields change); status {id,status,note?}; ' +
  'insert {nodes,note,before?} records work the USER interjected mid-plan (note = what they asked; deps = what it must wait for; ' +
  'before = existing node ids that must now wait for it); remove {ids}; show. ' +
  'Node: {id, title, status: todo|doing|done|blocked|dropped, deps: [ids it waits for], lane?, note?}. ' +
  'Steps sharing no deps path run in parallel. Cycles and unknown deps are rejected. Returns the graph as text. ' +
  WORDING

const SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['set_plan', 'upsert', 'status', 'insert', 'remove', 'show'] },
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

const GUIDE =
  `# Workflow map\nWhen work has 3+ steps, keep the user's workflow map current with the ${TOOL} tool: set_plan at the start ` +
  '(deps honest: independent steps share no deps so they show as parallel), status doing/done as you go. ' +
  'When the user sends something mid-plan that is not already in the plan, FIRST record it with op insert ' +
  '(note = what they asked; deps = what it waits for, none if independent; before = steps that must now wait for it), then act on it. ' +
  WORDING

const HINT =
  `[workflow-map] A plan is in progress. If this message asks for something not already in the plan, record it first with ${TOOL} op "insert".`

type $ = EngineInterface

/** userConfig `language`：auto | zh-Hant | en（每次載入由 register 設定） */
let languageSetting: unknown = 'auto'
const langOf = (map: WorkflowMap): Lang => pickLang(languageSetting, map.nodes.map(n => n.title).join(''))

/** 示範資料的插入時間按現在推算（40 分鐘前、5 分鐘前…），只在畫面使用 */
async function demoMap($: $): Promise<WorkflowMap> {
  const now = await $.clock.now()
  const ago = [40, 5, 20, 12]
  let i = 0
  return {
    ...DEMO_MAP,
    nodes: DEMO_MAP.nodes.map(n =>
      n.inserted ? { ...n, inserted: { ...n.inserted, at: new Date(now - (ago[i++ % ago.length] ?? 10) * 60_000).toISOString() } } : n,
    ),
  }
}
const shownMap = async ($: $) => ((await read($, DEMO)) ? demoMap($) : read($, MAP))

async function filePath($: $): Promise<string> {
  return `${(await $.session.root()).replace(/[\\/]+$/, '')}/${FILE}`
}

const nowIso = async ($: $) => new Date(await $.clock.now()).toISOString()

/**
 * 從檔案讀取（單一真相）。無檔 → 空圖。損壞 → 原文備份為 .bad-<ts>.json、寫入空圖、提示一次。
 * 讀取失敗（IO 錯誤）則拋出，不覆寫檔案。
 */
export async function loadMap($: $): Promise<WorkflowMap> {
  const path = await filePath($)
  if (!(await $.fs.exists(path))) return emptyMap()
  const text = await $.fs.read(path)
  let problem: string
  try {
    const v = validateMap(JSON.parse(text))
    if (typeof v !== 'string') return v
    problem = v
  } catch {
    problem = 'invalid JSON'
  }
  const stamp = (await nowIso($)).replace(/[:.]/g, '-')
  const backup = path.replace(/\.json$/, `.bad-${stamp}.json`)
  await $.fs.write(backup, text)
  const empty = emptyMap()
  await $.fs.write(path, `${JSON.stringify(empty, null, 2)}\n`)
  $.ui.toast(STR[pickLang(languageSetting, text)].corrupt(problem, backup.split('/').pop() ?? backup))
  return empty
}

const openPane = ($: $, lang: Lang) => $.ui.open({ id: PANE, title: STR[lang].paneTitle })

export const register: Register = (on, options) => {
  languageSetting = (options as { language?: unknown } | undefined)?.language ?? 'auto'

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'workflow_map', description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false })
    const expanded = (await $.store.get('expanded')) === true
    await update($, EXPANDED, () => expanded)
    let map = emptyMap()
    try {
      map = await loadMap($)
      await update($, MAP, () => map)
    } catch (err) {
      $.ui.toast(STR[pickLang(languageSetting, '')].readFail(String(err).slice(0, 200)))
    }
    const t = STR[langOf(map)]
    await $.command
      .register({ name: 'workflow', description: t.commandDesc })
      .catch(() => $.command.register({ name: 'workflow-map', description: t.commandDesc }))
    await $.command.register({ name: 'workflow-demo', description: t.demoDesc }).catch(() => undefined)
    let lastMtime = -1
    $.clock.every(3000, async () => {
      try {
        const path = await filePath($)
        const st = await $.fs.stat(path)
        if (st.mtimeMs === lastMtime) return
        lastMtime = st.mtimeMs
        const v = validateMap(JSON.parse(await $.fs.read(path)))
        if (typeof v === 'string') return
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

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!e.tools.includes(TOOL)) return r
    return { sections: [...r.sections, { id: 'workflow-map:guide', text: GUIDE, scope: 'session' as const }] }
  })

  // 安全網：計劃進行中用戶再發訊息 → 標示「未記錄」並提示模型一句；不自動新增步驟。
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || !isActive(await read($, MAP))) return next(e)
    await update($, PENDING, () => true)
    return next({ ...e, context: [...(e.context ?? []), HINT] })
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (await read($, PENDING)) await update($, PENDING, () => false)
      const done = allDone(await read($, MAP))
      await update($, DONE_TURNS, n => (done ? n + 1 : 0))
    }
    return next(e)
  })

  on('command.run', { command: 'workflow-demo' }, async $ => {
    const isOn = !(await read($, DEMO))
    await update($, DEMO, () => isOn)
    const t = STR[langOf(isOn ? DEMO_MAP : await read($, MAP))]
    return { text: isOn ? t.demoOn : t.demoOff }
  })

  on('command.run', { command: ['workflow', 'workflow-map'] }, async $ => {
    const map = await shownMap($)
    const lang = langOf(map)
    await openPane($, lang)
    return { text: map.nodes.length ? `${STR[lang].paneOpened} ${compactLine(map, lang)}` : STR[lang].empty }
  })

  // 輸入框上方。收起：一行膠囊（進度膠囊 → 進行中 → 下一步 → 插入）；展開：地鐵線 + 膠囊（≤ 3 條線）。
  // 右邊：一個隨狀態切換的圖示按鈕（▾ 展開／▴ 收起）；有放不下的步驟時多一個「+N」按鈕開全圖。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const map = await shownMap($)
    if (map.nodes.length === 0) return next(e)
    // 全部完成後只顯示一輪，之後隱藏
    if (allDone(map) && (await read($, DONE_TURNS)) >= 2) return next(e)
    const lang = langOf(map)
    const t = STR[lang]
    const expanded = await read($, EXPANDED)
    const pending = await read($, PENDING)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const lines = plainLines(map, lang)
    // 圖可用的闊度：欄數 × CELL_PX，扣去右邊按鈕；types 沒有橫向捲動，放不下的收成「+N」按鈕
    const room = Math.max(200, Math.round((e.props.bodyColumns || 100) * CELL_PX) - 90)

    const controls = (hidden: number) => (
      <Box flexDirection="row" gap={1} flexShrink={0} paddingRight={1}>
        {pending && (expanded || !Svg) ? (
          Svg ? <Svg source={PENDING_DOT.source} alt={t.unloggedTip} width={14} height={14} /> : <Text color="warning">●</Text>
        ) : null}
        {hidden > 0 ? <Button key="more" plain label={`+${hidden}`} onPress={() => openPane($, lang)} /> : null}
        <Button key="toggle" plain label={expanded ? '▴' : '▾'} onPress={() => toggle($)} />
      </Box>
    )

    if (!Svg) {
      const shown = expanded ? lines.slice(0, 6) : []
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Box flexShrink={1} flexGrow={1}>
              <Text wrap="truncate-end">{summaryText(map, pending, lang)}</Text>
            </Box>
            {controls(expanded ? lines.length - shown.length : 0)}
          </Box>
          {shown.map(line => (
            <Text wrap="truncate-end">{line}</Text>
          ))}
        </Box>
      )
    }

    const pic = expanded
      ? metroSvg(map, { lanes: 3, maxWidth: room, compact: true, lang })
      : capsRow(summaryCaps(map, pending, lang), room)
    return (
      <Box flexDirection="row" gap={1} alignItems="flex-start">
        <Box flexShrink={1} overflow="hidden">
          {/* 圖片模式（非 isInteractive）：透明底；寬高 = viewBox，1:1 不縮放 */}
          <Svg source={pic.source} alt={[compactLine(map, lang), ...lines].join('\n')} width={pic.width} height={pic.height} />
        </Box>
        <Box flexGrow={1} />
        {controls(pic.hidden)}
      </Box>
    )
  })

  // 全圖面板：標題 + 進度條 → 完整地鐵圖（放不下就換段，保證全部步驟都畫）→ 進行中／接下來／已完成三組短清單。
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const map = await shownMap($)
    const lang = langOf(map)
    const t = STR[lang]
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    if (map.nodes.length === 0) return <Text color={DIM}>{t.empty}</Text>
    const doneOpen = await read($, DONE_OPEN)
    const pending = await read($, PENDING)
    const byId = new Map(map.nodes.map(n => [n.id, n]))
    const ready = readyIds(map.nodes)
    const order = columns(map.nodes).flat()
    const doing = order.filter(n => n.status === 'doing')
    const upNext = order.filter(n => n.status === 'todo' || n.status === 'blocked')
    const done = order.filter(n => n.status === 'done')
    const total = map.nodes.filter(n => n.status !== 'dropped').length
    const paneRoom = Math.max(320, Math.round(((e.props as { bodyColumns?: number }).bodyColumns ?? 120) * CELL_PX) - 24)
    const barW = Math.min(200, Math.max(80, paneRoom - 260))

    const kindOf = (n: WorkflowNode) => (n.status === 'todo' && ready.has(n.id) ? 'ready' : n.status)
    const row = (n: WorkflowNode) => {
      const waiting = n.deps.map(d => byId.get(d)).filter(d => d && d.status !== 'done' && d.status !== 'dropped')
      const sub = [
        n.inserted ? [fmtTime(n.inserted.at), n.inserted.note].filter(Boolean).join(' · ') : '',
        (n.status === 'todo' || n.status === 'blocked') && waiting.length ? t.waitShort(waiting.map(d => d!.title).join(t.list)) : '',
      ]
        .filter(Boolean)
        .join(' · ')
      const icon = statusIcon(kindOf(n))
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            {Svg ? <Svg source={icon.source} alt={t.status[n.status]} width={16} height={16} /> : <Text>{GLYPH[n.status]}</Text>}
            {n.inserted ? Svg ? <Svg source={INS_ICON.source} alt={t.insertCount} width={16} height={16} /> : <Text>⊕</Text> : null}
            <Text wrap="truncate-end">{n.title}</Text>
          </Box>
          {sub ? (
            <Box paddingLeft={3}>
              <Text color={DIM} wrap="truncate-end">
                {sub}
              </Text>
            </Box>
          ) : null}
        </Box>
      )
    }
    const section = (title: string, nodes: WorkflowNode[]) =>
      nodes.length === 0 ? null : (
        <Box flexDirection="column">
          <Text bold>
            {title} <Text color={DIM}>{nodes.length}</Text>
          </Text>
          {nodes.map(row)}
        </Box>
      )
    const metro = Svg ? metroSvg(map, { lanes: 99, maxWidth: paneRoom, compact: false, lang, wrap: true }) : undefined
    const latest = done.slice(-3).reverse()

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          {Svg ? <Svg source={progressSvg(map, barW).source} alt={t.progressTip(done.length, total)} width={barW} height={10} /> : null}
          <Text>
            {done.length}/{total}
          </Text>
        </Box>
        {pending ? (
          <Box flexDirection="row" gap={1} alignItems="center">
            {Svg ? <Svg source={PENDING_DOT.source} alt="" width={14} height={14} /> : <Text color="warning">●</Text>}
            <Text color={DIM}>{t.unloggedTip}</Text>
          </Box>
        ) : null}
        {metro && Svg ? <Svg source={metro.source} alt={plainLines(map, lang).join('\n')} width={metro.width} height={metro.height} /> : null}
        {section(t.secDoing, doing)}
        {section(t.secNext, upNext)}
        {done.length ? (
          <Box flexDirection="column">
            <Button key="done-toggle" plain label={doneOpen ? `${t.doneCount(done.length)} ▴` : `${t.doneCount(done.length)} ▾`} onPress={() => update($, DONE_OPEN, v => !v)} />
            {(doneOpen ? done : latest).map(row)}
          </Box>
        ) : null}
      </Box>
    )
  })
}

async function serveTool($: $, e: Record<string, unknown>): Promise<{ deny: string } | { result: string }> {
  const { tool: _t, tool_use_id: _u, agentId: _a, ...args } = e
  const op = args as unknown as Op
  let map: WorkflowMap
  try {
    map = await loadMap($)
  } catch (err) {
    return { deny: `Could not read ${FILE}; nothing was changed: ${String(err).slice(0, 300)}` }
  }
  const r = applyOp(map, op, await nowIso($))
  if ('error' in r) return { deny: r.error }
  if (op.op !== 'show') await $.fs.write(await filePath($), `${JSON.stringify(r.map, null, 2)}\n`)
  await update($, MAP, () => r.map)
  if (await read($, PENDING)) await update($, PENDING, () => false)
  return { result: [r.info, textDiagram(r.map, 60, langOf(r.map))].filter(Boolean).join('\n') }
}

async function toggle($: $) {
  const v = !(await read($, EXPANDED))
  await update($, EXPANDED, () => v)
  await $.store.set('expanded', v)
}

/** ISO → 本地 MM-DD HH:MM；缺少或無效（含 1970 起點）時回傳空字串，不顯示時間。 */
function fmtTime(iso: string | undefined): string {
  const d = new Date(iso ?? '')
  if (!iso || Number.isNaN(d.getTime()) || d.getTime() <= 86_400_000) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
