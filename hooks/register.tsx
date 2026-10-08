import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WorkflowMap, WorkflowNode } from '../types/index'
import { DEMO_MAP } from './demo'
import { allDone, applyOp, compactLine, emptyMap, GLYPH, isActive, plainLines, readyIds, STATUSES, stageView, stats, textDiagram, validateMap } from './graph'
import type { Op } from './graph'
import { detectLang, resolveLang, STR } from './i18n'
import type { Lang } from './i18n'
import { bandGraph, bandHeader, fmtTime, PANE_PX_PER_COL, paneMeter, paneStages, PX_PER_COL, THEMES, tw } from './svg'

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
const FUTURE_OPEN = atom({ plugin: 'workflow-map', key: 'futureOpen' } as const, false)
/** 本輪開始時間：本輪新插入的步驟在聚焦時一定顯示 */
const TURN_AT = atom({ plugin: 'workflow-map', key: 'turnAt' } as const, 0)
/** 聚焦的展開狀態在計劃改變、重開全圖時回到收起 */
const foldAll = async ($: $) => {
  if (await read($, DONE_OPEN)) await update($, DONE_OPEN, () => false)
  if (await read($, FUTURE_OPEN)) await update($, FUTURE_OPEN, () => false)
}
/** app 主題是淺色（/config 的 theme 含 light）；Svg 以圖片繪製讀不到主題，所以自己記住 */
const LIGHT = atom({ plugin: 'workflow-map', key: 'light' } as const, false)

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

async function refreshTheme($: $) {
  try {
    const v = (await $.config.list()).find(r => r.key === 'theme')?.value
    const light = typeof v === 'string' && v.includes('light')
    if (light !== (await read($, LIGHT))) await update($, LIGHT, () => light)
  } catch {
    // 讀不到設定：維持深色
  }
}
const themeOf = async ($: $) => THEMES[(await read($, LIGHT)) ? 'light' : 'dark']

/** userConfig `language`：auto | zh-Hant | zh-Hans | en（每次載入由 register 設定） */
let languageSetting: unknown = 'auto'
/** 用戶最近一次輸入的文字判斷出的語言（存在 $.store，跨 session） */
const LANG = atom({ plugin: 'workflow-map', key: 'lang' } as const, '')
/**
 * $.store 的鍵帶版本：舊鍵 'lang' 由有問題的偵測寫入（子代理的簡體文字也算），一律棄用。
 * 偵測規則再改時把版本加一。
 */
const LANG_KEY = 'langV2'
/** 設定 → 用戶輸入過的語言 → 計劃步驟名稱的文字（弱證據：模型用用戶的語言寫）→ 英文 */
const langNow = async ($: $): Promise<Lang> =>
  resolveLang(languageSetting, await read($, LANG), detectLang((await shownMap($)).nodes.map(n => n.title).join(' ')))

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
  $.ui.toast(STR[await langNow($)].corrupt(problem, backup.split('/').pop() ?? backup))
  return empty
}

const openPane = ($: $, lang: Lang) => $.ui.open({ id: PANE, title: STR[lang].paneTitle })

export const register: Register = (on, options) => {
  languageSetting = (options as { language?: unknown } | undefined)?.language ?? 'auto'

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'workflow_map', description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false })
    await refreshTheme($)
    const expanded = (await $.store.get('expanded')) === true
    await update($, EXPANDED, () => expanded)
    const storedLang = await $.store.get(LANG_KEY)
    if (typeof storedLang === 'string') await update($, LANG, () => storedLang)
    let map = emptyMap()
    try {
      map = await loadMap($)
      await update($, MAP, () => map)
    } catch (err) {
      $.ui.toast(STR[await langNow($)].readFail(String(err).slice(0, 200)))
    }
    const t = STR[await langNow($)]
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

  on('config.set', async ($, e, next) => {
    const r = await next(e)
    if (e.key === 'theme') await refreshTheme($)
    return r
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!e.tools.includes(TOOL)) return r
    return { sections: [...r.sections, { id: 'workflow-map:guide', text: GUIDE, scope: 'session' as const }] }
  })

  // 安全網：計劃進行中用戶再發訊息 → 標示「未記錄」並提示模型一句；不自動新增步驟。
  // 只算用戶親手輸入的訊息（composer／bridge）：子代理通知、其他 session、排程、外掛的文字都不算，
  // 否則它們的簡體字會把介面語言改走，亦會誤標「新要求未記錄」。
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    // 介面語言跟用戶：以用戶最近一次輸入的文字判斷，存起來（不看模型寫的步驟名稱）
    const detected = detectLang(e.text)
    if (detected && detected !== (await read($, LANG))) {
      await update($, LANG, () => detected)
      await $.store.set(LANG_KEY, detected)
    }
    if (!isActive(await read($, MAP))) return next(e)
    await update($, PENDING, () => true)
    return next({ ...e, context: [...(e.context ?? []), HINT] })
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, TURN_AT, () => now)
    return next(e)
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
    const t = STR[await langNow($)]
    return { text: isOn ? t.demoOn : t.demoOff }
  })

  on('command.run', { command: ['workflow', 'workflow-map'] }, async $ => {
    const map = await shownMap($)
    const lang = await langNow($)
    await foldAll($)
    await openPane($, lang)
    return { text: map.nodes.length ? `${STR[lang].paneOpened} ${compactLine(map, lang)}` : STR[lang].empty }
  })

  // 輸入框上方。收起：一行「● 進行中  接下來：…  ━━━── 6/11」；展開：再加一行 GitHub Actions 式卡片圖。
  // 右邊固定兩個控制：展開／收起、開全圖。數字都在圖內，不是按鈕。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const map = await shownMap($)
    if (map.nodes.length === 0) return next(e)
    // 全部完成後只顯示一輪，之後隱藏
    if (allDone(map) && (await read($, DONE_TURNS)) >= 2) return next(e)
    const lang = await langNow($)
    const t = STR[lang]
    const expanded = await read($, EXPANDED)
    const pending = await read($, PENDING)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const controls = (
      <Box key="ctl" flexDirection="row" flexShrink={0} gap={1}>
        <Button key="toggle" plain dimColor label={expanded ? '▴' : '▾'} onPress={() => toggle($)} />
        <Button key="open" plain dimColor label="↗" onPress={() => openPane($, lang)} />
      </Box>
    )

    if (!Svg) {
      const shown = expanded ? plainLines(map, lang).slice(0, 6) : []
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Box flexShrink={1} flexGrow={1}>
              <Text wrap="truncate-end">{compactLine(map, lang)}</Text>
            </Box>
            {pending ? <Text color="warning">●</Text> : null}
            {controls}
          </Box>
          {shown.map(line => (
            <Text wrap="truncate-end">{line}</Text>
          ))}
        </Box>
      )
    }

    const T = await themeOf($)
    const view = stageView(map, { freshSince: await read($, TURN_AT) })
    // 可用闊度：欄數 × 每格 px（寧小勿大），扣去兩個按鈕
    const avail = Math.max(240, Math.round((e.props.bodyColumns || 100) * PX_PER_COL) - 56)
    const head = bandHeader(map, view, lang, T, avail, pending)
    const graph = expanded ? bandGraph(map, view, lang, T, avail + 56) : undefined
    const s = stats(map)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" alignItems="center" gap={1}>
          {/* 圖片模式（非 isInteractive）：透明底；寬高 = viewBox，1:1 不縮放。左右兩張圖之間由空白撐開，進度條永遠貼住按鈕 */}
          <Box flexShrink={1} overflow="hidden">
            <Svg source={head.lead.source} alt={compactLine(map, lang)} width={head.lead.width} height={head.lead.height} />
          </Box>
          <Box flexGrow={1} />
          <Box flexShrink={0}>
            <Svg
              source={head.meter.source}
              alt={[t.progressTip(s.done, s.total), pending ? t.unloggedTip : ''].filter(Boolean).join('\n')}
              width={head.meter.width}
              height={head.meter.height}
            />
          </Box>
          {controls}
        </Box>
        {graph ? (
          <Box>
            <Svg source={graph.source} alt={plainLines(map, lang).join('\n')} width={graph.width} height={graph.height} />
          </Box>
        ) : null}
      </Box>
    )
  })

  // 全圖面板：標題行（分段進度條撐滿 + 16 / 23 + 狀態；右邊兩個收放按鈕）→ 階段卡（由上而下，一張圖）。
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const map = await shownMap($)
    const lang = await langNow($)
    const t = STR[lang]
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    if (map.nodes.length === 0) return <Text dimColor>{t.empty}</Text>
    const doneOpen = await read($, DONE_OPEN)
    const futureOpen = await read($, FUTURE_OPEN)
    const turnAt = await read($, TURN_AT)
    const pending = await read($, PENDING)
    const view = stageView(map, { freshSince: turnAt, expandDone: doneOpen, expandFuture: futureOpen })
    // 收放按鈕只在有東西可收時出現（以「不展開」時的視圖判斷）
    const base = stageView(map, { freshSince: turnAt })
    const folds = [
      base.foldDone ? { key: 'fold-done', label: doneOpen ? t.hideDone : t.showDone, onPress: () => update($, DONE_OPEN, v => !v) } : undefined,
      base.later.length ? { key: 'fold-future', label: futureOpen ? t.hideLater : t.showLater, onPress: () => update($, FUTURE_OPEN, v => !v) } : undefined,
    ].filter(b => b !== undefined)
    const buttons = folds.map(b => <Button key={b.key} variant="secondary" label={b.label} onPress={b.onPress} />)
    const s = stats(map)

    if (!Svg) {
      const ready = readyIds(map.nodes)
      const row = (n: (typeof map.nodes)[number]) => (
        <Text wrap="truncate-end">
          {`  ${GLYPH[n.status]} ${n.title}${n.status === 'todo' && ready.has(n.id) ? ` (${t.ready})` : ''}${
            n.inserted ? `  ⊕ ${[fmtTime(n.inserted.at), n.inserted.note].filter(Boolean).join(' · ')}` : ''
          }`}
        </Text>
      )
      return (
        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Text>{`${s.done}/${s.total}`}</Text>
            {pending ? <Text color="warning">●</Text> : null}
            <Box flexGrow={1} />
            {buttons}
          </Box>
          {view.done.length ? <Text bold>{t.doneStage(view.done.length)}</Text> : null}
          {view.done.length && !(view.foldDone && !doneOpen) ? view.done.map(row) : null}
          {view.levels.map((lv, i) => (
            <Box flexDirection="column">
              <Text bold>{t.stage(i + 1, lv.length)}</Text>
              {lv.map(row)}
            </Box>
          ))}
          {view.later.length ? <Text dimColor>{`${t.laterStage(view.later.length)}: ${view.later.map(n => n.title).join(' · ')}`}</Text> : null}
        </Box>
      )
    }

    const T = await themeOf($)
    const paneW = Math.min(1400, Math.max(300, Math.round(((e.props as { bodyColumns?: number }).bodyColumns ?? 100) * PANE_PX_PER_COL) - 16))
    const buttonsW = folds.reduce((w, b) => w + tw(b.label) + 44, 0)
    const meter = paneMeter(map, lang, T, paneW - buttonsW, pending)
    const stages = paneStages(map, view, { lang, T, width: paneW, doneOpen })
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Box flexShrink={1} overflow="hidden">
            <Svg
              source={meter.source}
              alt={[t.progressTip(s.done, s.total), pending ? t.unloggedTip : ''].filter(Boolean).join('\n')}
              width={meter.width}
              height={meter.height}
            />
          </Box>
          <Box flexGrow={1} />
          {buttons}
        </Box>
        <Box>
          <Svg source={stages.source} alt={plainLines(map, lang).join('\n')} width={stages.width} height={stages.height} />
        </Box>
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
  if (op.op !== 'show') await foldAll($)
  if (await read($, PENDING)) await update($, PENDING, () => false)
  return { result: [r.info, textDiagram(r.map, 60, 'en')].filter(Boolean).join('\n') }
}

async function toggle($: $) {
  const v = !(await read($, EXPANDED))
  await update($, EXPANDED, () => v)
  await $.store.set('expanded', v)
}
