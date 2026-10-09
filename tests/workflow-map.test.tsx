import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { applyOp, columns, DONE_ID, downstreamOf, elapsedMin, emptyMap, etaRange, etaText, exportMarkdown, findCycle, focusedMap, focusSet, isStale, mergeMaps, migrate, MORE_ID, plainLines, planDiff, readyIds, stageView, stats, textDiagram, timeline, validateMap } from '../hooks/graph'
import { detectLang, LANGS, looksLikeRequest, resolveLang, STR } from '../hooks/i18n'
import { bandGraph, detailLines, esc, metaOf, ownerLabel, THEMES } from '../hooks/svg'
import { demoMap, teamMap } from '../hooks/demo'
import { flowOutline, flowStructure, flowSvg, gutterW, layoutFlow, packChains } from '../hooks/flow'
import type { WorkflowMap } from '../types/index'

const TOOL = 'mcp__workflow-map__workflow_map'
const NOW = '2026-10-08T10:00:00.000Z'
const ROOT = '/proj'
const FILE = `${ROOT}/.claude/workflow-map.json`

const ok = (r: ReturnType<typeof applyOp>): WorkflowMap => {
  if ('error' in r) throw new Error(r.error)
  return r.map
}

// A → (B ∥ C) → D
const plan = () =>
  ok(
    applyOp(
      emptyMap(),
      {
        op: 'set_plan',
        nodes: [
          { id: 'A', title: '讀需求', status: 'done' },
          { id: 'B', title: '寫 API', deps: ['A'], status: 'doing' },
          { id: 'C', title: '畫 UI', deps: ['A'] },
          { id: 'D', title: '整合測試', deps: ['B', 'C'] },
        ],
      },
      NOW,
    ),
  )

describe('graph', () => {
  test('topological columns group parallel nodes', () => {
    const cols = columns(plan().nodes).map(c => c.map(n => n.id))
    expect(cols).toEqual([['A'], ['B', 'C'], ['D']])
    expect([...readyIds(plan().nodes)]).toEqual(['C'])
    expect(textDiagram(plan())).toContain('∥')
  })

  test('a dependency cycle is rejected and nothing changes', () => {
    const r = applyOp(plan(), { op: 'upsert', nodes: [{ id: 'A', deps: ['D'] }] }, NOW)
    expect('error' in r && r.error).toMatch(/cycle/)
    expect(findCycle(plan().nodes)).toBeUndefined()
  })

  test('unknown deps are rejected', () => {
    const r = applyOp(plan(), { op: 'upsert', nodes: [{ id: 'E', title: 'x', deps: ['ZZ'] }] }, NOW)
    expect('error' in r).toBe(true)
  })

  test('insert marks inserted, wires before, and set_plan keeps it', () => {
    const m = ok(
      applyOp(plan(), { op: 'insert', note: '加深色模式', nodes: [{ id: 'X', title: '深色模式', deps: ['C'] }], before: ['D'] }, NOW),
    )
    const x = m.nodes.find(n => n.id === 'X')
    expect(x?.inserted).toEqual({ at: NOW, by: 'user', note: '加深色模式' })
    expect(m.nodes.find(n => n.id === 'D')?.deps).toEqual(['B', 'C', 'X'])
    // 再 set_plan 冇提 X：X 唔可以被靜靜刪
    const r = applyOp(m, { op: 'set_plan', nodes: [{ id: 'A', title: 'a' }] }, NOW)
    const after = ok(r)
    expect(after.nodes.map(n => n.id)).toEqual(['A', 'X'])
    expect(after.nodes.find(n => n.id === 'X')?.deps).toEqual([])
    expect('info' in r && r.info).toMatch(/Kept/)
  })

  test('upsert changes only the given fields', () => {
    const m = ok(applyOp(plan(), { op: 'upsert', nodes: [{ id: 'B', status: 'done' }] }, LATER))
    const b = m.nodes.find(n => n.id === 'B')!
    expect(b).toMatchObject({ id: 'B', title: '寫 API', status: 'done', deps: ['A'] })
    expect(b.updatedAt).toBe(LATER)
    // 沒改到的步驟不蓋新時間
    expect(m.nodes.find(n => n.id === 'C')?.updatedAt).toBe(NOW)
  })
})

const LATER = '2026-10-08T10:05:00.000Z'

describe('lifecycle and merge', () => {
  test('v1 file migrates forward without losing fields', () => {
    const v1 = { version: 1, updatedAt: NOW, nodes: [{ id: 'A', title: 'a', status: 'done' as const, deps: [], extra: 'kept' }] }
    const m = migrate(v1 as never, LATER)
    expect(m.from).toBe(1)
    expect(m.map).toMatchObject({ schemaVersion: 2, version: 1, title: '', createdAt: NOW, tombstones: [] })
    expect(m.map.planId).toMatch(/^p-/)
    expect(m.map.nodes[0]).toMatchObject({ id: 'A', extra: 'kept', updatedAt: NOW })
    expect(migrate(m.map, LATER).map).toBe(m.map)
  })

  test('set_plan after a finished plan archives it and never resurrects its inserted steps', () => {
    let m = ok(applyOp(plan(), { op: 'insert', note: 'x', nodes: [{ id: 'X', title: '插入' }] }, NOW))
    for (const id of ['B', 'C', 'D', 'X']) m = ok(applyOp(m, { op: 'status', id, status: 'done' }, NOW))
    const r = applyOp(m, { op: 'set_plan', nodes: [{ id: 'N', title: '新工作' }] }, LATER)
    if ('error' in r) throw new Error(r.error)
    expect(r.archive).toBe(true)
    expect(r.map.nodes.map(n => n.id)).toEqual(['N'])
    expect(r.map.planId).not.toBe(m.planId)
    // 同一個計劃內 set_plan 仍保留插入的步驟
    const same = applyOp(plan(), { op: 'insert', note: 'x', nodes: [{ id: 'X', title: '插入' }] }, NOW)
    if ('error' in same) throw new Error(same.error)
    const again = applyOp(same.map, { op: 'set_plan', nodes: [{ id: 'A', title: 'a', status: 'doing' }] }, LATER)
    expect('error' in again ? [] : again.map.nodes.map(n => n.id)).toEqual(['A', 'X'])
    expect('error' in again ? true : again.archive).toBe(false)
  })

  test('two writers interleaved never lose each other\'s step; a deletion does not come back', () => {
    const base = plan()
    const w1 = ok(applyOp(base, { op: 'upsert', nodes: [{ id: 'X', title: '一號加的', deps: ['A'] }] }, LATER))
    const w2 = ok(applyOp(base, { op: 'upsert', nodes: [{ id: 'Y', title: '二號加的', deps: ['A'] }] }, '2026-10-08T10:06:00.000Z'))
    const merged = mergeMaps(w1, w2)
    expect(merged.nodes.map(n => n.id).sort()).toEqual(['A', 'B', 'C', 'D', 'X', 'Y'])
    // 一號刪 D；二號（由舊底稿）改 B → D 不復活，B 的修改保留
    const del = ok(applyOp(base, { op: 'remove', ids: ['D'] }, LATER))
    const edit = ok(applyOp(base, { op: 'status', id: 'B', status: 'done' }, '2026-10-08T10:06:00.000Z'))
    const m2 = mergeMaps(del, edit)
    expect(m2.nodes.map(n => n.id)).toEqual(['A', 'B', 'C'])
    expect(m2.nodes.find(n => n.id === 'B')?.status).toBe('done')
    expect(m2.tombstones?.map(t => t.id)).toEqual(['D'])
    // 次序反過來亦一樣
    expect(mergeMaps(edit, del).nodes.map(n => n.id).sort()).toEqual(['A', 'B', 'C'])
  })

  test('acknowledgements and image-only messages are not requests', () => {
    for (const s of ['', 'ok', 'OK OK', 'okay!', 'yes', 'go', 'thanks', '好', '好啊', '上啦', '得', '可以', '繼續', '收到', '冇問題', '係', 'thanks a lot!'])
      expect([s, looksLikeRequest(s)]).toEqual([s, false])
    for (const s of ['仲有唔該改善下嗰個縮圖右上角個16同埋加3個顯示好核突', '我認為你檢查下類似嘅設計啦', 'please fix the header', 'add a dark theme to the settings page'])
      expect([s, looksLikeRequest(s)]).toEqual([s, true])
  })
})

/** 記憶體檔案系統 + 引擎底層 stub。 */
/** 計劃資料夾內的計劃檔（不含備份）；最後一個 = 最新建立的 */
const PLANS = `${ROOT}/.claude/workflow-map/plans/`
const planFiles = (files: Record<string, string>) => Object.keys(files).filter(k => k.startsWith(PLANS) && !k.includes('.bad-') && !k.includes('-backup-'))
const cur = (files: Record<string, string>) => JSON.parse(files[planFiles(files).at(-1)!]!)
/** $.store 種子：sess-A 綁定某計劃（預設：舊共用檔 default） */
const BIND = (planId = 'default', sid = 'sess-A') => ({ [`bind:${sid}`]: { root: ROOT, planId, at: NOW } })

function world(on: On, files: Record<string, string>, store?: Record<string, unknown>, sid: { id: string } = { id: 'sess-A' }) {
  const toasts: string[] = []
  mock.store(on, store)
  on('session.id', () => ({ value: sid.id }))
  const clock = mock.clock(on, { now: Date.parse(NOW) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  // 引擎會將路徑正規化做本機格式（Windows: C:\proj\...），統一返做 /proj/...
  const k = (p: string) => p.split('\\').join('/').replace(/^[A-Za-z]:/, '')
  on('fs.exists', ($, e) => ({ value: k(e.path) in files }))
  on('fs.read', ($, e) => (k(e.path) in files ? { value: files[k(e.path)]! } : { deny: 'ENOENT' }))
  on('fs.write', ($, e) => {
    files[k(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const dir = `${k(e.path ?? '')}/`
    return {
      value: Object.keys(files)
        .filter(f => f.startsWith(dir) && !f.slice(dir.length).includes('/'))
        .map(f => ({ name: f.slice(dir.length), kind: 'file' as const, size: files[f]!.length, mtimeMs: 0, isLink: false })),
    }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__workflow-map__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  return { toasts, clock }
}

const START = { cwd: ROOT, surface: 'desktop' as const, isInteractive: true }

describe('multi-agent', () => {
  test('timing: first doing sets startedAt, done sets doneAt; stale after the threshold', () => {
    const T0 = '2026-10-08T10:00:00.000Z'
    let m = ok(applyOp(plan(), { op: 'status', id: 'C', status: 'doing' }, T0))
    const c = () => m.nodes.find(n => n.id === 'C')!
    expect(c().startedAt).toBe(T0)
    m = ok(applyOp(m, { op: 'status', id: 'C', status: 'blocked' }, '2026-10-08T10:10:00.000Z'))
    m = ok(applyOp(m, { op: 'status', id: 'C', status: 'doing' }, '2026-10-08T10:20:00.000Z'))
    expect(c().startedAt).toBe(T0) // 只記第一次
    const now = Date.parse('2026-10-08T10:45:00.000Z')
    expect(elapsedMin(c(), now)).toBe(45)
    expect(isStale(c(), now, 30)).toBe(false) // 20 分時更新過
    expect(isStale(c(), Date.parse('2026-10-08T10:51:00.000Z'), 30)).toBe(true)
    expect(isStale(c(), Date.parse('2026-10-08T10:51:00.000Z'), 0)).toBe(false)
    m = ok(applyOp(m, { op: 'status', id: 'C', status: 'done' }, '2026-10-08T11:00:00.000Z'))
    expect(c().doneAt).toBe('2026-10-08T11:00:00.000Z')
    expect(elapsedMin(c(), now + 3_600_000)).toBe(60)
    m = ok(applyOp(m, { op: 'upsert', nodes: [{ id: 'C', owner: 'Grok' }] }, '2026-10-08T11:01:00.000Z'))
    expect(c().owner).toBe('Grok')
  })

  test('a sub-agent whose description carries [wm:<id>] drives that step: doing + owner, then done or blocked', async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    on('agent.spawn', ($, e) => ({ model: 'm', agentId: e.description.includes('fail') ? 'ag2' : 'ag1' }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: plan().nodes.map(({ id, title, status, deps }) => ({ id, title, status, deps })) })
    const spawn = (description: string, subagentType: string) =>
      $.agent.spawn({ tool_use_id: 't', prompt: 'do it', description, subagentType, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'x' } as never)
    const node = (id: string) => cur(files).nodes.find((n: { id: string }) => n.id === id)
    await spawn('Draw the UI [wm:C]', 'Builder')
    expect(node('C')).toMatchObject({ status: 'doing', owner: 'Builder' })
    await spawn('fail on purpose [wm:D]', 'Grok')
    expect(node('D')).toMatchObject({ status: 'doing', owner: 'Grok' })
    // 沒有標記：不猜
    await spawn('Draw the UI again', 'Builder')
    await $.turn.complete({ agentId: 'ag1', reason: 'answer', turnId: 't1' } as never)
    expect(node('C').status).toBe('done')
    await $.turn.complete({ agentId: 'ag2', reason: 'error', turnId: 't2' } as never)
    expect(node('D').status).toBe('blocked')
    // 標記指向不存在的步驟：甚麼都不改
    const before = files[planFiles(files).at(-1)!]
    await spawn('x [wm:nope]', 'Builder')
    expect(files[planFiles(files).at(-1)!]).toBe(before)
  })

  test('owner and elapsed time show on the band cards; staleMinutes 0 turns the amber mark off', { options: { staleMinutes: 0 } }, async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    await ui.press({ key: 'toggle' })
    const all = await svgText(ui)
    expect(all).toContain('Builder · 25m')
    expect(all).toContain('Grok · 52m')
    expect(all).not.toContain(`stroke='#d9962b' stroke-width='1.5'/><circle`) // 沒有琥珀「久未更新」圓環
    await ui.unmount()
  })
})

describe('help', () => {
  test('? opens a help card with the icon legend; pressing again hides it; /workflow help opens it', async ($, on) => {
    world(on, {})
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const mount = () =>
      $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 120 } as never })
    let ui = await mount()
    // 卡 = 有內距的圓角框（分段選擇的軌與選項不算）
    const frames = async () => (await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle === 'round' && b.props.paddingX !== undefined).length
    const cardsOnly = await frames()
    expect(await allText(ui)).not.toContain('Legend')
    await ui.press({ key: 'help' })
    let all = await allText(ui)
    for (const s of ['Legend', 'Done', 'Blocked', 'Added by you', 'No update for a while', 'Request not on the map yet', '/workflow-demo', '/workflow help', '/workflow export', '/workflow undo', 'staleMinutes', 'suggestions', 'notify', '[wm:<id>]'])
      expect([s, all.includes(s)]).toEqual([s, true])
    expect(await frames()).toBe(cardsOnly + 1)
    // 圖例用同一套圖示：7 個 20px 圖
    const legend = (await ui.findAll({ type: 'Box' })).filter(b => /^lg-(done|doing|todo|blocked|ins|stale|pending)$/.test(String(b.key)))
    // 兩欄：每行最多兩格
    const rows = (await ui.findAll({ type: 'Box' })).filter(b => String(b.key).startsWith('lg-row-'))
    expect(rows.length).toBe(4)
    // 語言：app 原生的下拉選單，英文先、沒有簡體，值 = 目前的說明語言
    const select = await ui.find({ key: 'help-lang' })
    expect(select?.type).toBe('Select')
    expect((select?.props.options as { value: string; label: string }[]).map(o => o.label)).toEqual(['English', '繁體中文', '日本語', '한국어', 'Español', 'Français', 'Deutsch'])
    expect(select?.props.value).toBe('en')
    // 不截斷：選單在不會被壓的格內，闊度 ≥ 最長選項（繁體中文 = 8 格）+ 4
    const langBox = await ui.find({ key: 'help-lang-box' })
    expect([langBox?.props.flexShrink, Number(langBox?.props.width) >= 8 + 4]).toEqual([0, true])
    // 第一行像設定頁：「Language」…… 選單、收起同一行
    const langRow = await ui.find({ key: 'lang-row' })
    expect(JSON.stringify(langRow)).toContain('help-lang')
    expect(JSON.stringify(langRow)).toContain('help-close')
    expect(langRow?.text).toContain('Language')
    // 說明卡各段之間（語言、簡介、圖示、使用、AI、指令）：app 的分隔線，段數 − 1 條
    expect((await ui.findAll({ type: 'Markdown' })).filter(m => String(m.key).startsWith('help-div')).length).toBe(5)
    await ui.select({ key: 'help-lang', value: 'ja' })
    expect(await allText(ui)).toContain('凡例')
    expect((await ui.find({ key: 'help-lang' }))?.props.value).toBe('ja')
    await ui.select({ key: 'help-lang', value: 'en' })
    expect(legend.length).toBe(7)
    for (const b of legend) expect(JSON.stringify(b.children)).toContain('Svg')
    await ui.press({ key: 'help' })
    expect(await allText(ui)).not.toContain('Legend')
    await ui.unmount()
    await $.command.run({ command: 'workflow', args: 'help', origin: { kind: 'composer' } } as never)
    ui = await mount()
    expect(await allText(ui)).toContain('Legend')
    await ui.press({ key: 'help-close' })
    expect(await allText(ui)).not.toContain('Legend')
    await ui.unmount()
  })

  test('terminal pane draws the same help: native language menu, glyph legend, ─ dividers', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'terminal', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 100 } as never })
    await ui.press({ key: 'help' })
    const all = await allText(ui)
    for (const s of ['Legend', 'Added by you', '/workflow-demo', 'staleMinutes']) expect([s, all.includes(s)]).toEqual([s, true])
    expect((await ui.find({ key: 'help-lang' }))?.type).toBe('Select')
    // 圖例：字元符號，主題色
    const glyphs = (await ui.findAll({ type: 'Text' })).filter(x => /^[✓◉○!◇●]$/.test(x.text)).map(x => [x.text, x.props.color ?? ''])
    for (const g of [['✓', 'success'], ['◉', 'claude'], ['!', 'warning'], ['◇', 'merged'], ['◉', 'warning'], ['●', 'warning']]) expect(glyphs).toContainEqual(g)
    expect(await ui.findAll({ type: 'Svg' })).toEqual([])
    expect(await ui.findAll({ type: 'Markdown' })).toEqual([])
    expect((await ui.findAll({ type: 'Text' })).some(x => /^─{20,}$/.test(x.text))).toBe(true)
    await ui.unmount()
  })
})

describe('step detail', () => {
  test('status changes are logged (at most 10, with who); set_plan keeps the log', () => {
    let m = plan()
    for (let i = 0; i < 7; i++) {
      m = ok(applyOp(m, { op: 'status', id: 'C', status: 'doing' }, `2026-10-08T11:0${i}:00.000Z`, 'Grok'))
      m = ok(applyOp(m, { op: 'status', id: 'C', status: 'blocked' }, `2026-10-08T11:0${i}:30.000Z`))
    }
    const log = m.nodes.find(n => n.id === 'C')!.log!
    expect(log.length).toBe(10)
    expect(log[log.length - 1]).toEqual({ at: '2026-10-08T11:06:30.000Z', status: 'blocked' })
    expect(log[log.length - 2]).toEqual({ at: '2026-10-08T11:06:00.000Z', status: 'doing', by: 'Grok' })
    const again = ok(applyOp(m, { op: 'set_plan', nodes: m.nodes.map(({ id, title, deps }) => ({ id, title, deps, status: 'todo' as const })) }, LATER))
    expect(again.nodes.find(n => n.id === 'C')!.log!.length).toBe(10)
  })

  test('pressing a row opens its detail inline; only one is open at a time', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 120 } as never })
    expect(await allText(ui)).not.toContain('Your words')
    await ui.press({ key: 'detail:dark' })
    let all = await allText(ui)
    for (const s of ['Your words: Follow the system light/dark', 'Owner: Astra', 'Waits for: UI skeleton', 'Unblocks: Screenshots']) expect(all).toContain(s)
    expect((await ui.find({ key: 'detail:dark' }))?.text).toBe('Hide')
    await ui.press({ key: 'detail:cards' })
    all = await allText(ui)
    expect(all).not.toContain('Owner: Astra')
    expect(all).toContain('Owner: Builder')
    await ui.press({ key: 'detail:cards' })
    expect(await allText(ui)).not.toContain('Owner: Builder')
    await ui.unmount()
  })
})

describe('persistence', () => {
  test('a v1 plan file is backed up before it is migrated; the legacy shared file is only read', async ($, on) => {
    const v1 = JSON.stringify({ version: 1, updatedAt: NOW, nodes: [{ id: 'A', title: 'a', status: 'doing', deps: [] }] })
    const files: Record<string, string> = { [`${PLANS}old.json`]: v1, [FILE]: v1 }
    world(on, files, BIND('old'))
    await $.session.start(START)
    const backups = Object.keys(files).filter(p => p.includes('.v1-backup-'))
    expect(backups.length).toBe(1)
    expect(files[backups[0]!]).toBe(v1)
    expect(JSON.parse(files[`${PLANS}old.json`]!)).toMatchObject({ schemaVersion: 2, nodes: [{ id: 'A', title: 'a', status: 'doing' }] })
    // 舊共用檔：綁了它也只在記憶體轉換，檔案一字不改
    await $.tool.call({ tool: TOOL, op: 'join', plan: 'default' })
    expect(JSON.stringify(await $.tool.call({ tool: TOOL, op: 'show' }))).toContain('A a')
    expect(files[FILE]).toBe(v1)
  })

  test('new_plan archives the current plan to the history folder; the tool answer is compact', async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    await $.session.start(START)
    const nodes = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, title: `step ${i}`, deps: i ? [`s${i - 1}`] : [] }))
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes })
    const r = JSON.stringify(await $.tool.call({ tool: TOOL, op: 'status', id: 's3', status: 'doing' }))
    // 摘要 + 改到的 s3 + 前後 s2、s4；其他步驟不列
    expect(r).toContain('s3 step 3')
    expect(r).toContain('s2 step 2')
    expect(r).toContain('s4 step 4')
    expect(r).not.toContain('s6 step 6')
    expect(JSON.stringify(await $.tool.call({ tool: TOOL, op: 'show' }))).toContain('s6 step 6')
    // 另一個寫入者（例如 Codex）同時加了一步：之後我們寫入不會蓋走它
    const mine = planFiles(files).at(-1)!
    const disk = JSON.parse(files[mine]!)
    disk.nodes.push({ id: 'ext', title: 'from codex', status: 'todo', deps: [], updatedAt: '2026-10-08T10:00:01.000Z' })
    files[mine] = JSON.stringify(disk)
    await $.tool.call({ tool: TOOL, op: 'status', id: 's4', status: 'doing' })
    expect(JSON.parse(files[mine]!).nodes.map((n: { id: string }) => n.id)).toContain('ext')
    await $.tool.call({ tool: TOOL, op: 'new_plan', title: 'Next task', nodes: [{ id: 'n1', title: 'first' }] })
    const hist = Object.keys(files).filter(p => p.startsWith(`${ROOT}/.claude/workflow-map.history/`))
    expect(hist.length).toBe(1)
    expect(JSON.parse(files[hist[0]!]!).nodes.length).toBe(9)
    expect(cur(files)).toMatchObject({ title: 'Next task', nodes: [{ id: 'n1' }], sessions: ['sess-A'], createdBy: 'sess-A' })
    // 舊計劃檔標記封存（清單不再列出），新計劃另一個檔
    expect(JSON.parse(files[mine]!).archivedAt).toBeDefined()
    expect(planFiles(files).length).toBe(2)
    // 全圖：歷史紀錄
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 90 } as never })
    await ui.press({ key: 'history' })
    expect(await allText(ui)).toMatch(/step 0[\s\S]*0\/9/)
    await ui.unmount()
  })

  test('a corrupt plan file is backed up, the plan starts empty, one toast', async ($, on) => {
    const files: Record<string, string> = { [`${PLANS}p1.json`]: '{ not json' }
    const w = world(on, files, BIND('p1'))
    await $.session.start(START)
    const backups = Object.keys(files).filter(p => p.includes('.bad-'))
    expect(backups.length).toBe(1)
    expect(files[backups[0]!]).toBe('{ not json')
    expect(JSON.parse(files[`${PLANS}p1.json`]!).nodes).toEqual([])
    expect(w.toasts.length).toBe(1)
  })

  test('a corrupt legacy shared file is never rewritten', async ($, on) => {
    const files: Record<string, string> = { [FILE]: '{ not json' }
    world(on, files, BIND())
    await $.session.start(START)
    expect(files[FILE]).toBe('{ not json')
    expect(Object.keys(files).filter(p => p.includes('.bad-'))).toEqual([])
  })

  test('tool ops write the file and reject cycles', async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    await $.session.start(START)
    const r = await $.tool.call({
      tool: TOOL,
      op: 'set_plan',
      nodes: [
        { id: 'A', title: 'a' },
        { id: 'B', title: 'b', deps: ['A'] },
      ],
    })
    expect(r.deny).toBeUndefined()
    expect(cur(files).nodes.length).toBe(2)
    const bad = await $.tool.call({ tool: TOOL, op: 'upsert', nodes: [{ id: 'A', deps: ['B'] }] })
    expect(bad.deny ?? bad.text ?? '').toMatch(/cycle/)
    expect(cur(files).nodes[0].deps).toEqual([])
  })
})

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 30,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 29, contentRows: 0 },
  view: {},
} as never

const allText = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(x => x.text).join('\n')

const svgText = async (ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.source)).join('\n')

describe('band', () => {
  test('collapsed: running name + segmented bar + count; expanded: parallel steps share one card', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: plan().nodes.map(({ id, title, status, deps }) => ({ id, title, status, deps })) })
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs.length).toBe(2)
    for (const s of svgs) expect(s.props.isInteractive).toBeUndefined()
    const collapsed = svgs.map(s => String(s.props.source)).join('\n')
    expect(collapsed).toContain('寫 API') // 進行中的步驟名稱
    expect(collapsed).toContain('1/4') // 數字在圖內
    expect((collapsed.match(/<rect /g) ?? []).length).toBe(4) // 每步一段進度條
    // 最多兩個控制，都不是數字；兩個相鄰（同一個框、中間沒有別的東西）、同樣的方形外觀
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.length).toBe(2)
    for (const b of buttons) expect(b.text).not.toMatch(/\d/)
    const ctl = await ui.find({ key: 'ctl' })
    // 原生設計：沒有原生的展開／開啟圖示，所以是 app 的文字按鈕（plain、淡色），不自創字形、不自加 hover 底色
    expect((ctl?.children as { type?: string }[]).map(c => c.type)).toEqual(['Button', 'Button'])
    expect(buttons.map(b => [b.props.plain, b.props.variant, b.text])).toEqual([
      [true, undefined, '展開'],
      [true, undefined, '全圖'],
    ])
    expect(JSON.stringify(ctl)).not.toContain('hover')

    await ui.press({ key: 'toggle' })
    const all = await ui.findAll({ type: 'Svg' })
    // 標題行兩張 + 卡片圖：已完成小卡（+ 指著時清單：圖示與第二行的空位）、各層的卡；沒有收起的步驟 → 沒有幽靈卡
    expect(all.length).toBe(6)
    expect(await ui.find({ key: 'peek-later' })).toBeUndefined()
    const graph = all.slice(2).map(s => String(s.props.source)).join('')
    // 已完成一張卡 + 「寫 API ∥ 畫 UI」同一張卡；整合測試屬較遠的一層（小計劃不收，畫第三張）
    expect((graph.match(/rx='4'/g) ?? []).length).toBe(3)
    const card = graph.split("rx='4'")[2]!
    expect(card).toContain('寫 API')
    expect(card).toContain('畫 UI')
    expect(card).not.toContain('整合測試')
    expect((await ui.findAll({ type: 'Button' })).length).toBe(2)
    await ui.unmount()
  })

  test('terminal: the title row reads like the desktop one; it expands to box-drawn cards', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: plan().nodes.map(({ id, title, status, deps }) => ({ id, title, status, deps })) })
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    const title = await ui.find({ key: 'title' })
    expect(title?.text).toContain('寫 API')
    expect(title?.text).toContain('1/4')
    // 未有用戶輸入：介面語言跟步驟名稱（繁中）
    expect(await ui.find({ type: 'Button', text: '展開' })).toBeDefined()
    await ui.press({ key: 'toggle' })
    expect((await ui.find({ key: 'graph' }))?.text).toContain('1 已完成')
    await ui.unmount()
  })

  test('/workflow-demo shows the sample from memory and never writes the file', async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    expect(files[FILE]).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect((await ui.find({ key: 'title' }))?.text).toContain('Card layout')
    expect((await ui.find({ key: 'title' }))?.text).toContain('5/12')
    await ui.unmount()
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    expect(files[FILE]).toBeUndefined()
  })
})

describe('language and palette', () => {
  test('auto picks Chinese only for CJK titles; explicit setting wins', () => {
    // 跟用戶最近一次輸入的文字，不跟步驟名稱
    expect(detectLang('幫我整理這個專案的說明文件')).toBe('zh-Hant')
    // 簡體：沒有簡體介面，用英文；日文、韓文按文字
    expect(detectLang('帮我整理这个项目的说明文件')).toBe('en')
    expect(detectLang('テストを実行してください')).toBe('ja')
    expect(detectLang('테스트를 실행해 주세요')).toBe('ko')
    expect(detectLang('please refactor the parser module')).toBe('en')
    expect(detectLang('ok')).toBeUndefined()
    // 用戶的廣東話（繁體）一律 zh-Hant；真簡體 → 英文介面；單一簡體字或打和不改
    for (const s of ['乜撚嘢事呀你個工作流程寫住殘體字', '我認為你檢查下類似嘅設計啦', '仲有唔該改善下嗰個縮圖右上角個16同埋加3個顯示好核突'])
      expect([s, detectLang(s)]).toEqual([s, 'zh-Hant'])
    expect(detectLang('这个工作流程显示简体字了')).toBe('en')
    expect(detectLang('幫我睇下这度')).toBe('zh-Hant')
    expect(detectLang('工作流程这')).toBeUndefined()
    expect(detectLang('個們这们')).toBeUndefined()
    expect(resolveLang('auto', 'zh-Hans')).toBe('en') // 舊的簡體設定不再有效
    expect(resolveLang('auto', 'ja')).toBe('ja')
    expect(resolveLang('de', 'ja')).toBe('de')
    expect(resolveLang('en', 'zh-Hant')).toBe('en')
    expect(resolveLang('auto', undefined)).toBe('en')
    expect(plainLines(plan(), 'en').join(' / ')).toContain('ready')
    expect(plainLines(plan(), 'zh-Hant').join(' / ')).toContain('可開始')
  })

  test('text colours reach 4.5:1 on the band and pane backgrounds', () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
    }
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
      return (x! + 0.05) / (y! + 0.05)
    }
    for (const bg of ['#1f1f1f', '#262626'])
      for (const k of ['text', 'dim', 'run', 'block'] as const) expect([bg, k, ratio(THEMES.dark[k], bg) >= 4.5]).toEqual([bg, k, true])
    for (const k of ['text', 'dim', 'run', 'block'] as const) expect(['#ffffff', k, ratio(THEMES.light[k], '#ffffff') >= 4.5]).toEqual(['#ffffff', k, true])
  })
})

describe('language source', () => {
  test('a zh-Hans saved under the old key is ignored; a Traditional plan gives zh-Hant with no typed prompt', async ($, on) => {
    const plan = { version: 1, updatedAt: NOW, nodes: [{ id: 'a', title: '整理需求', status: 'doing', deps: [] }, { id: 'b', title: '檢查設計', status: 'todo', deps: ['a'] }] }
    world(on, { [FILE]: JSON.stringify(plan) }, { lang: 'zh-Hans', ...BIND() })
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 90 } as never })
    const all = (await ui.findAll({ type: 'Text' })).map(s => s.text).join('\n')
    expect(all).toContain('階段 1')
    expect(all).not.toContain('阶段')
    await ui.unmount()
  })

  test('only typed prompts set the language; a typed Traditional prompt corrects a stored zh-Hans', async ($, on) => {
    world(on, {})
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
    await $.session.start(START)
    const empty = async () => {
      const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 90 } as never })
      const text = (await ui.find({ type: 'Text' }))?.text
      await ui.unmount()
      return text
    }
    const submit = (text: string, kind: string) => $.prompt.submit({ text, origin: { kind } } as never)
    await submit('这个工作流程显示简体字了', 'task-notification')
    await submit('这个工作流程显示简体字了', 'peer-send-message')
    expect(await empty()).toMatch(/^This session has no plan/)
    await submit('这个工作流程显示简体字了', 'composer')
    expect(await empty()).toMatch(/^This session has no plan/) // 簡體 → 英文介面
    await submit('仲有唔該改善下嗰個縮圖右上角個16同埋加3個顯示好核突', 'composer')
    expect(await empty()).toMatch(/^這個工作階段還沒有計劃/)
    await submit('ok', 'composer')
    expect(await empty()).toMatch(/^這個工作階段還沒有計劃/)
  })
})

describe('pane', () => {
  test('stage view: done in one group, open steps layered by open deps, far levels folded', () => {
    const v = stageView(plan())
    expect(v.done.map(n => n.id)).toEqual(['A'])
    expect(v.levels.map(l => l.map(n => n.id))).toEqual([['B', 'C'], ['D']])
    expect(v.later).toEqual([])
  })

  test('desktop pane: stage cards, completed folded behind a toggle', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const ui = await $.ui.mount({
      plugin: 'workflow-map',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'workflow-map',
      props: { title: 'Workflow', isFocused: false, bodyColumns: 90 } as never,
    })
    for (const s of await ui.findAll({ type: 'Svg' })) expect(s.props.isInteractive).toBeUndefined()
    const all = await allText(ui)
    // 未有用戶輸入 → 示範與介面用英文；負責人、用時、久未更新
    expect(all).toContain('5 / 12')
    expect(all).toContain('Stage 1 · 3 parallel')
    // 分段（原生面板的 Running／Finished N ⌄）：進行中、接著；已完成、稍後是可收起的分段標題
    expect(all).toContain('In progress\nStage 1 · 3 parallel')
    expect(all).toContain('Next\nStage 2 · 2 parallel')
    // 按鈕只有字與數目；展開記號是我們畫的細線 V（像 app 下拉選單的箭咀）
    expect((await ui.find({ key: 'fold-done' }))?.text).toBe('Done 5')
    expect((await ui.find({ key: 'fold-future' }))?.text).toBe('Later 2')
    expect((await ui.findAll({ type: 'Svg' })).filter(x => String(x.props.source).includes("M3,8 L7,12 L11,8")).length).toBe(2)
    for (const title of ['Card layout', 'Connectors', 'Dark theme', 'Screenshots']) expect(all).toContain(title)
    expect(all).not.toContain('Gather needs')
    expect(all).toContain('Builder · 25m')
    expect(all).toContain('no update')
    // 卡框是 Box 的圓角邊框（一張卡一個，由介面撐滿闊度）；圖只用作小圖示、進度條、8px 空位，不切片
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.filter(b => b.props.borderStyle === 'round').length).toBe(2) // 收起的分段沒有卡
    // 左縮一格、右不縮：app 已在右邊多留捲動列的位（≈ 15px），這樣卡片兩邊看起來一樣（≈ 30px）
    expect([boxes[0]?.props.paddingLeft, boxes[0]?.props.paddingRight, boxes[0]?.props.paddingX]).toEqual([1, 0, undefined])
    // 卡內步與步之間：app 自己的分隔線（Markdown ---），每張卡 n 步 → n − 1 條
    expect((await ui.findAll({ type: 'Markdown' })).map(m => m.text)).toEqual(['---', '---', '---'])
    for (const svg of await ui.findAll({ type: 'Svg' })) expect(Number(svg.props.height)).toBeLessThanOrEqual(20)
    // 標題行的控制：小的文字按鈕（不撐高標題行），沒有數字
    const buttons = (await ui.findAll({ type: 'Button' })).filter(b => ['fold-done', 'fold-future', 'history', 'help'].includes(String(b.key)))
    // 分段標題（原生的「Finished 172 ⌄」連數字）與工具列都是 app 的文字按鈕
    expect(buttons.map(b => [b.key, b.props.plain])).toEqual([
      ['history', true],
      ['help', true],
      ['fold-done', true],
      ['fold-future', true],
    ])
    expect((await ui.find({ key: 'help' }))?.text).toBe('Help')

    // 每張卡同一個內距、卡與卡之間同一個間距
    const frames = boxes.filter(b => b.props.borderStyle === 'round')
    for (const f of frames) expect([f.props.paddingX, f.props.paddingY, f.props.marginTop]).toEqual([1, 1, 0.5])
    // 卡面：有填色、外框全透明（看不見外框）
    for (const f of frames) expect([f.props.backgroundColor, f.props.borderColor]).toEqual(['#ffffff0f', '#00000000'])
    // 卡內每一行都是 [圖示欄 20px][文字]：沒有圖示的行用同闊的空位
    for (const svg of await ui.findAll({ type: 'Svg' })) if (svg.props.width !== undefined && svg.props.width !== 14) expect(svg.props.width).toBe(20) // 14 = 分段的展開記號
    await ui.press({ key: 'fold-done' })
    expect((await ui.findAll({ type: 'Svg' })).filter(x => String(x.props.source).includes("M3,12 L7,8 L11,12")).length).toBe(1)
    expect(await allText(ui)).toContain('Gather needs')
    await ui.press({ key: 'fold-future' })
    expect(await allText(ui)).toContain('Stage 4')
    await ui.unmount()
  })
})

describe('focus', () => {
  // 一條長鏈：s1..s4 已完成，s5 進行中，s6 可開始（另一分支），s7..s12 待辦
  const big = () =>
    ok(
      applyOp(
        emptyMap(),
        {
          op: 'set_plan',
          nodes: [
            { id: 's1', title: '一', status: 'done' },
            { id: 's2', title: '二', status: 'done', deps: ['s1'] },
            { id: 's3', title: '三', status: 'done', deps: ['s2'] },
            { id: 's4', title: '四', status: 'done', deps: ['s3'] },
            { id: 's5', title: '五', status: 'doing', deps: ['s4'] },
            { id: 's6', title: '六', deps: ['s4'] },
            { id: 's7', title: '七', deps: ['s5'] },
            { id: 's8', title: '八', deps: ['s7'] },
            { id: 's9', title: '九', deps: ['s8'] },
            { id: 's10', title: '十', deps: ['s6'] },
            { id: 's11', title: '十一', deps: ['s10'] },
            { id: 's12', title: '十二', deps: ['s9', 's11'] },
          ],
        },
        NOW,
      ),
    )

  test('doing + ready + one level; done and far future folded', () => {
    const f = focusSet(big())
    expect([...f.visible].sort()).toEqual(['s10', 's5', 's6', 's7'])
    expect(f.doneFolded).toEqual(['s1', 's2', 's3', 's4'])
    expect(f.futureFolded.sort()).toEqual(['s11', 's12', 's8', 's9'])
    const fm = focusedMap(big(), f)
    expect(fm.nodes[0]).toMatchObject({ id: DONE_ID, title: '4' })
    expect(fm.nodes.find(n => n.id === MORE_ID)).toMatchObject({ title: '4' })
    expect(fm.nodes.find(n => n.id === 's5')?.deps).toEqual([DONE_ID])
  })

  test('expanding shows everything; small plans are never folded', () => {
    const f = focusSet(big(), { expandDone: true, expandFuture: true })
    expect(f.visible.size).toBe(12)
    expect(f.doneFolded).toEqual([])
    expect(focusSet(plan()).visible.size).toBe(4)
  })

  test('an insert from this turn is always visible', () => {
    const m = ok(applyOp(big(), { op: 'insert', note: 'x', nodes: [{ id: 'late', title: '新', deps: ['s12'] }] }, NOW))
    expect(focusSet(m).visible.has('late')).toBe(false)
    expect(focusSet(m, { freshSince: Date.parse(NOW) - 1000 }).visible.has('late')).toBe(true)
  })

  test('all blocked: show the blocked steps and their unmet deps', () => {
    let m = big()
    m = ok(applyOp(m, { op: 'status', id: 's5', status: 'blocked' }, NOW))
    m = ok(applyOp(m, { op: 'status', id: 's6', status: 'blocked' }, NOW))
    m = ok(applyOp(m, { op: 'upsert', nodes: [{ id: 's6', deps: ['s4', 's9'] }] }, NOW))
    const f = focusSet(m)
    expect(f.visible.has('s5')).toBe(true)
    expect(f.visible.has('s6')).toBe(true)
    expect(f.visible.has('s9')).toBe(true)
  })

  test('the model-facing text graph stays complete', () => {
    expect(textDiagram(big()).match(/s\d+/g)?.length).toBeGreaterThanOrEqual(12)
  })
})

// ---------------- 下一句建議（移植自 next-steps 的測試，Apache-2.0；見 hooks/suggest.ts） ----------------

const SUGGESTIONS = [
  { label: 'run the tests you just wrote', prompt: 'run the tests you just wrote' },
  { label: 'same for the settings page', prompt: 'do the same for the settings page please' },
  { label: 'commit it', prompt: 'commit the change with a short message' },
]

/** 引擎底層：會回答的 fork、記錄輸入框。 */
function suggestWorld(on: On, suggestions: readonly { label: string; prompt: string }[] = SUGGESTIONS, files: Record<string, string> = {}) {
  world(on, files, FILE in files ? BIND() : undefined)
  const filled: string[] = []
  const asked: string[] = []
  on('command.list', () => ({ value: [] }))
  on('model.fork', ($, e) => (
    asked.push(e.prompt),
    { value: { isAnswered: true, text: JSON.stringify(suggestions), usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  ))
  on('prompt.suggest', () => ({ isShown: true }) as never)
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  // 引擎自己的橫條：甚麼都不畫
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return { filled, asked }
}

const TURN = { reason: 'answer', answer: 'x'.repeat(200), durationMs: 1, isAborted: false, turnId: 't1' } as never
type Driver = { turn: { complete: (e: never) => Promise<unknown> }; prompt: { submit: (e: never) => Promise<unknown> }; session: { start: (e: never) => Promise<unknown> } }
async function offer($: Driver, typed?: string) {
  await $.session.start(START as never)
  if (typed !== undefined) await $.prompt.submit({ text: typed, origin: { kind: 'composer' } } as never)
  await $.turn.complete(TURN)
  for (let i = 0; i < 300; i++) await Promise.resolve()
}

type Node = { type?: string; props?: Record<string, unknown>; children?: Node[] }
const buttonKeys = (n: Node | undefined): string[] =>
  n === undefined ? [] : n.type === 'Button' ? [String(n.props?.key)] : (n.children ?? []).flatMap(buttonKeys)

describe('suggestions (merged from next-steps)', () => {
  for (const surface of ['desktop', 'terminal'] as const) {
    test(`${surface}: the band's last row offers 3 suggestions; a press fills that prompt`, async ($, on) => {
      const w = suggestWorld(on)
      await offer($)
      const ui = await $.ui.mount({ plugin: 'workflow-map', surface, component: 'AbovePrompt', props: BAND_PROPS })
      for (const n of [1, 2, 3]) expect([surface, n, (await ui.find({ key: `pick${n}` }))?.props?.hotkey]).toEqual([surface, n, String(n)])
      expect((await ui.find({ key: 'dismiss' }))?.props?.hotkey).toBe('0')
      expect((await ui.find({ key: 'dismiss' }))?.props?.role).toBe('dismiss') // app 原生的關閉 ✕
      // 一行：全部按鈕都在建議行，✕ 在最右
      const row = (await ui.find({ key: 'suggest' })) as unknown as Node
      expect(row.props?.flexDirection).toBe('row')
      expect(buttonKeys(row)).toEqual(['pick1', 'pick2', 'pick3', 'dismiss'])
      // 平時沒有底色（只有指著時的 hover 淡底色）
      expect(JSON.stringify(row).replace(/"hover":\{[^}]*\}/g, '')).not.toContain('backgroundColor')
      // 桌面：第一格是 ✦ 圖（20px 高、不會被壓扁的格），與標題行狀態點同一欄
      const first = row.children?.[0] as Node
      expect([first?.type, first?.props?.key, first?.props?.flexShrink]).toEqual(['Box', 'star', 0])
      if (surface === 'desktop') {
        const icon = first.children?.[0] as Node
        expect([icon?.type, icon?.props?.height, icon?.props?.width, String(icon?.props?.alt).length > 0]).toEqual(['Svg', 20, 20, true])
      }
      await ui.press({ key: 'pick2' })
      expect(w.filled).toEqual(['do the same for the settings page please'])
      expect(await ui.find({ key: 'pick1' })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('with a plan, suggestions are the last row of the same band', async ($, on) => {
    suggestWorld(on)
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: [{ id: 'a', title: 'a', status: 'doing' }, { id: 'b', title: 'b', deps: ['a'] }] })
    await $.turn.complete(TURN)
    for (let i = 0; i < 300; i++) await Promise.resolve()
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    const band = (await ui.find({ key: 'workflow-map' })) as unknown as Node
    const keys = (band.children ?? []).filter(Boolean).map(c => String(c.props?.key))
    expect(keys).toEqual(['title', 'suggest'])
    await ui.unmount()
  })

  test('suggestions: false turns them off', { options: { suggestions: false } }, async ($, on) => {
    const w = suggestWorld(on)
    await offer($)
    expect(w.asked.length).toBe(0)
  })

  test('a narrow band drops the suggestions that do not fit, never wraps', async ($, on) => {
    suggestWorld(on)
    await offer($)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: { ...(BAND_PROPS as object), bodyColumns: 50 } as never })
    expect(buttonKeys((await ui.find({ key: 'suggest' })) as unknown as Node)).toEqual(['pick1', 'dismiss'])
    await ui.press({ key: 'dismiss' })
    expect(await ui.find({ key: 'pick1' })).toBeUndefined()
    await ui.unmount()
  })

  test('CJK labels are measured in cells: 14 characters fit whole, 15 are cut', async ($, on) => {
    const fits = '執行測試並提交變更後推送分支'
    const long = '執行測試並提交變更後推送分支吧'
    suggestWorld(on, [
      { label: fits, prompt: '執行剛寫好的測試' },
      { label: long, prompt: '提交' },
    ])
    await offer($)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect((await ui.find({ key: 'pick1' }))?.props?.label).toBe(fits)
    expect((await ui.find({ key: 'pick2' }))?.props?.label).toBe('執行測試並提交變更後推送分…')
    await ui.unmount()
  })

  test('an English-typing user: the fork judges the language from the user, never told Chinese', async ($, on) => {
    const w = suggestWorld(on)
    await offer($, 'please run the tests and commit')
    expect(w.asked[0]).toContain('the language the user types their own prompts in')
    expect(w.asked[0]).not.toContain('Chinese (')
  })

  for (const [typed, rule] of [
    ['幫我跑一次測試，然後提交', 'The user types their prompts in Traditional Chinese'],
    ['乜撚嘢事呀你個工作流程寫住殘體字', 'The user types their prompts in Traditional Chinese'],
    ['我認為你檢查下類似嘅設計啦', 'The user types their prompts in Traditional Chinese'],
    ['仲有唔該改善下嗰個縮圖右上角個16同埋加3個顯示好核突', 'The user types their prompts in Traditional Chinese'],
    // 簡體：介面用英文，建議的語言交給模型按用戶的訊息判斷
    ['这个工作流程显示简体字了', 'the language the user types their own prompts in'],
    ['テストを実行してください', 'The user types their prompts in Japanese'],
    ['테스트를 실행해 주세요', 'The user types their prompts in Korean'],
  ] as const) {
    test(`language rule from: ${typed}`, async ($, on) => {
      const w = suggestWorld(on)
      await offer($, typed)
      expect(w.asked[0]).toContain(rule)
    })
  }

  test('language option zh-Hant forces Traditional Chinese', { options: { language: 'zh-Hant' } }, async ($, on) => {
    const w = suggestWorld(on)
    await offer($, 'please run the tests')
    expect(w.asked[0]).toContain('Traditional Chinese (繁體中文)')
    expect(w.asked[0]).not.toContain('The user types their prompts in')
  })

  describe('plan ready steps lead', () => {
    const plan = JSON.stringify({
      schemaVersion: 2,
      version: 1,
      planId: 'p',
      updatedAt: NOW,
      tombstones: [{ id: 'T', at: NOW }],
      nodes: [
        { id: 'A', title: 'read the brief', status: 'done', deps: [] },
        { id: 'B', title: 'write the API', status: 'todo', deps: ['A'] },
        { id: 'C', title: 'draw the UI', status: 'todo', deps: ['A'] },
        { id: 'D', title: 'integrate', status: 'todo', deps: ['B', 'C'] },
        { id: 'E', title: 'old idea', status: 'dropped', deps: [] },
        { id: 'T', title: 'buried step', status: 'todo', deps: [] },
      ],
    })
    const label = async (ui: { find: (q: { key: string }) => Promise<{ props?: Record<string, unknown> } | undefined> }, n: number) =>
      (await ui.find({ key: `pick${n}` }))?.props?.label

    test('2 ready steps lead, the fork fills the last slot without repeating them', async ($, on) => {
      const w = suggestWorld(
        on,
        [
          { label: 'Write the API', prompt: 'write the API now' },
          { label: 'run the tests', prompt: 'run the tests' },
          { label: 'commit it', prompt: 'commit' },
        ],
        { [FILE]: plan },
      )
      await offer($, 'please go on')
      const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
      expect([await label(ui, 1), await label(ui, 2), await label(ui, 3)]).toEqual(['write the API', 'draw the UI', 'run the tests'])
      expect(w.asked.length).toBe(1)
      await ui.press({ key: 'pick1' })
      expect(w.filled).toEqual(['Continue: write the API'])
      await ui.unmount()
    })

    test('the fill text follows the user language', async ($, on) => {
      const w = suggestWorld(on, SUGGESTIONS, { [FILE]: plan })
      await offer($, '我認為你繼續做落去啦')
      const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
      await ui.press({ key: 'pick2' })
      expect(w.filled).toEqual(['繼續做：draw the UI'])
      await ui.unmount()
    })

    test('3 ready steps: no fork call at all', async ($, on) => {
      const three = JSON.stringify({
        version: 1,
        updatedAt: NOW,
        nodes: ['one', 'two', 'three', 'four'].map(t => ({ id: t, title: t, status: 'todo', deps: [] })),
      })
      const w = suggestWorld(on, SUGGESTIONS, { [FILE]: three })
      await offer($, 'go on')
      expect(w.asked.length).toBe(0)
      const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
      expect([await label(ui, 1), await label(ui, 2), await label(ui, 3)]).toEqual(['one', 'two', 'three'])
      await ui.unmount()
    })

    for (const [name, content] of [
      ['a corrupt (half-written) file', { [`${PLANS}p.json`]: plan.slice(0, plan.length / 2) }],
      ['no file', {}],
    ] as const) {
      test(`${name}: the fork alone`, async ($, on) => {
        const w = suggestWorld(on, SUGGESTIONS, { ...content })
        await offer($, 'go on')
        expect(w.asked.length).toBe(1)
        const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
        expect([await label(ui, 1), await label(ui, 2), await label(ui, 3)]).toEqual(SUGGESTIONS.map(x => x.label))
        await ui.unmount()
      })
    }
  })
})

describe('notifications', () => {
  const PLAN = [
    { id: 'A', title: 'Read brief', status: 'done' as const },
    { id: 'B', title: 'Write API', status: 'todo' as const, deps: ['A'] },
    { id: 'C', title: 'Draw UI', status: 'todo' as const, deps: ['A'] },
  ]

  test('sub-agent done and blocked steps toast once, batched within 5 s', async ($, on) => {
    const w = world(on, {})
    on('agent.spawn', ($, e) => ({ model: 'm', agentId: e.description.includes('[wm:B]') ? 'ag1' : 'ag2' }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: PLAN })
    const spawn = (description: string) =>
      $.agent.spawn({ tool_use_id: 't', prompt: 'x', description, subagentType: 'Builder', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'x' } as never)
    await spawn('Write it [wm:B]')
    await spawn('Draw it [wm:C]')
    await $.turn.complete({ agentId: 'ag1', reason: 'answer', turnId: 't1' } as never)
    await $.turn.complete({ agentId: 'ag2', reason: 'error', turnId: 't2' } as never)
    expect(w.toasts).toEqual([]) // 5 秒內的合成一則
    await w.clock.advance(5000)
    expect(w.toasts).toEqual(['2 updates: ✓ Write API done (Builder) · ! Draw UI is blocked'])
    // 同一轉變不再通知；離開後再受阻可以再通知
    await $.tool.call({ tool: TOOL, op: 'status', id: 'C', status: 'blocked', note: 'again' })
    await w.clock.advance(5000)
    expect(w.toasts.length).toBe(1)
    await $.tool.call({ tool: TOOL, op: 'status', id: 'C', status: 'todo' })
    await $.tool.call({ tool: TOOL, op: 'status', id: 'C', status: 'blocked' })
    await w.clock.advance(5000)
    expect(w.toasts[1]).toBe('! Draw UI is blocked')
  })

  test('a model marking a step done does not toast; a stale step toasts once', async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: [{ id: 'A', title: 'Long task', status: 'doing' }, { id: 'B', title: 'b', status: 'todo' }] })
    await $.tool.call({ tool: TOOL, op: 'status', id: 'B', status: 'done' })
    await w.clock.advance(5000)
    expect(w.toasts).toEqual([])
    await w.clock.advance(31 * 60_000)
    await w.clock.advance(5000)
    expect(w.toasts).toEqual(['Long task: no update for 30 min'])
    await w.clock.advance(10 * 60_000)
    expect(w.toasts.length).toBe(1)
  })

  test('notify: false stays silent', { options: { notify: false } }, async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: PLAN })
    await $.tool.call({ tool: TOOL, op: 'status', id: 'B', status: 'blocked' })
    await w.clock.advance(6000)
    expect(w.toasts).toEqual([])
  })
})

describe('eta (honest range)', () => {
  const at = (min: number) => new Date(Date.parse(NOW) + min * 60_000).toISOString()
  const node = (id: string, status: 'done' | 'doing' | 'todo', deps: string[], started?: number, done?: number) => ({
    id,
    title: id,
    status,
    deps,
    ...(started === undefined ? {} : { startedAt: at(started) }),
    ...(done === undefined ? {} : { doneAt: at(done) }),
  })
  const mk = (nodes: ReturnType<typeof node>[]) => ({ ...emptyMap(), nodes }) as never

  test('parallel steps in a stage count once (the longest); a running step adds its remaining time, floored at 0', () => {
    const done3 = [node('a', 'done', [], 0, 20), node('b', 'done', ['a'], 20, 40), node('c', 'done', ['b'], 40, 60)]
    // 第 1 層：進行中（已用 5 分）與兩個未開始並行 → max(20 − 5, 20, 20) = 20；第 2 層 → 20
    const map = mk([...done3, node('d', 'doing', ['c'], 65), node('e', 'todo', ['c']), node('g', 'todo', ['c']), node('f', 'todo', ['d', 'e', 'g'])])
    expect(etaRange(map, Date.parse(at(70)))).toEqual({ lo: 40, hi: 40, n: 3, rough: true })
    // 只剩進行中的一步、已用了比一般更長的時間 → 0，不會是負數
    expect(etaRange(mk([...done3, node('d', 'doing', ['c'], 0)]), Date.parse(at(70)))).toMatchObject({ lo: 0, hi: 0 })
    // 進行中已用 10 分，一般用時 20–40 → 還需 10–30
    const spread = [node('a', 'done', [], 0, 20), node('b', 'done', ['a'], 20, 40), node('x', 'done', [], 0, 40), node('y', 'done', [], 0, 40), node('z', 'done', [], 0, 40)]
    expect(etaRange(mk([...spread, node('d', 'doing', [], 60)]), Date.parse(at(70)))).toMatchObject({ lo: 10, hi: 30 })
  })

  test('the range widens with the spread of finished times; under 3 timed steps nothing is shown; under 6 it is marked rough', () => {
    const even = mk([node('a', 'done', [], 0, 25), node('b', 'done', [], 0, 25), node('c', 'done', [], 0, 25), node('d', 'done', [], 0, 25), node('t', 'todo', [])])
    const uneven = mk([node('a', 'done', [], 0, 10), node('b', 'done', [], 0, 20), node('c', 'done', [], 0, 30), node('d', 'done', [], 0, 40), node('t', 'todo', [])])
    const now = Date.parse(at(100))
    const e = etaRange(even, now)!
    const u = etaRange(uneven, now)!
    expect([e.lo, e.hi]).toEqual([25, 25])
    expect([u.lo, u.hi]).toEqual([18, 33]) // p25 = 17.5、p75 = 32.5
    expect(u.hi - u.lo).toBeGreaterThan(e.hi - e.lo)
    expect(etaText(uneven, now, 'en')).toBe('rough 18–33m')
    expect(etaText(uneven, now, 'zh-Hant')).toBe('約 18–33 分鐘')
    const two = mk([node('a', 'done', [], 0, 10), node('b', 'done', [], 0, 20), node('t', 'todo', [])])
    expect([etaRange(two, now), etaText(two, now, 'en')]).toEqual([undefined, ''])
    const six = mk([...[1, 2, 3, 4, 5, 6].map(i => node(`d${i}`, 'done', [], 0, 30 + i * 10)), node('t', 'todo', [])])
    expect(etaRange(six, now)!.rough).toBe(false)
    expect(etaText(six, now, 'en')).toBe('≈ 53m–1h 18m')
  })

  test('the band and the pane show the range; the pane bar explains how it is computed', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const band = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await svgText(band)).toMatch(/rough \d+h\d*m?–\d+h/)
    await band.unmount()
    const pane = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 120 } as never })
    expect(await allText(pane)).toMatch(/rough \d+h( \d+m)?–\d+h/)
    const bar = (await pane.findAll({ type: 'Svg' })).find(s => String(s.props.alt).includes('middle half'))
    expect(String(bar?.props.alt)).toContain('the middle half of 5 finished steps')
    await pane.unmount()
  })
})

describe('export', () => {
  test('markdown: title, progress, every stage with checkboxes, owners, times, inserted notes', () => {
    const now = Date.parse(NOW)
    const md = exportMarkdown(demoMap(now, 'en'), 'en', now)
    for (const line of [
      '# demo',
      '**Progress:** 5/12 · 3 in progress · 1 blocked',
      '## ✓ 5 done',
      '- [x] Gather needs — me · 10m',
      '## Stage 1 · 3 parallel',
      '- [ ] Card layout — Builder · In progress · 25m',
      '  - ◇ Added by you',
      '“Follow the system light/dark”',
      '- [ ] Screenshots — Blocked · waits for Dark theme',
      '## Stage 4',
      '- [ ] Release',
    ])
      expect([line, md.includes(line)]).toEqual([line, true])
  })

  test('/workflow export writes only the export file and copies it; the pane button does the same and toasts', async ($, on) => {
    const files: Record<string, string> = {}
    const w = world(on, files)
    const copied: string[] = []
    on('ui.copy', ($, e) => {
      copied.push(e.text)
      return { value: { isCopied: true } } as never
    })
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: [{ id: 'a', title: 'first step', status: 'doing' }, { id: 'b', title: 'second', deps: ['a'] }] })
    const before = Object.keys(files).sort()
    const r = await $.command.run({ command: 'workflow', args: 'export', origin: { kind: 'composer' } } as never)
    expect(JSON.stringify(r)).toContain('.claude/workflow-map.export.md')
    const out = `${ROOT}/.claude/workflow-map.export.md`
    expect(files[out]).toContain('- [ ] first step')
    expect(Object.keys(files).sort()).toEqual([...before, out].sort())
    expect(copied[0]).toBe(files[out])
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 120 } as never })
    await ui.press({ key: 'export' })
    expect(w.toasts.at(-1)).toBe('Exported to .claude/workflow-map.export.md (also copied)')
    await ui.unmount()
  })
})

describe('undo', () => {
  test('undo restores the previous plan as a new write, model ops included; the stack keeps 10', async ($, on) => {
    const files: Record<string, string> = {}
    const w = world(on, files)
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: [{ id: 'A', title: 'Alpha' }, { id: 'B', title: 'Beta', deps: ['A'] }] })
    await $.tool.call({ tool: TOOL, op: 'status', id: 'A', status: 'doing' })
    const node = (id: string) => cur(files).nodes.find((n: { id: string }) => n.id === id)
    expect(node('A').status).toBe('doing')
    await w.clock.advance(60_000)
    const r = await $.command.run({ command: 'workflow', args: 'undo', origin: { kind: 'composer' } } as never)
    expect(JSON.stringify(r)).toContain('Undid: Alpha → In progress')
    expect(node('A').status).toBe('todo')
    // 新的一次寫入：時間是現在
    expect(node('A').updatedAt).toBe(new Date(Date.parse(NOW) + 60_000).toISOString())
    // 再還原：回到空計劃（第一次 set_plan 之前）
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 120 } as never })
    await ui.press({ key: 'undo' })
    await ui.unmount()
    // 再還原：回到建立計劃時的樣子之前（快照只在這個計劃內）→ 沒有更早的快照
    expect(cur(files).nodes.map((n: { id: string }) => n.id)).toEqual(['A', 'B'])
    const again = await $.command.run({ command: 'workflow', args: 'undo', origin: { kind: 'composer' } } as never)
    expect(JSON.stringify(again)).toContain('Nothing to undo')
    for (let i = 0; i < 12; i++) await $.tool.call({ tool: TOOL, op: 'upsert', nodes: [{ id: `n${i}`, title: `n${i}` }] })
    const planId = cur(files).planId
    expect(JSON.parse(files[`${ROOT}/.claude/workflow-map/undo/${planId}.json`]!).snapshots.length).toBe(10)
  })
})

describe('projects overview', () => {
  const OTHER = '/work/other-app'
  const otherPlan = JSON.stringify({
    schemaVersion: 2,
    version: 1,
    planId: 'p-other',
    title: 'Other app',
    updatedAt: NOW,
    nodes: [
      { id: 'x', title: 'Ship the login page', status: 'doing', deps: [] },
      { id: 'y', title: 'Write release notes', status: 'todo', deps: ['x'] },
    ],
  })
  const entry = (root: string) => ({ root, title: 'Other app', done: 0, total: 2, running: 1, updatedAt: NOW })

  test('this project registers itself; another project opens read-only and its file is never written', async ($, on) => {
    const files: Record<string, string> = { [`${OTHER}/.claude/workflow-map.json`]: otherPlan }
    world(on, files, { projectsV1: [entry(OTHER), entry('/gone/missing')] })
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: [{ id: 'a', title: 'Mine', status: 'doing' }, { id: 'b', title: 'Mine too', deps: ['a'] }] })
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 120 } as never })
    await ui.press({ key: 'projects' })
    const labels = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('project-')).map(b => b.text)
    // 本專案排第一（剛寫入），其餘照舊
    expect(labels).toEqual(['proj ·', 'other-app — Other app', 'missing — Other app'])
    expect(await allText(ui)).toContain('0/2 · 1 in progress')
    await ui.press({ key: 'project-1' })
    const all = await allText(ui)
    expect(all).toContain('Viewing other-app (read-only)')
    expect(all).toContain('Ship the login page')
    // 唯讀：沒有還原／匯出／歷史
    for (const k of ['undo', 'export', 'history']) expect(await ui.find({ key: k })).toBeUndefined()
    expect(files[`${OTHER}/.claude/workflow-map.json`]).toBe(otherPlan)
    await ui.press({ key: 'project-back' })
    expect(await allText(ui)).toContain('Mine too')
    await ui.press({ key: 'project-2' })
    expect(await allText(ui)).toContain('This plan cannot be read')
    await ui.press({ key: 'project-back' })
    await ui.unmount()
  })
})

describe('per-session plans', () => {
  test('two sessions in one root keep separate plans; new_plan never archives a plan another session uses; join shares one', async ($, on) => {
    const files: Record<string, string> = {}
    const sid = { id: 'sess-A' }
    world(on, files, {}, sid)
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'new_plan', title: 'Alpha work', nodes: [{ id: 'a1', title: 'Alpha one', status: 'doing' }] })
    const alpha = planFiles(files).at(-1)!
    // B：新 session，沒有綁定 → 看不見 A 的計劃
    sid.id = 'sess-B'
    await $.session.start(START)
    const none = JSON.stringify(await $.tool.call({ tool: TOOL, op: 'show' }))
    expect(none).toContain('No workflow plan is bound to this session')
    expect(none).toContain('Alpha work')
    await $.tool.call({ tool: TOOL, op: 'new_plan', title: 'Beta work', nodes: [{ id: 'b1', title: 'Beta one' }] })
    expect(planFiles(files).length).toBe(2)
    expect(JSON.parse(files[alpha]!).archivedAt).toBeUndefined()
    expect(JSON.stringify(await $.tool.call({ tool: TOOL, op: 'show' }))).not.toContain('Alpha one')
    // B 加入 A 的計劃：兩個 session 看同一份
    await $.tool.call({ tool: TOOL, op: 'join', plan: 'Alpha work' })
    expect(JSON.stringify(await $.tool.call({ tool: TOOL, op: 'show' }))).toContain('Alpha one')
    // A 開新計劃：A 的舊計劃有 B 在用 → 不封存，只換成新計劃
    sid.id = 'sess-A'
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'new_plan', title: 'Gamma', nodes: [{ id: 'g1', title: 'Gamma one' }] })
    expect(JSON.parse(files[alpha]!).archivedAt).toBeUndefined()
    expect(Object.keys(files).filter(p => p.includes('workflow-map.history/'))).toEqual([])
    sid.id = 'sess-B'
    await $.session.start(START)
    expect(JSON.stringify(await $.tool.call({ tool: TOOL, op: 'show' }))).toContain('Alpha one')
  })

  test('the legacy shared file stays byte-for-byte untouched by a session not bound to it; reload keeps the binding', async ($, on) => {
    const legacy = JSON.stringify({ version: 1, updatedAt: NOW, nodes: [{ id: 'x', title: 'Other session work', status: 'doing', deps: [] }] })
    const files: Record<string, string> = { [FILE]: legacy }
    world(on, files)
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: [{ id: 'm', title: 'Mine', status: 'doing' }] })
    await $.tool.call({ tool: TOOL, op: 'status', id: 'm', status: 'done' })
    await $.tool.call({ tool: TOOL, op: 'new_plan', title: 'Next', nodes: [{ id: 'n', title: 'Next one' }] })
    expect(files[FILE]).toBe(legacy)
    // 重新載入（同一個 session）：仍然綁着自己的計劃
    await $.session.start(START)
    const shown = JSON.stringify(await $.tool.call({ tool: TOOL, op: 'show' }))
    expect(shown).toContain('Next one')
    expect(shown).not.toContain('Other session work')
    expect(files[FILE]).toBe(legacy)
  })

  test('/workflow join and leave; the Plans card lists the project plans', async ($, on) => {
    const legacy = JSON.stringify({ schemaVersion: 2, version: 1, planId: 'p', title: 'Shared', updatedAt: NOW, nodes: [{ id: 'x', title: 'Shared step', status: 'doing', deps: [] }] })
    const files: Record<string, string> = { [FILE]: legacy }
    world(on, files)
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 120 } as never })
    expect(await allText(ui)).toContain('This session has no plan yet')
    await ui.press({ key: 'plans' })
    expect(await allText(ui)).toContain('Shared')
    await ui.press({ key: 'join-default' })
    expect(await allText(ui)).toContain('Shared step')
    await ui.unmount()
    const r = await $.command.run({ command: 'workflow', args: 'leave', origin: { kind: 'composer' } } as never)
    expect(JSON.stringify(r)).toContain('Left the plan')
    expect(JSON.stringify(await $.tool.call({ tool: TOOL, op: 'show' }))).toContain('No workflow plan is bound')
    const j = await $.command.run({ command: 'workflow', args: 'join Shared', origin: { kind: 'composer' } } as never)
    expect(JSON.stringify(j)).toContain('Joined plan: Shared')
    expect(files[FILE]).toBe(legacy)
  })
})

describe('band ghost card and peek', () => {
  type El = { type?: string; key?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; text?: string; children?: El[] }
  const hiddenChild = (box: El | undefined) => (box?.children ?? []).find(c => c && c.type === 'Box' && c.props?.display === 'none')

  test('hidden future is a dashed ghost card at the end of the line; hovering it lists the hidden steps; no buttons in the graph', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    await ui.press({ key: 'toggle' })
    const graph = (await ui.find({ key: 'graph' })) as unknown as El
    // 一行：已完成小卡、各層的卡、幽靈卡；沒有按鈕
    expect((graph.children ?? []).filter(Boolean).map(c => c.props?.key)).toEqual(['peek-done', 'graph-main', 'peek-later'])
    expect(JSON.stringify(graph)).not.toContain('"Button"')
    const later = (await ui.find({ key: 'peek-later' })) as unknown as El
    const ghostSvg = String((later.children ?? []).find(c => c?.type === 'Svg')?.props?.source)
    expect(ghostSvg).toContain("stroke-dasharray='3 2'") // 虛線框
    expect(ghostSvg).toContain("stroke-dasharray='3 3'") // 虛線連線
    expect(ghostSvg).toContain('+2 later')
    // 指著才顯示：display none → hover display flex，向上開；列出收起的步驟
    const pop = hiddenChild(later)
    expect([pop?.props?.position, pop?.props?.bottom, pop?.hover?.display]).toEqual(['absolute', 1, 'flex'])
    expect(JSON.stringify(pop)).toContain('Real-app check')
    expect(JSON.stringify(pop)).toContain('Release')
    expect(JSON.stringify(pop)).toContain('waits for')
    // 左邊已完成小卡：指著列出已完成的步驟（負責人 · 用時）
    const done = (await ui.find({ key: 'peek-done' })) as unknown as El
    const donePop = hiddenChild(done)
    expect(JSON.stringify(donePop)).toContain('Gather needs')
    expect(JSON.stringify(donePop)).toContain('me · 10m')
    expect(donePop?.hover?.display).toBe('flex')
    await ui.unmount()
  })

  test('terminal: no hover — the hidden steps show as "+N later" text', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: /\+\d+ later/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('band connectors', () => {
  type El = { type?: string; props?: Record<string, unknown>; children?: El[] }
  // 卡片圖裏看得見的圖（不算指著才出現的清單）
  const pics = (el: El | undefined): string[] =>
    !el || el.props?.display === 'none' ? [] : el.type === 'Svg' ? [String(el.props?.source)] : (el.children ?? []).flatMap(c => pics(c ?? undefined))
  const graphOf = async (ui: { find: (q: { key: string }) => Promise<unknown> }) => (await ui.find({ key: 'graph' })) as El

  test('all done: only the done chip, no edge or port dot; its hover list stays', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: plan().nodes.map(({ id, title, deps }) => ({ id, title, deps, status: 'done' })) })
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    await ui.press({ key: 'toggle' })
    const graph = await graphOf(ui)
    expect((graph.children ?? []).filter(Boolean).map(c => c.props?.key)).toEqual(['peek-done'])
    const svg = pics(graph).join('')
    expect(svg).toContain('4 已完成')
    expect(svg).not.toMatch(/ H\d/) // 沒有線
    expect(svg).not.toContain("r='2.5'") // 沒有連接點
    expect(JSON.stringify(graph)).toContain('寫 API') // 指著仍列出已完成的步驟
    await ui.unmount()
  })

  test('the last visible card has no successor: no trailing edge or dot past it', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: plan().nodes.map(({ id, title, status, deps }) => ({ id, title, status, deps })) })
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ key: 'peek-later' })).toBeUndefined()
    const main = pics((await ui.find({ key: 'graph-main' })) as El).join('')
    const right = Math.max(...[...main.matchAll(/<rect x='([\d.]+)' y='[\d.]+' width='([\d.]+)'[^>]*rx='4'/g)].map(m => Number(m[1]) + Number(m[2])))
    const ends = [...main.matchAll(/cx='([\d.]+)'[^>]*r='2.5'/g), ...main.matchAll(/ H([\d.]+)/g)].map(m => Number(m[1]))
    expect(ends.length).toBeGreaterThan(0)
    for (const x of ends) expect(x).toBeLessThan(right)
    // 已完成小卡後面有卡：有線
    expect(pics((await ui.find({ key: 'peek-done' })) as El).join('')).toMatch(/ H\d/)
    await ui.unmount()
  })
})

describe('auto plan (the plugin itself keeps Claude on the plan)', () => {
  type E = { prompt: { compose: (x: never) => Promise<unknown> } }
  const guide = async ($: E, tools: string[] = [TOOL]) =>
    ((await $.prompt.compose({ tools, model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [] } as never)) as { sections: { id: string; text: string }[] }).sections.find(s => s.id === 'workflow-map:guide')?.text
  // 內建工具的替身：照收照答（TaskCreate 回覆 task id）
  const builtins = (on: On) => {
    let n = 0
    on('tool.call', { tool: ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'Bash', 'Edit'] }, ($, e) => {
      const x = e as unknown as Record<string, unknown>
      if (x.tool === 'TaskCreate') return { result: { task: { id: String(++n), subject: x.subject } } } as never
      return { result: { success: true } } as never
    })
  }
  const todos = (...items: [string, string][]) => ({ tool: 'TodoWrite', todos: items.map(([content, status]) => ({ content, status, activeForm: content })) })
  const steps = (files: Record<string, string>) =>
    (cur(files).nodes as { id: string; title: string; status: string; deps: string[]; owner?: string }[]).map(n => [n.id, n.title, n.status, n.deps.join(','), n.owner ?? ''])
  const MADE = 'Workflow created from the to-do list'

  test('autoPlan on: the session prompt carries the firm plan rule, only when the tool is offered', async ($, on) => {
    world(on, {})
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start(START)
    const text = (await guide($)) ?? ''
    for (const s of ['3+ steps', 'new_plan', 'doing', 'done or blocked', 'insert', 'BEFORE acting', '[wm:<step id>]', "user's language"]) expect(text).toContain(s)
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(120)
    for (const s of ['lane', 'edgeLabel']) expect(text).toContain(s)
    expect(await guide($, [])).toBeUndefined()
  })

  test('autoPlan off: only the short note', { options: { autoPlan: false } }, async ($, on) => {
    world(on, {})
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start(START)
    const text = (await guide($)) ?? ''
    expect(text).toContain('only when the user asks')
    expect(text).not.toContain('BEFORE acting')
    expect(text.split(/\s+/).length).toBeLessThan(40)
  })

  test('TodoWrite with no plan: exactly one plan from the list (owner auto, in order), one toast, statuses follow later updates', async ($, on) => {
    const files: Record<string, string> = {}
    const { toasts } = world(on, files)
    builtins(on)
    await $.session.start(START)
    await $.tool.call(todos(['Read the code', 'in_progress'], ['Fix the bug', 'pending'], ['Run the tests', 'pending']) as never)
    expect(planFiles(files).length).toBe(1)
    expect(steps(files)).toEqual([
      ['t1', 'Read the code', 'doing', '', 'auto'],
      ['t2', 'Fix the bug', 'todo', 't1', 'auto'],
      ['t3', 'Run the tests', 'todo', 't2', 'auto'],
    ])
    expect(toasts.filter(x => x === MADE).length).toBe(1)
    await $.tool.call(todos(['Read the code', 'completed'], ['Fix the bug', 'in_progress'], ['Run the tests', 'pending'], ['Write the notes', 'pending']) as never)
    expect(planFiles(files).length).toBe(1)
    expect(steps(files).map(s => [s[0], s[2], s[3]])).toEqual([
      ['t1', 'done', ''],
      ['t2', 'doing', 't1'],
      ['t3', 'todo', 't2'],
      ['t4', 'todo', 't3'],
    ])
    expect(toasts.filter(x => x === MADE).length).toBe(1)
    // 子代理的待辦清單不算
    await $.tool.call({ ...todos(['Read the code', 'pending'], ['x', 'pending'], ['y', 'pending']), agentId: 'ag1' } as never)
    expect(steps(files)[0]![2]).toBe('done')
  })

  test('TaskCreate / TaskUpdate: the plan starts at the third open task, later tasks join it, a deleted task is dropped', async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    builtins(on)
    await $.session.start(START)
    const create = (subject: string) => $.tool.call({ tool: 'TaskCreate', subject, description: subject } as never)
    await create('Plan')
    await create('Build')
    expect(planFiles(files).length).toBe(0)
    await create('Test')
    expect(planFiles(files).length).toBe(1)
    await create('Ship')
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as never)
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'deleted' } as never)
    expect(planFiles(files).length).toBe(1)
    expect(steps(files).map(s => [s[0], s[1], s[2], s[3]])).toEqual([
      ['t1', 'Plan', 'doing', ''],
      ['t2', 'Build', 'dropped', 't1'],
      ['t3', 'Test', 'todo', 't2'],
      ['t4', 'Ship', 'todo', 't3'],
    ])
  })

  test('a bound plan: no second plan; only steps with the same title follow the list', async ($, on) => {
    const files: Record<string, string> = {}
    const { toasts } = world(on, files)
    builtins(on)
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'new_plan', title: 'Mine', nodes: [{ id: 'a', title: 'Fix the bug' }, { id: 'b', title: 'Ship it', deps: ['a'] }] })
    await $.tool.call(todos(['Fix the bug', 'completed'], ['Something else', 'in_progress'], ['Another', 'pending']) as never)
    expect(planFiles(files).length).toBe(1)
    expect(steps(files).map(s => [s[0], s[2]])).toEqual([
      ['a', 'done'],
      ['b', 'todo'],
    ])
    expect(toasts).not.toContain(MADE)
  })

  test('autoPlan off: the to-do list never opens a plan', { options: { autoPlan: false } }, async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    builtins(on)
    await $.session.start(START)
    await $.tool.call(todos(['a', 'pending'], ['b', 'pending'], ['c', 'pending']) as never)
    expect(planFiles(files).length).toBe(0)
  })

  test('a turn of real work with no plan shows "Use /workflow" once per session, gone at the next turn', async ($, on) => {
    world(on, {})
    builtins(on)
    on('turn.complete', () => ({ text: '' }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    await $.session.start(START)
    const turn = async (id: string, calls: number) => {
      await $.turn.start({ text: 'go', turnId: id } as never)
      for (let i = 0; i < calls; i++) await $.tool.call({ tool: i % 2 ? 'Edit' : 'Bash', command: 'x' } as never)
      await $.turn.complete({ reason: 'answer', answer: 'ok', turnId: id } as never)
    }
    const hint = async () => {
      const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
      const found = await ui.find({ type: 'Text', text: 'Use /workflow to start a plan' })
      await ui.unmount()
      return !!found
    }
    await turn('t1', 2)
    expect(await hint()).toBe(false) // 少於 3 次
    await turn('t2', 3)
    expect(await hint()).toBe(true)
    await $.turn.start({ text: 'next', turnId: 't3' } as never)
    expect(await hint()).toBe(false)
    await $.turn.complete({ reason: 'answer', answer: 'ok', turnId: 't3' } as never)
    await turn('t4', 5)
    expect(await hint()).toBe(false) // 每個 session 一次
  })
})

describe('terminal (CLI)', () => {
  type El = { type?: string; text?: string; props: Record<string, unknown>; children?: El[] }
  const cellsOf = (x: string) => [...x].reduce((n, c) => n + (/[⺀-鿿가-힯豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0)
  const txt = (e: El | string | null | undefined): string => (typeof e === 'string' ? e : !e ? '' : (e.children ?? []).map(txt).join(''))
  const graphLines = async (ui: { find: (q: { key: string }) => Promise<unknown> }) =>
    (((await ui.find({ key: 'graph' })) as El | undefined)?.children ?? []).filter(Boolean).map(txt)
  const band = (cols = 100) => ({ ...(BAND_PROPS as object), bodyColumns: cols }) as never

  test('title row: status glyph in the theme colour, bold name, block bar coloured per status, count; e / f hotkeys; no Svg', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: plan().nodes.map(({ id, title, status, deps }) => ({ id, title, status, deps })) })
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'terminal', component: 'AbovePrompt', props: band() })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.find(x => x.text === '◉')?.props.color).toBe('claude')
    expect(texts.find(x => x.text === '寫 API')?.props.bold).toBe(true)
    expect(texts.find(x => x.text === '1/4')?.props.bold).toBe(true)
    const bar = texts.filter(x => /^━+$/.test(x.text))
    expect(bar.map(x => x.props.color)).toEqual(['success', 'claude', 'subtle', 'subtle'])
    expect((await ui.findAll({ type: 'Button' })).map(b => [b.props.hotkey, b.text])).toEqual([
      ['e', '展開'],
      ['f', '全圖'],
    ])
    expect(await ui.findAll({ type: 'Svg' })).toEqual([])
    await ui.unmount()
  })

  test('expanded: rounded cards joined by ─── at the first row (├───┤), done chip first, no dangling link, within the width', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: plan().nodes.map(({ id, title, status, deps }) => ({ id, title, status, deps })) })
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'terminal', component: 'AbovePrompt', props: band() })
    await ui.press({ key: 'toggle' })
    const lines = await graphLines(ui)
    expect(lines[0]!.startsWith('╭')).toBe(true)
    expect(lines[1]).toMatch(/^│ ✓ 1 已完成 ├───┤ ◉ 寫 API +.*├───┤ ○ 整合測試 +│$/) // 最後一張卡後面沒有線
    expect(lines.join('')).not.toContain('┄')
    for (const l of lines) expect(cellsOf(l)).toBeLessThanOrEqual(99)
    // 每張卡都完整（上下框成對）
    const all = lines.join('\n')
    expect((all.match(/╭/g) ?? []).length).toBe((all.match(/╯/g) ?? []).length)
    await ui.unmount()
  })

  test('narrow terminal: steps that do not fit fold into a dashed "+N later" card; never a card cut in half', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'terminal', component: 'AbovePrompt', props: band(64) })
    await ui.press({ key: 'toggle' })
    const lines = await graphLines(ui)
    expect(lines[1]).toMatch(/┄┄┄┤ \+\d+ later ┆$/)
    for (const l of lines) expect(cellsOf(l)).toBeLessThanOrEqual(63)
    const all = lines.join('\n')
    expect((all.match(/╭/g) ?? []).length).toBe((all.match(/╯/g) ?? []).length)
    // 幽靈卡是淡色
    const ghostText = (await ui.findAll({ type: 'Text' })).find(x => /^\+\d+ later$/.test(x.text))
    expect(ghostText?.props.dimColor).toBe(true)
    await ui.unmount()
  })

  test('all done: only the done chip, no link or port', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: plan().nodes.map(({ id, title, deps }) => ({ id, title, deps, status: 'done' })) })
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'terminal', component: 'AbovePrompt', props: band() })
    await ui.press({ key: 'toggle' })
    const lines = await graphLines(ui)
    expect(lines).toEqual(['╭────────────╮', '│ ✓ 4 已完成 │', '╰────────────╯'])
    await ui.unmount()
  })

  test('full view: block bar in the header, ▸ section toggles, cards without blank rows, ─ dividers, inserted step in the theme violet', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'terminal', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 72 } as never })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.filter(x => /^━+$/.test(x.text)).length).toBeGreaterThan(0)
    expect((await ui.find({ key: 'fold-done' }))?.text).toBe('▸ Done 5')
    const cards = (await ui.findAll({ type: 'Box' })).filter(b => b.props.borderStyle === 'round')
    for (const c of cards) expect([c.props.paddingX, c.props.paddingY, c.props.borderColor]).toEqual([1, 0, 'subtle'])
    // 分隔線剛好是卡內的闊度（72 − 內距 1 − 框 2 − 內距 2 = 67）
    const rules = texts.filter(x => /^─+$/.test(x.text))
    expect(rules.length).toBeGreaterThan(0)
    for (const r of rules) expect(r.text.length).toBe(67)
    expect(texts.find(x => x.text === '◇')?.props.color).toBe('claude') // 插入而且進行中
    expect(texts.find(x => x.text === 'Follow the system light/dark' || /Follow the system/.test(x.text))?.props.color).toBe('merged')
    expect(await ui.findAll({ type: 'Svg' })).toEqual([])
    await ui.unmount()
  })
})

describe('pane rows never wrap', () => {
  type El = { type?: string; key?: string; text?: string; props: Record<string, unknown>; children?: (El | string | null)[] }
  const LONG = '把卡片圖的連線改成真正的直角走線並且處理換行時的轉角與箭頭' // 30 個字
  const kids = (e: El | undefined) => (e?.children ?? []).filter((c): c is El => !!c && typeof c === 'object')
  const all = (e: El | undefined): El[] => (e ? [e, ...kids(e).flatMap(all)] : [])
  const txt = (e: El | string | null | undefined): string => (typeof e === 'string' ? e : !e ? '' : (e.children ?? []).map(txt).join(''))
  const lineOf = (row: El | undefined, key: string) => kids(row).find(c => c.props?.key === key || c.key === key)
  // 計劃：一步做了 1 小時 34 分、負責人「介面設計師」、超過 30 分鐘沒更新（久未更新）
  // 計劃檔直接寫好（開始於 94 分鐘前；不用把時鐘推前 94 分鐘，否則每 3 秒的計時器要跑上千次）
  const setup = async ($: Engine, on: On) => {
    const ago = new Date(Date.parse(NOW) - 94 * 60_000).toISOString()
    const plan = {
      schemaVersion: 2,
      version: 1,
      planId: 'p1',
      updatedAt: ago,
      nodes: [
        { id: 'a', title: LONG, status: 'doing', owner: '介面設計師', deps: [], startedAt: ago, updatedAt: ago },
        { id: 'b', title: '截圖', status: 'todo', owner: 'Grok', deps: ['a'], updatedAt: ago },
      ],
    }
    const w = world(on, { [`${PLANS}p1.json`]: JSON.stringify(plan) }, BIND('p1'))
    await $.session.start(START)
    return w
  }
  const mountPane = ($: Engine, surface: 'desktop' | 'terminal', cols: number) =>
    $.ui.mount({ plugin: 'workflow-map', surface, component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: cols } as never })

  for (const surface of ['desktop', 'terminal'] as const)
    test(`${surface}, 60 columns: only the title shrinks (ellipsis); owner · time, status and Details never wrap and stay on the row`, async ($, on) => {
      await setup($, on)
      const ui = await mountPane($, surface, 60)
      const row = (await ui.find({ key: 'row:a' })) as unknown as El
      const main = lineOf(row, 'main')
      // 第一行：圖示、標題（可縮）、空白、負責人 · 用時、狀態字、詳情（三樣都不縮）
      const parts = kids(main).map(c => [c.props.key ?? c.key ?? c.type, c.props.flexShrink])
      expect(parts.slice(1)).toEqual([
        ['title', 1],
        ['Box', undefined], // 空白（撐開）
        ['info', 0],
        ['status', 0],
        ['detail-btn', 0],
      ])
      expect(lineOf(main, 'title')?.props.minWidth).toBe(0)
      const texts = all(row).filter(e => e.type === 'Text' && e.props.wrap !== undefined)
      expect(all(row).filter(e => e.type === 'Text').every(e => e.props.wrap === 'truncate-end' || /^[◉◇✓○! ]$/.test(txt(e)))).toBe(true)
      expect(texts.map(txt)).toEqual([LONG, '介面設計師 · 1時34分', '久未更新'])
      expect(JSON.stringify(lineOf(main, 'detail-btn'))).toContain('詳情')
      expect(lineOf(row, 'meta')).toBeUndefined()
      await ui.unmount()
    })

  test('narrow pane: owner · time and status move to a second dim line; Details stays on the first', async ($, on) => {
    await setup($, on)
    const ui = await mountPane($, 'desktop', 44)
    const row = (await ui.find({ key: 'row:a' })) as unknown as El
    const main = lineOf(row, 'main')
    expect(kids(main).map(c => c.props.key ?? c.key ?? c.type).slice(1)).toEqual(['title', 'Box', 'detail-btn'])
    const meta = lineOf(row, 'meta')
    expect(kids(meta).map(c => [c.props.key, c.props.flexShrink]).slice(1)).toEqual([
      ['info', 0],
      ['status', 0],
    ])
    expect(all(meta).filter(e => e.type === 'Text' && e.props.wrap === 'truncate-end').map(e => [txt(e), e.props.dimColor ?? false, e.props.color ?? ''])).toEqual([
      ['介面設計師 · 1時34分', true, ''],
      ['久未更新', false, 'warning'],
    ])
    await ui.unmount()
  })

  test('compact time in every language; owner cut to 10 cells', () => {
    const n = { id: 'a', title: 'x', status: 'doing' as const, deps: [], owner: '特效設計師兼動畫指導', startedAt: '2026-10-08T10:00:00.000Z' }
    const at = (min: number) => ({ now: Date.parse('2026-10-08T10:00:00.000Z') + min * 60_000, staleMin: 0 })
    expect(metaOf(n, 'zh-Hant', at(94))).toBe('特效設計… · 1時34分')
    expect(metaOf({ ...n, owner: 'Grok' }, 'en', at(94))).toBe('Grok · 1h34m')
    expect(metaOf({ ...n, owner: 'Grok' }, 'ja', at(94))).toBe('Grok · 1時34分')
    expect(metaOf({ ...n, owner: 'Grok' }, 'ko', at(94))).toBe('Grok · 1h34m')
    expect(metaOf({ ...n, owner: 'Grok' }, 'zh-Hant', at(25))).toBe('Grok · 25分')
    expect(metaOf({ ...n, owner: 'Grok' }, 'en', at(25))).toBe('Grok · 25m')
  })
})

describe('band popovers (hover lists)', () => {
  type El = { type?: string; key?: string; props: Record<string, unknown>; hover?: Record<string, unknown>; children?: (El | string | null)[] }
  const kids = (e: El | undefined) => (e?.children ?? []).filter((c): c is El => !!c && typeof c === 'object')
  const all = (e: El | undefined): El[] => (e ? [e, ...kids(e).flatMap(all)] : [])
  const txt = (e: El | string | null | undefined): string => (typeof e === 'string' ? e : !e ? '' : (e.children ?? []).map(txt).join(''))
  const pop = (box: El | undefined) => kids(box).find(c => c.type === 'Box' && c.props.display === 'none')
  // 8 步已完成、1 步進行中、之後 12 步一條直線（長中文名稱、等前一步）
  const nodes = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, title: `已完成的第${i + 1}步：整理資料結構並寫入計劃檔`, status: 'done', owner: '介面設計師', deps: i ? [`d${i - 1}`] : [] })),
    { id: 'a', title: '驗證合併：控制器、熱通量、推力與姿態資料', status: 'doing', owner: 'Grok', deps: ['d7'] },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, title: `飛行介面圖示化與 SAS 模式第${i + 1}部分`, status: 'todo', deps: [i ? `l${i - 1}` : 'a'] })),
  ]
  const setup = async ($: Engine, on: On) => {
    const opened: string[] = []
    world(on, {})
    on('ui.open', ($, e) => {
      opened.push(String((e as { id?: string }).id))
      return { value: { isPlaced: true as const } }
    })
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes } as never)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    await ui.press({ key: 'toggle' })
    return { ui, opened }
  }

  test('fixed width; every item is icon + title on one line and a dim hint on one line; nothing wraps; same shape for every item', async ($, on) => {
    const { ui } = await setup($, on)
    for (const key of ['peek-later', 'peek-done']) {
      const p = pop((await ui.find({ key })) as unknown as El)
      expect([key, p?.props.width]).toEqual([key, 56]) // min(56, 140 − 4)
      expect(p?.hover?.display).toBe('flex')
      const items = kids(p).filter(c => c.type === 'Box' && c.props.flexDirection === 'column')
      expect(items.length).toBe(6)
      for (const it of items) {
        const [l1, l2] = kids(it)
        for (const [l, dim] of [
          [l1, false],
          [l2, true],
        ] as const) {
          // [圖示欄（不縮）][文字（可縮、省略號）]
          expect(kids(l).map(c => c.props.flexShrink)).toEqual([0, 1])
          const t = all(l).filter(e => e.type === 'Text')
          expect(t.map(e => [e.props.wrap, e.props.dimColor])).toEqual([['truncate-end', dim]])
        }
      }
      // 第一項：標題、提示
      const first = items[0]!
      const [title, hint] = kids(first).map(l => txt(all(l).find(e => e.type === 'Text')))
      if (key === 'peek-later') expect([title, hint]).toEqual(['飛行介面圖示化與 SAS 模式第2部分', '待 飛行介面圖示化與 SAS 模式第1部分'])
      else expect(hint).toBe('介面設計師')
    }
    await ui.unmount()
  })

  test('more than 6: a hairline, then "… 還有 N 項 · 全圖" where 全圖 is a button that opens the pane with that section unfolded', async ($, on) => {
    const { ui, opened } = await setup($, on)
    const later = pop((await ui.find({ key: 'peek-later' })) as unknown as El)
    expect(all(later).some(e => e.type === 'Markdown' && e.props.text === '---')).toBe(true)
    expect(all(later).some(e => e.type === 'Text' && /^… 還有 \d+ 項 · $/.test(txt(e)))).toBe(true)
    expect(all(later).find(e => e.type === 'Button')?.props.label).toBe('全圖')
    await ui.press({ key: 'peek-full-later' })
    await ui.press({ key: 'peek-full-done' })
    expect(opened).toEqual(['workflow-map', 'workflow-map'])
    await ui.unmount()
    const pane = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 100 } as never })
    // 稍後一段展開（稍後的卡畫出來）、已完成一段展開（已完成的卡）
    const keys = (await pane.findAll({ type: 'Box' })).map(b => String(b.key ?? b.props.key ?? ''))
    expect(keys.filter(k => k.startsWith('stage:')).length).toBeGreaterThan(3)
    expect(keys).toContain('done')
    await pane.unmount()
  })
})

// ---------------- 0.5.0：流程圖、插入的影響、插入前的計劃、時間線、紫色只限本輪 ----------------

type Box2 = { x: number; y: number; w: number; h: number }
const overlaps = (a: Box2, b: Box2) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
/** 直角線段穿過矩形內部（只碰到邊不算） */
const crosses = (p: readonly [number, number], q: readonly [number, number], r: Box2) =>
  Math.min(p[0], q[0]) < r.x + r.w && Math.max(p[0], q[0]) > r.x && Math.min(p[1], q[1]) < r.y + r.h && Math.max(p[1], q[1]) > r.y
const cellsW = (x: string) => [...x].reduce((n, c) => n + (/[⺀-鿿가-힯豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0)
const PANE = (cols: number, surface: 'desktop' | 'terminal' = 'desktop') =>
  ({ plugin: 'workflow-map', surface, component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: cols } }) as never

describe('diagram view: layout (stage rows + one bus between rows)', () => {
  const T0 = Date.parse(NOW)
  const clk = { now: T0, staleMin: 30 }
  const mid = (u: Box2) => Math.round(u.x + u.w / 2)

  test('one box per lane; links between boxes collapse to one; a lane cycle becomes a "waits for" chip, never a line upward; pairs form chains', () => {
    const m = ok(
      applyOp(
        emptyMap(),
        {
          op: 'set_plan',
          nodes: [
            { id: 'A', title: 'start' },
            { id: 'x1', title: 'x1', lane: 'X', deps: ['A'] },
            { id: 'x2', title: 'x2', lane: 'X', deps: ['A'] },
            { id: 'x2t', title: 'x2 test', lane: 'X', deps: ['x2'] },
            { id: 'y1', title: 'y1', lane: 'Y', deps: ['x1', 'x2'] },
            { id: 'x3', title: 'x3', lane: 'X', deps: ['y1'] },
          ],
        },
        NOW,
      ),
    )
    const st = flowStructure(m)
    expect(st.units.map(u => [u.id, u.members.length])).toEqual([
      ['n:A', 1],
      ['g:X', 4],
      ['g:Y', 1],
    ])
    expect(st.units.find(u => u.id === 'g:X')!.chains).toEqual([['x1'], ['x2', 'x2t'], ['x3']])
    expect(st.edges).toEqual([
      { from: 'n:A', to: 'g:X', back: false },
      { from: 'g:X', to: 'g:Y', back: false },
      { from: 'g:Y', to: 'g:X', back: true },
    ])
    expect(st.layers).toEqual([['n:A'], ['g:X'], ['g:Y']])
    const lay = layoutFlow(m, { width: 600, lang: 'en' })
    expect(lay.units.find(u => u.id === 'g:X')!.waits).toEqual(['Y'])
    expect(lay.buses.map(b => [b.ups.map(u => u.from), b.downs.map(d => d.to)])).toEqual([
      [['n:A'], ['g:X']],
      [['g:X'], ['g:Y']],
    ])
    expect(lay.stages.map(s => s.label)).toEqual(['Stage 1', 'Stage 2', 'Stage 3'])
  })

  for (const width of [320, 584, 884])
    test(`team sample at ${width}px: inside the width, no overlaps, buses only between adjacent rows and never through a box, every other wait is a chip`, () => {
      const map = teamMap(T0, 'zh-Hant')
      const lay = layoutFlow(map, { width, lang: 'zh-Hant' })
      expect(JSON.stringify(layoutFlow(teamMap(T0, 'zh-Hant'), { width, lang: 'zh-Hant' }))).toBe(JSON.stringify(lay))
      expect(Object.fromEntries(lay.units.filter(u => u.group).map(u => [u.group!, u.members.length]))).toEqual({
        共享核心: 2,
        獨立覆核: 5,
        '8 組：各自開發、模組接入、配對測試': 16,
        機動補位: 3,
        具體阻塞修復: 2,
        官方來源核對: 2,
      })
      expect(lay.units.filter(u => !u.group).length).toBe(6)
      for (const u of lay.units) {
        expect(u.x).toBeGreaterThanOrEqual(lay.gut)
        expect(u.x + u.w).toBeLessThanOrEqual(width)
        for (const c of u.cells) expect(c.x >= u.x && c.y >= u.y && c.x + c.w <= u.x + u.w && c.y + c.h <= u.y + u.h).toBe(true)
      }
      for (const [i, a] of lay.units.entries()) for (const b of lay.units.slice(i + 1)) expect([a.id, b.id, overlaps(a, b)]).toEqual([a.id, b.id, false])
      // 開發 n → 測試 n：同一行，測試緊接在右邊，中間一個短箭咀
      const build = lay.units.find(u => u.members.includes('build1'))!
      expect(build.links.length).toBe(8)
      for (let i = 1; i <= 8; i++) {
        const b = build.cells.find(c => c.id === `build${i}`)!
        const t = build.cells.find(c => c.id === `test${i}`)!
        expect([t.y, t.x - b.x]).toEqual([b.y, lay.cellW + 22])
      }
      // 每個階段一個淡色標籤
      expect(lay.stages.length).toBe(flowStructure(map).layers.length)
      // 匯流線：只連相鄰兩行；在兩行之間的空隙；上下短線由框邊開始／到框邊結束；全部線段不穿過任何框
      const byId = new Map(lay.units.map(u => [u.id, u]))
      expect(lay.buses.length).toBeGreaterThan(3)
      for (const b of lay.buses) {
        const r = new Set(b.ups.map(u => byId.get(u.from)!.row))
        const r2 = new Set(b.downs.map(d => byId.get(d.to)!.row))
        expect([r.size, r2.size, [...r2][0]! - [...r][0]!]).toEqual([1, 1, 1])
        const row = [...r][0]!
        expect(b.y).toBeGreaterThan(Math.max(...lay.units.filter(u => u.row === row).map(u => u.y + u.h)))
        expect(b.y).toBeLessThan(Math.min(...lay.units.filter(u => u.row === row + 1).map(u => u.y)))
        for (const u of b.ups) expect([u.x, u.y]).toEqual([mid(byId.get(u.from)!), byId.get(u.from)!.y + byId.get(u.from)!.h])
        for (const d of b.downs) {
          const u = byId.get(d.to)!
          // 入口在框頂：中間，或對齊附近（≤ 12px）上面的短線
          expect([d.y, Math.abs(d.x - mid(u)) <= 12, d.x >= u.x + 14 && d.x <= u.x + u.w - 14]).toEqual([u.y, true, true])
        }
        const segs: [readonly [number, number], readonly [number, number]][] = [
          [[b.x1, b.y], [b.x2, b.y]],
          ...b.ups.map(u => [[u.x, u.y], [u.x, b.y]] as [readonly [number, number], readonly [number, number]]),
          ...b.downs.map(d => [[d.x, b.y], [d.x, d.y]] as [readonly [number, number], readonly [number, number]]),
        ]
        for (const [p, q] of segs) for (const u of lay.units) expect(crosses(p, q, u)).toBe(false)
      }
      // 每條依賴：要麼在匯流線上，要麼（前置未完成）是框內的「← 待」
      const st = flowStructure(map)
      const name = (id: string) => st.units.find(u => u.id === id)!.group ?? st.units.find(u => u.id === id)!.members[0]!.title
      const done = (id: string) => st.units.find(u => u.id === id)!.members.every(m => m.status === 'done' || m.kind === 'note')
      let chips = 0
      for (const e of st.edges) {
        if (lay.buses.some(b => b.ups.some(u => u.from === e.from) && b.downs.some(d => d.to === e.to))) continue
        if (done(e.from)) continue
        expect(byId.get(e.to)!.waits).toContain(name(e.from))
        chips++
      }
      expect(chips).toBeGreaterThan(0)
      // 「← 待」只列未完成的前置
      for (const u of lay.units) for (const w of u.waits) expect(st.units.some(x => name(x.id) === w && !done(x.id))).toBe(true)
      const pic = flowSvg(map, lay, 'zh-Hant', THEMES.dark, clk)
      if (width >= 584) expect(pic.source).toContain('經：共用介面／解析入口')
      expect(pic.source).toContain('← 待 ')
      expect(pic.source.length).toBeLessThan(131072)
      expect([pic.width, pic.height]).toEqual([width, lay.height])
    })

  test('packing inside a group: pairs keep their row, singles fill the free slots', () => {
    const chains = [['a', 'a2'], ['b'], ['c', 'c2'], ['d']]
    expect(packChains(chains, 3)).toEqual([
      { chain: 0, row: 0, col: 0 },
      { chain: 1, row: 0, col: 2 },
      { chain: 2, row: 1, col: 0 },
      { chain: 3, row: 1, col: 2 },
    ])
    expect(packChains(chains, 2)).toEqual([
      { chain: 0, row: 0, col: 0 },
      { chain: 2, row: 1, col: 0 },
      { chain: 1, row: 2, col: 0 },
      { chain: 3, row: 2, col: 1 },
    ])
    // 真的版面：一對 + 兩個單格，闊的時候一行排完（不留空位），窄的時候單格同一行
    const m = ok(
      applyOp(
        emptyMap(),
        {
          op: 'set_plan',
          nodes: [
            { id: 's', title: 'Start' },
            { id: 'p1', title: 'Palette', lane: 'UI', deps: ['s'] },
            { id: 'p2', title: 'Icons', lane: 'UI', deps: ['p1'] },
            { id: 'q', title: 'Toggle', lane: 'UI', deps: ['s'] },
            { id: 'r', title: 'Login', lane: 'UI', deps: ['s'] },
          ],
        },
        NOW,
      ),
    )
    const rowsOf = (w: number) => {
      const lay = layoutFlow(m, { width: w, lang: 'en' })
      const g = lay.units.find(u => u.group === 'UI')!
      const ys = [...new Set(g.cells.map(c => c.y))].sort((a, b) => a - b)
      const pitch = lay.cellW + 22
      // 每一行由同一個左邊開始、格與格之間一個間距（沒有空位）
      for (const y of ys) {
        const xs = g.cells.filter(c => c.y === y).map(c => c.x).sort((a, b) => a - b)
        xs.forEach((x, i) => expect(x).toBe(g.x + 10 + i * pitch))
      }
      return ys.map(y => g.cells.filter(c => c.y === y).map(c => c.id).sort())
    }
    expect(rowsOf(900)).toEqual([['p1', 'p2', 'q', 'r']])
    expect(rowsOf(320)).toEqual([
      ['p1', 'p2'],
      ['q', 'r'],
    ])
  })

  test('a long "waits for" list is cut with … inside its box; the layout keeps every name', () => {
    const m = ok(
      applyOp(
        emptyMap(),
        {
          op: 'set_plan',
          nodes: [
            { id: 's', title: 'Start' },
            ...[1, 2, 3, 4, 5].map(i => ({ id: `a${i}`, title: `Long preparation step ${i}`, deps: ['s'] })),
            { id: 'm', title: 'Middle', deps: ['a1'] },
            { id: 'z', title: 'Finish', deps: ['a1', 'a2', 'a3', 'a4', 'a5', 'm'] },
          ],
        },
        NOW,
      ),
    )
    const lay = layoutFlow(m, { width: 360, lang: 'en' })
    const z = lay.units.find(u => u.id === 'n:z')!
    expect(z.waits.length).toBe(5)
    expect(z.w).toBeLessThanOrEqual(360 - lay.gut)
    const svg = flowSvg(m, lay, 'en', THEMES.dark, clk).source
    expect(svg).toMatch(/← waits for Long preparation step 1, [^<]*…</)
  })

  test('decision = dashed box, note = amber box on a dotted drop; edge labels become a "via" caption; a note is not a step and never blocks', () => {
    const m = ok(
      applyOp(
        emptyMap(),
        {
          op: 'set_plan',
          nodes: [
            { id: 'q', title: 'Ship it?', kind: 'decision', status: 'done' },
            { id: 'a', title: 'Build', deps: ['q'], edgeLabel: 'yes' },
            { id: 'n', title: 'Watch the queue', kind: 'note', deps: ['q'] },
            { id: 'b', title: 'After', deps: ['n'] },
          ],
        },
        NOW,
      ),
    )
    expect(stats(m)).toMatchObject({ done: 1, total: 3 })
    expect([...readyIds(m.nodes)]).toEqual(['a', 'b'])
    expect(stageView(m).levels.flat().map(n => n.id)).toEqual(['a', 'b'])
    const svg = flowSvg(m, layoutFlow(m, { width: 500, lang: 'en' }), 'en', THEMES.dark, clk).source
    expect(svg).toContain("stroke-dasharray='4 3'")
    expect(svg).toContain(`stroke='${THEMES.dark.block}' stroke-opacity='.8'`)
    expect(svg).toContain("stroke-dasharray='2 3'")
    expect(svg).toContain('>via yes<')
  })

  test('terminal outline: a line per box with its count, A → B pairs, ↓ between layers, nothing wider than the pane', () => {
    const map = teamMap(T0, 'zh-Hant')
    const lines = flowOutline(map, 'zh-Hant', 48, clk).map(l => l.map(s => s.text).join(''))
    for (const l of lines) expect(cellsW(l)).toBeLessThanOrEqual(48)
    expect(lines.filter(l => l.trim() === '↓').length).toBe(flowStructure(map).layers.length - 1)
    expect(lines).toContain('    ✓ 開發 1 → ✓ 測試 1')
    expect(lines.some(l => l.startsWith('共享核心 · 2 個'))).toBe(true)
    expect(lines.some(l => l.startsWith('※ 接線仍有排隊風險'))).toBe(true)
  })
})

describe('diagram view: fields and tool', () => {
  test('lane, kind and edgeLabel are kept; empty text clears them; a bad kind or a non-text lane is rejected', () => {
    let m = ok(applyOp(emptyMap(), { op: 'set_plan', nodes: [{ id: 'a', title: 'A', lane: ' Review ', kind: 'decision', edgeLabel: 'if unsure' }] }, NOW))
    expect(m.nodes[0]).toMatchObject({ lane: 'Review', kind: 'decision', edgeLabel: 'if unsure' })
    m = ok(applyOp(m, { op: 'upsert', nodes: [{ id: 'a', lane: '', kind: 'step', edgeLabel: '' }] }, LATER))
    expect(['lane', 'kind', 'edgeLabel'].filter(k => k in m.nodes[0]!)).toEqual([])
    expect(applyOp(m, { op: 'upsert', nodes: [{ id: 'a', kind: 'diamond' as never }] }, LATER)).toEqual({ error: 'a: kind must be step/decision/note' })
    expect('error' in applyOp(m, { op: 'upsert', nodes: [{ id: 'a', lane: 3 as never }] }, LATER)).toBe(true)
    expect(validateMap({ nodes: [{ id: 'a', title: 'A', status: 'todo', deps: [], kind: 7 }] })).toBe('a.kind is invalid')
    expect(textDiagram(ok(applyOp(m, { op: 'upsert', nodes: [{ id: 'a', lane: 'Review', kind: 'note' }] }, LATER)))).toContain('[note; lane: Review]')
  })

  test('the tool writes lane, kind and edgeLabel; a bad kind is denied and nothing is written', async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'new_plan', title: 'x', nodes: [{ id: 'a', title: 'A', lane: 'Review', kind: 'decision', edgeLabel: 'go' }] })
    expect(cur(files).nodes[0]).toMatchObject({ lane: 'Review', kind: 'decision', edgeLabel: 'go' })
    const before = JSON.stringify(files)
    const r = await $.tool.call({ tool: TOOL, op: 'upsert', nodes: [{ id: 'a', kind: 'circle' }] })
    expect(String(r.deny)).toContain('kind must be step/decision/note')
    expect(JSON.stringify(files)).toBe(before)
  })
})

describe('diagram view: pane', () => {
  test('the Diagram button swaps the stage cards for one picture as wide as the pane (1:1) and back; /workflow diagram opens it', async ($, on) => {
    world(on, {})
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const ui = await $.ui.mount(PANE(94))
    const big = async () => (await ui.findAll({ type: 'Svg' })).filter(s => Number(s.props.height) > 20)
    expect((await ui.find({ key: 'diagram' }))?.text).toBe('Diagram')
    expect(await big()).toEqual([])
    await ui.press({ key: 'diagram' })
    const pics = await big()
    expect(pics.length).toBe(1)
    expect([pics[0]!.props.width, pics[0]!.props.isInteractive]).toEqual([Math.round(94 * 6.4) - 16, undefined])
    expect(String(pics[0]!.props.alt)).toContain('Card layout')
    expect((await ui.find({ key: 'diagram' }))?.text).toBe('Stages')
    expect(await allText(ui)).not.toContain('Stage 1')
    await ui.press({ key: 'diagram' })
    expect(await big()).toEqual([])
    expect(await allText(ui)).toContain('Stage 1')
    await $.command.run({ command: 'workflow', args: 'diagram', origin: { kind: 'composer' } } as never)
    expect((await big()).length).toBe(1)
    await ui.unmount()
  })

  test('the toolbar (now 8 buttons) never squeezes a button: each keeps its width and the row wraps whole buttons', { options: { language: 'de' } }, async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const ui = await $.ui.mount(PANE(50))
    const row = (await ui.find({ key: 'tools' })) as unknown as { props: Record<string, unknown>; children: { props: Record<string, unknown> }[] }
    expect([row.props.flexWrap, row.props.justifyContent]).toEqual(['wrap', 'flex-end'])
    const boxes = row.children.filter(Boolean)
    expect(boxes.length).toBe(8)
    for (const b of boxes) expect(b.props.flexShrink).toBe(0)
    expect((await ui.findAll({ type: 'Button' })).map(b => b.text).slice(0, 8)).toEqual(['Diagramm', 'Zeitleiste', 'Rückgängig', 'Exportieren', 'Verlauf', 'Pläne', 'Projekte', 'Hilfe'])
    await ui.unmount()
  })

  test('/workflow-demo team shows the team sample as a diagram; the terminal draws the outline instead, no picture', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    const r = await $.command.run({ command: 'workflow-demo', args: 'team', origin: { kind: 'composer' } } as never)
    expect(JSON.stringify(r)).toContain('team sample')
    const ui = await $.ui.mount(PANE(140))
    const svg = (await ui.findAll({ type: 'Svg' })).find(s => Number(s.props.height) > 20)
    expect(String(svg?.props.source)).toContain('Independent review')
    await ui.unmount()
    const term = await $.ui.mount(PANE(60, 'terminal'))
    const texts = (await term.findAll({ type: 'Text' })).map(x => x.text)
    expect(texts).toContain('Independent review')
    expect(texts.filter(x => x === '  ↓').length).toBeGreaterThan(3)
    expect(await term.findAll({ type: 'Svg' })).toEqual([])
    await term.unmount()
  })
})

describe('mid-plan requests: impact, the plan before, timeline', () => {
  test('insert records what it changed: the added steps, the steps rewired to wait (before) and every open step downstream', () => {
    let m = ok(
      applyOp(
        emptyMap(),
        {
          op: 'set_plan',
          nodes: [
            { id: 'A', title: 'a', status: 'done' },
            { id: 'B', title: 'b', deps: ['A'] },
            { id: 'C', title: 'c', deps: ['B'] },
            { id: 'D', title: 'd', deps: ['C'] },
            { id: 'E', title: 'e', deps: ['A'] },
            { id: 'F', title: 'f', deps: ['D'], status: 'done' },
          ],
        },
        NOW,
      ),
    )
    m = ok(applyOp(m, { op: 'insert', note: 'add a check', nodes: [{ id: 'X', title: 'x', deps: ['A'] }], before: ['C'] }, LATER))
    const x = m.nodes.find(n => n.id === 'X')!
    expect(x.impact).toEqual({ added: ['X'], rewired: ['C'], downstream: ['C', 'D'] })
    expect(downstreamOf(m.nodes, ['B'])).toEqual(['C', 'D'])
    expect(detailLines(m, x, 'en')).toContain('What changed: +1 step · 1 step now waits for this · 2 downstream (c, d)')
    // set_plan 保留插入的影響
    const again = ok(applyOp(m, { op: 'set_plan', nodes: m.nodes.map(({ id, title, deps, status }) => ({ id, title, deps, status })) }, LATER))
    expect(again.nodes.find(n => n.id === 'X')!.impact).toEqual(x.impact)
  })

  test('insert saves the plan before it; Details shows the impact, marks the affected steps, and opens that plan read-only with Back', async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    await $.session.start(START)
    await $.tool.call({
      tool: TOOL,
      op: 'new_plan',
      title: 'p',
      nodes: [
        { id: 'A', title: 'Alpha', status: 'doing' },
        { id: 'B', title: 'Beta', deps: ['A'] },
        { id: 'C', title: 'Gamma', deps: ['B'] },
      ],
    })
    await $.tool.call({ tool: TOOL, op: 'insert', note: 'also lint', nodes: [{ id: 'L', title: 'Lint', deps: ['A'] }], before: ['B'] })
    const planId = cur(files).planId
    const snap = JSON.parse(files[`${ROOT}/.claude/workflow-map/snapshots/${planId}/L.json`]!)
    expect(snap.note).toBe('also lint')
    expect(snap.map.nodes.map((n: { id: string }) => n.id)).toEqual(['A', 'B', 'C'])
    expect(snap.map.nodes[1].deps).toEqual(['A'])
    const ui = await $.ui.mount(PANE(120))
    await ui.press({ key: 'detail:L' })
    let all = await allText(ui)
    expect(all).toContain('What changed: +1 step · 1 step now waits for this · 2 downstream (Beta, Gamma)')
    expect((await ui.findAll({ type: 'Text' })).filter(x => x.text === '•').map(x => x.props.color)).toEqual([THEMES.dark.ins, THEMES.dark.ins])
    const written = JSON.stringify(files)
    await ui.press({ key: 'before:L' })
    all = await allText(ui)
    for (const s of ['Plan before “Lint” was added (read-only)', '+ added: Lint', '~ now waits for it: Beta']) expect(all).toContain(s)
    expect(all).not.toMatch(/^Lint$/m)
    for (const k of ['undo', 'export', 'history', 'plans', 'timeline', 'projects']) expect(await ui.find({ key: k })).toBeUndefined()
    expect(await ui.find({ key: 'diagram' })).toBeDefined()
    expect(JSON.stringify(files)).toBe(written)
    await ui.press({ key: 'before-back' })
    expect(await allText(ui)).toMatch(/^Lint$/m)
    await ui.unmount()
  })

  test('timeline in time order: started, added, the request in the user words, status changes with who, undo; export carries it and the impact', () => {
    const t = (min: number) => new Date(Date.parse(NOW) + min * 60_000).toISOString()
    let m = ok(applyOp(emptyMap(t(0), 'Dark mode'), { op: 'set_plan', nodes: [{ id: 'A', title: 'Alpha' }, { id: 'B', title: 'Beta', deps: ['A'] }] }, t(0)))
    m = ok(applyOp(m, { op: 'status', id: 'A', status: 'doing' }, t(1), 'Builder'))
    m = ok(applyOp(m, { op: 'insert', note: 'follow the system theme', nodes: [{ id: 'X', title: 'Theme' }], before: ['B'] }, t(2)))
    m = ok(applyOp(m, { op: 'status', id: 'A', status: 'done' }, t(3), 'Builder'))
    m = ok(applyOp(m, { op: 'restore', nodes: m.nodes.map(n => (n.id === 'A' ? { ...n, status: 'doing' as const } : n)) }, t(4), 'undo'))
    expect(timeline(m, 'en').map(e => e.text)).toEqual([
      'Plan started: Dark mode',
      'Added: Alpha',
      'Added: Beta',
      'Alpha → In progress (Builder)',
      '◇ Request “follow the system theme” → Theme',
      'Alpha → Done (Builder)',
      'Undo: Alpha → In progress',
    ])
    const md = exportMarkdown(m, 'en', Date.parse(t(5)))
    expect(md).toContain('\n## Timeline\n')
    expect(md.indexOf('Plan started: Dark mode')).toBeLessThan(md.indexOf('Undo: Alpha → In progress'))
    expect(md).toContain('  - What changed: +1 step · 1 step now waits for this · 1 downstream (Beta)')
  })

  test('the Timeline button lists the events with their times, oldest first', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const ui = await $.ui.mount(PANE(120))
    expect(await allText(ui)).not.toContain('Plan started')
    await ui.press({ key: 'timeline' })
    const all = await allText(ui)
    expect(all.indexOf('Plan started')).toBeLessThan(all.indexOf('◇ Request “Follow the system light/dark” → Dark theme'))
    expect(all).toContain('Gather needs → Done (me)')
    expect((await ui.find({ key: 'timeline' }))?.text).toBe('Hide timeline')
    await ui.unmount()
  })
})

describe('inserted steps: violet only for this turn', () => {
  const at = (min: number) => new Date(Date.parse(NOW) + min * 60_000).toISOString()
  const ins = (min: number, note: string) => ({ at: at(min), by: 'user' as const, note })
  const sample = () => ({
    schemaVersion: 2,
    version: 1,
    planId: 'p1',
    title: 't',
    createdAt: at(-300),
    updatedAt: at(2),
    tombstones: [],
    nodes: [
      { id: 'a', title: 'Base', status: 'done', deps: [], doneAt: at(-200) },
      ...[1, 2, 3, 4].map(i => ({ id: `old${i}`, title: `Old ${i}`, status: 'done', deps: ['a'], inserted: ins(-180, `old ask ${i}`), startedAt: at(-170), doneAt: at(-150) })),
      { id: 'now', title: 'Done now', status: 'done', deps: ['a'], inserted: ins(-60, 'finish me'), startedAt: at(-50), doneAt: at(2) },
      { id: 'open', title: 'Still open', status: 'todo', deps: ['a'], inserted: ins(-60, 'later please') },
      { id: 'fresh', title: 'Fresh ask', status: 'todo', deps: ['a'], inserted: ins(1, 'new idea') },
    ],
  })

  test('done in earlier turns: plain done; done or added this turn: violet; added earlier and still open: neutral with a dim ◇ before the title', async ($, on) => {
    const files: Record<string, string> = { [`${PLANS}p1.json`]: JSON.stringify(sample()) }
    const w = world(on, files, BIND('p1'))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    await $.session.start(START)
    await $.turn.start({ text: 'go', turnId: 't1' } as never)
    await w.clock.advance(3 * 60_000)
    const V = THEMES.dark.ins
    // 全圖（桌面）：只有本輪的兩個用紫色圖示；舊的完成步驟沒有任何記號；未完成的舊插入：一般圖示 + 淡色 ◇
    const ui = await $.ui.mount(PANE(120))
    await ui.press({ key: 'fold-done' })
    const icons = (await ui.findAll({ type: 'Svg' })).filter(s => Number(s.props.width) === 20).map(s => String(s.props.source))
    // 本輪剛插入的那一步另有一圈擴散三次的紫色外圈（記錄了的確認），不算進「紫色圖示」
    const noPulse = (x: string) => x.replace(/<path class='q'[^>]*\/>/g, '')
    expect(icons.filter(s => noPulse(s).includes(V)).length).toBe(2)
    expect(icons.filter(s => s.includes("class='q'")).length).toBe(1)
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.filter(x => x.text === '◇').map(x => x.props.dimColor)).toEqual([true])
    expect(texts.find(x => x.text.includes('new idea'))?.props.color).toBe(V)
    expect(texts.find(x => x.text.includes('finish me'))?.props.color).toBe(V)
    expect(texts.find(x => x.text.includes('later please'))?.props.color).toBeUndefined()
    expect(texts.some(x => x.text.includes('old ask'))).toBe(false)
    await ui.unmount()
    // 終端機：◆（本輪完成）、◇ 紫（本輪加）、淡色 ◇ 記號；舊的完成步驟是一般的 ✓
    const term = await $.ui.mount(PANE(100, 'terminal'))
    const tt = await term.findAll({ type: 'Text' })
    expect(tt.filter(x => x.text === '◆').map(x => x.props.color)).toEqual(['merged'])
    expect(tt.filter(x => x.text === '◇').map(x => [x.props.color, x.props.dimColor])).toEqual([
      [undefined, true],
      ['merged', undefined],
    ])
    expect(tt.filter(x => x.text === '✓').length).toBe(5)
    await term.unmount()
    // 流程圖與展開的卡片：同一規則
    const map = sample() as unknown as WorkflowMap
    const clock = { now: Date.parse(at(3)), staleMin: 30, turnAt: Date.parse(NOW) }
    const svg = flowSvg(map, layoutFlow(map, { width: 600, lang: 'en' }), 'en', THEMES.dark, clock).source
    expect(noPulse(svg).split(V).length - 1).toBe(2)
    expect(svg.split("class='q'").length - 1).toBe(1)
    expect(svg.split('>◇<').length - 1).toBe(1)
    const band = bandGraph(map, stageView(map, { expandFuture: true }), 'en', THEMES.dark, 900, clock).main!.source
    expect([noPulse(band).split(V).length - 1, band.split('>◇<').length - 1, band.split("class='q'").length - 1]).toEqual([1, 1, 1])
    // 下一輪：本輪完成的變回一般完成；本輪加的仍未完成 → 一般圖示 + 淡色 ◇
    const next = { ...clock, now: Date.parse(at(30)), turnAt: Date.parse(at(20)) }
    const svg2 = flowSvg(map, layoutFlow(map, { width: 600, lang: 'en' }), 'en', THEMES.dark, next).source
    expect([svg2.split(V).length - 1, svg2.split('>◇<').length - 1, svg2.split("class='q'").length - 1]).toEqual([0, 2, 0])
  })
})

describe('mid-plan requests: was it recorded?', () => {
  const ASK = 'please also export the weekly report as a PDF for the team'
  const setup = async ($: Engine, on: On) => {
    const files: Record<string, string> = {}
    const w = world(on, files)
    const filled: string[] = []
    const submitted: string[] = []
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }) as never)
    on('prompt.submit', ($, e) => (submitted.push(e.text), { text: e.text }) as never)
    on('prompt.fill', ($, e) => (filled.push(e.text), { isFilled: true }) as never)
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'new_plan', title: 'p', nodes: [{ id: 'A', title: 'Alpha', status: 'doing' }, { id: 'B', title: 'Beta', deps: ['A'] }] })
    return { w, files, filled, submitted }
  }
  const typed = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  const endTurn = ($: Engine) => $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' } as never)
  const band = ($: Engine, surface: 'desktop' | 'terminal' = 'desktop') => $.ui.mount({ plugin: 'workflow-map', surface, component: 'AbovePrompt', props: BAND_PROPS })

  test('Claude records a request with insert: a short toast with the user words, and the new ◇ step pulses this turn', async ($, on) => {
    const { w } = await setup($, on)
    await $.turn.start({ text: ASK, turnId: 't1' } as never)
    await w.clock.advance(1000)
    await $.tool.call({ tool: TOOL, op: 'insert', note: ASK, nodes: [{ id: 'X', title: 'PDF export' }] })
    expect(w.toasts.at(-1)).toBe('Recorded: please also export the…')
    const ui = await band($)
    await ui.press({ key: 'toggle' })
    // 卡片圖裏那一步的圖示外一圈紫色菱形，擴散三次就停（標題行的「下一步」只是字，沒有圖示）
    const main = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.source)).filter(s => s.includes('>PDF export<') && s.includes("rx='4'"))
    expect(main.length).toBe(1)
    expect(main[0]!.split("class='q'").length - 1).toBe(1)
    expect(main[0]).toContain('animation:wmq 1.4s ease-out 3')
    await ui.unmount()
  })

  test('a typed request that ends the turn with no plan op: "Not on the plan: …" with Add to plan (draft only) and ✕; once per message', async ($, on) => {
    const { filled, submitted } = await setup($, on)
    await typed($, ASK)
    await endTurn($)
    const ui = await band($)
    const texts = async () => (await ui.findAll({ type: 'Text' })).map(x => x.text)
    expect(await texts()).toContain('Not on the plan: please also…')
    const before = submitted.length
    await ui.press({ key: 'add-to-plan' })
    expect(filled).toEqual([`Add this to the plan: ${ASK}`])
    expect(submitted.length).toBe(before) // 從不自動送出
    expect((await texts()).some(x => x.startsWith('Not on the plan'))).toBe(false)
    // 同一則訊息不會再提示
    await endTurn($)
    expect((await texts()).some(x => x.startsWith('Not on the plan'))).toBe(false)
    // 新的一則：再提示；✕ 收起
    await typed($, 'and also send the PDF to the whole team by email please')
    await endTurn($)
    expect((await texts()).some(x => x.startsWith('Not on the plan: and also send'))).toBe(true)
    await ui.press({ key: 'unrecorded-dismiss' })
    expect((await texts()).some(x => x.startsWith('Not on the plan'))).toBe(false)
    await ui.unmount()
  })

  test('no "Not on the plan" when Claude touched the plan that turn, or for an acknowledgement; the terminal shows the same row with keys', async ($, on) => {
    await setup($, on)
    await typed($, ASK)
    await $.tool.call({ tool: TOOL, op: 'status', id: 'A', status: 'done' })
    await endTurn($)
    await typed($, 'ok')
    await endTurn($)
    const ui = await band($)
    expect((await ui.findAll({ type: 'Text' })).some(x => x.text.startsWith('Not on the plan'))).toBe(false)
    await ui.unmount()
    await typed($, ASK)
    await endTurn($)
    const term = await band($, 'terminal')
    expect((await term.findAll({ type: 'Text' })).some(x => x.text === 'Not on the plan: please also…')).toBe(true)
    expect((await term.findAll({ type: 'Button' })).filter(b => ['add-to-plan', 'unrecorded-dismiss'].includes(String(b.key))).map(b => b.props.hotkey)).toEqual(['a', 'x'])
    await term.unmount()
  })
})

describe('mid-plan requests: show the changes on the plan', () => {
  test('planDiff: added, rewired (with the new step it now waits for), moved to a later stage, removed, and everything downstream', () => {
    const before = ok(
      applyOp(
        emptyMap(),
        {
          op: 'set_plan',
          nodes: [
            { id: 'A', title: 'a', status: 'done' },
            { id: 'B', title: 'b', deps: ['A'] },
            { id: 'C', title: 'c', deps: ['B'] },
            { id: 'D', title: 'd', deps: ['C'] },
            { id: 'E', title: 'e', deps: ['A'] },
            { id: 'F', title: 'f', deps: ['A'] },
          ],
        },
        NOW,
      ),
    )
    let after = ok(applyOp(before, { op: 'insert', note: 'x', nodes: [{ id: 'X', title: 'x', deps: ['B'] }], before: ['C'] }, LATER))
    after = ok(applyOp(after, { op: 'status', id: 'E', status: 'dropped' }, LATER))
    after = ok(applyOp(after, { op: 'remove', ids: ['F'] }, LATER))
    expect(planDiff(before, after)).toEqual({
      added: ['X'],
      rewired: [{ id: 'C', via: ['X'] }],
      moved: [
        { id: 'C', from: 3, to: 4 },
        { id: 'D', from: 4, to: 5 },
      ],
      blocked: ['D'],
      removed: [
        { id: 'E', title: 'e' },
        { id: 'F', title: 'f' },
      ],
    })
    expect(planDiff(after, after)).toEqual({ added: [], rewired: [], moved: [], blocked: [], removed: [] })
  })

  test('Details → Show changes marks the current plan (+, ~ now waits for ◇X, stage a → b, ●, struck removed) read-only; Before | After switch; Back', async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    await $.session.start(START)
    await $.tool.call({
      tool: TOOL,
      op: 'new_plan',
      title: 'p',
      nodes: [
        { id: 'A', title: 'Alpha', status: 'doing' },
        { id: 'B', title: 'Beta', deps: ['A'] },
        { id: 'C', title: 'Gamma', deps: ['B'] },
        { id: 'Z', title: 'Zeta', deps: ['A'] },
      ],
    })
    await $.tool.call({ tool: TOOL, op: 'insert', note: 'also lint', nodes: [{ id: 'L', title: 'Lint', deps: ['A'] }], before: ['B'] })
    await $.tool.call({ tool: TOOL, op: 'remove', ids: ['Z'] })
    const ui = await $.ui.mount(PANE(120))
    await ui.press({ key: 'detail:L' })
    expect((await ui.findAll({ type: 'Button' })).filter(b => ['changes:L', 'before:L'].includes(String(b.key))).map(b => b.text)).toEqual(['Show changes', 'Plan before this request'])
    const written = JSON.stringify(files)
    await ui.press({ key: 'changes:L' })
    const texts = await ui.findAll({ type: 'Text' })
    const all = texts.map(x => x.text).join('\n')
    for (const s of ['Changes since “Lint” was added', '+ added · ~ now waits for it', 'now waits for ◇Lint', 'Stage 2 → 3', 'Stage 3 → 4']) expect(all).toContain(s)
    expect(texts.filter(x => x.text === '+').map(x => x.props.color)).toEqual([THEMES.dark.done])
    expect(texts.filter(x => x.text === '~').map(x => x.props.color)).toEqual([THEMES.dark.ins])
    expect(texts.filter(x => x.text === '●').map(x => x.props.color)).toEqual(['warning'])
    expect(texts.find(x => x.text === 'Zeta')?.props.strikethrough).toBe(true)
    for (const k of ['undo', 'export', 'history', 'plans', 'timeline', 'projects']) expect(await ui.find({ key: k })).toBeUndefined()
    // 流程圖：綠框（新增）、紫框（改為等它）、「2→3」、刪除線的已移除
    await ui.press({ key: 'diagram' })
    const svg = String((await ui.findAll({ type: 'Svg' })).find(s => Number(s.props.height) > 20)?.props.source)
    expect(svg).toContain(`fill='none' stroke='${THEMES.dark.done}' stroke-width='1.5'`)
    expect(svg).toContain(`fill='none' stroke='${THEMES.dark.ins}' stroke-width='1.5'`)
    expect(svg).toContain('>2→3<')
    expect(svg).toContain('>Zeta<')
    await ui.press({ key: 'diagram' })
    // 插入前 | 插入後
    await ui.press({ key: 'side-before' })
    expect(await allText(ui)).toContain('Plan before “Lint” was added (read-only)')
    await ui.press({ key: 'side-after' })
    expect(await allText(ui)).toContain('Changes since “Lint” was added')
    await ui.press({ key: 'before-back' })
    const back = await allText(ui)
    expect(back).not.toContain('Changes since')
    expect(back).not.toContain('now waits for ◇Lint')
    expect(JSON.stringify(files)).toBe(written)
    await ui.unmount()
  })
})

// ---------------- 0.6.1：固定字不截、改動畫面不重複、標題一定看得見、負責人短名、指著卡片圖看完整名稱 ----------------

describe('0.6.1', () => {
  test('diagram: every stage label and "Removed" are drawn whole in all 7 languages; the left column fits the longest', () => {
    const marks = { added: new Set<string>(), rewired: new Set<string>(), moved: new Map<string, string>(), blocked: new Set<string>(), removed: ['Old step'] }
    // 12 個階段（一條直線）：最長的階段字是「階段 12」
    const m = ok(applyOp(emptyMap(), { op: 'set_plan', nodes: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `Step ${i + 1}`, deps: i ? [`s${i - 1}`] : [] })) }, NOW))
    for (const lang of LANGS) {
      const lay = layoutFlow(m, { width: 600, lang, removed: true })
      const svg = flowSvg(m, lay, lang, THEMES.dark, { now: 0, staleMin: 0 }, new Set(), marks).source
      expect(lay.stages.length).toBe(12)
      for (const label of [...lay.stages.map(s => s.label), STR[lang].removedTitle]) {
        expect([lang, label, svg.includes(`>${label}</text>`)]).toEqual([lang, label, true])
        expect([lang, label, gutterW(label) <= lay.gut]).toEqual([lang, label, true])
      }
    }
  })

  test('Show changes: the new step a rewired step waits for is only in the violet line; the grey "waits for" keeps the others or goes away', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.tool.call({
      tool: TOOL,
      op: 'new_plan',
      title: 'p',
      nodes: [
        { id: 'S', title: 'Setup', status: 'done' },
        { id: 'A', title: 'Alpha', status: 'doing' },
        { id: 'B', title: 'Beta', deps: ['A'] },
        { id: 'C', title: 'Gamma', deps: ['S'] },
      ],
    })
    await $.tool.call({ tool: TOOL, op: 'insert', note: 'sync too', nodes: [{ id: 'L', title: 'Sync across devices', deps: ['S'] }], before: ['B', 'C'] })
    const ui = await $.ui.mount(PANE(120))
    await ui.press({ key: 'detail:L' })
    await ui.press({ key: 'changes:L' })
    const all = await allText(ui)
    // Beta 仍等 Alpha（灰色一行只剩 Alpha）；Gamma 只等新步驟（灰色一行不見了）；兩步都有紫色一行
    expect(all.match(/now waits for ◇Sync across devices/g)?.length).toBe(2)
    expect(all).toContain('← waits for Alpha')
    expect(all).not.toMatch(/← waits for[^\n]*Sync across devices/)
    expect(JSON.stringify(await ui.find({ key: 'row:C' }))).not.toContain('← waits for')
    // 離開改動畫面：灰色一行照舊列出全部前置
    await ui.press({ key: 'before-back' })
    expect(await allText(ui)).toMatch(/← waits for[^\n]*Sync across devices/)
    await ui.unmount()
  })

  test('at rest every step title is drawn as visible native text (never transparent, never left to another element), on every surface', async ($, on) => {
    const LONG = 'Wire the export button to the new PDF renderer and the share sheet'
    world(on, {})
    await $.session.start(START)
    await $.tool.call({
      tool: TOOL,
      op: 'set_plan',
      nodes: [
        { id: 'a', title: LONG, status: 'doing', owner: 'general-purpose' },
        { id: 'b', title: '整理需求', status: 'blocked', owner: 'me', deps: [] },
        { id: 'c', title: 'Docs', deps: ['a'] },
      ],
    } as never)
    await $.tool.call({ tool: TOOL, op: 'insert', note: 'please also post it', nodes: [{ id: 'p', title: '確認後發帖', deps: ['b'] }], before: ['c'] })
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount(PANE(70, surface))
      expect([surface, (await ui.findAll({ type: 'Client' })).length]).toEqual([surface, 0])
      const texts = await ui.findAll({ type: 'Text' })
      for (const title of [LONG, '整理需求', '確認後發帖']) {
        const t = texts.find(x => x.text === title)
        expect([surface, title, !!t, t?.props.color === '#00000000']).toEqual([surface, title, true, false])
      }
      await ui.unmount()
    }
  })

  test('A: owner tags are short on screen (general-purpose → agent, ocx / long ids shortened, free text cut to 10 cells); the stored owner is untouched', async ($, on) => {
    expect(
      ['general-purpose', 'ocx-gpt-6-1-sol', 'ocx-grok-4-7', 'codebase-memory-scout', 'codebase-memory-auditor', 'engineering:code-review', 'Explore', 'Plan', 'Sonnet', 'me', '特效設計師兼動畫指導', 'A very long free text owner name'].map(ownerLabel),
    ).toEqual(['agent', 'gpt-6.1', 'grok-4.7', 'cm-scout', 'cm-auditor', 'code-revi…', 'Explore', 'Plan', 'Sonnet', 'me', '特效設計…', 'A very lo…'])
    const n = { id: 'a', title: 'x', status: 'doing' as const, deps: [], owner: 'general-purpose', startedAt: NOW }
    const at = { now: Date.parse(NOW) + 94 * 60_000, staleMin: 0 }
    expect([metaOf(n, 'en', at), metaOf(n, 'en', at, true)]).toEqual(['agent · 1h34m', 'general-purpose · 1h34m'])
    // 卡片右邊放不下：先拿走用時，再截負責人
    const m = ok(applyOp(emptyMap(), { op: 'set_plan', nodes: [{ id: 'a', title: 'Build', status: 'doing', owner: '特效設計師兼動畫指導' }] }, NOW))
    const svg = bandGraph(m, stageView(m), 'zh-Hant', THEMES.dark, 900, at).main!.source
    expect(svg).toContain('>特效設計…</text>')
    expect(svg).not.toContain('1時34分')
    const roomy = ok(applyOp(emptyMap(), { op: 'set_plan', nodes: [{ id: 'a', title: 'Build', status: 'doing', owner: 'general-purpose' }] }, NOW))
    expect(bandGraph(roomy, stageView(roomy), 'en', THEMES.dark, 900, at).main!.source).toContain('>agent · 1h34m</text>')
    // 介面：全圖顯示短名；計劃檔裏的負責人不變
    const files: Record<string, string> = {}
    world(on, files)
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: [{ id: 'a', title: 'Build', status: 'doing', owner: 'general-purpose' }] } as never)
    const ui = await $.ui.mount(PANE(100))
    const all = await allText(ui)
    expect(all).toMatch(/^agent · \d+m$/m)
    expect(all).not.toContain('general-purpose')
    expect(cur(files).nodes[0].owner).toBe('general-purpose')
    await ui.unmount()
  })

  test('B: hovering the card graph lists the full title and owner of every item drawn with "…" (two lines each, whole); none truncated = no list; the done / later lists are unchanged', async ($, on) => {
    type El = { type?: string; key?: string; props: Record<string, unknown>; hover?: Record<string, unknown>; children?: (El | string | null)[] }
    const kids = (e: El | undefined) => (e?.children ?? []).filter((c): c is El => !!c && typeof c === 'object')
    const all = (e: El | undefined): El[] => (e ? [e, ...kids(e).flatMap(all)] : [])
    const txt = (e: El | string | null | undefined): string => (typeof e === 'string' ? e : !e ? '' : (e.children ?? []).map(txt).join(''))
    const LONG = 'Verify the merge: controllers, heat flux, thrust and attitude data'
    world(on, {})
    await $.session.start(START)
    await $.tool.call({
      tool: TOOL,
      op: 'set_plan',
      nodes: [
        { id: 'd', title: 'Gather needs', status: 'done' },
        { id: 'a', title: LONG, status: 'doing', owner: 'codebase-memory-auditor', deps: ['d'] },
        { id: 'b', title: 'Short', status: 'doing', owner: 'A very long free text owner name', deps: ['d'] },
        { id: 'c', title: 'Fits', status: 'doing', owner: 'me', deps: ['d'] },
        { id: 'z', title: 'Release', deps: ['a', 'b', 'c'] },
      ],
    } as never)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    await ui.press({ key: 'toggle' })
    const main = (await ui.find({ key: 'graph-main' })) as unknown as El
    const pop = kids(main).find(c => c.type === 'Box' && c.props.display === 'none')
    expect([pop?.hover?.display, pop?.props.position, pop?.props.width]).toEqual(['flex', 'absolute', 56])
    const items = kids(pop).filter(c => c.type === 'Box' && c.props.flexDirection === 'column')
    // 只列畫成「…」的兩項（長標題；負責人被截的一項），每項兩行，整句（會換行），不截
    const lines = items.map(it => kids(it).map(l => all(l).find(e => e.type === 'Text')!))
    expect(lines.map(([t, h]) => [txt(t), txt(h)])).toEqual([
      [LONG, 'codebase-memory-auditor · 0m'],
      ['Short', 'A very long free text owner name · 0m'],
    ])
    expect(lines.flat().map(e => e.props.wrap)).toEqual(['wrap', 'wrap', 'wrap', 'wrap'])
    // 原有的「已完成」清單不變（一行、省略號）
    const done = kids((await ui.find({ key: 'peek-done' })) as unknown as El).find(c => c.type === 'Box' && c.props.display === 'none')
    expect(all(done).filter(e => e.type === 'Text').every(e => e.props.wrap === 'truncate-end')).toBe(true)
    await ui.unmount()
    // 全部放得下：卡片圖沒有清單
    await $.tool.call({ tool: TOOL, op: 'new_plan', title: 'q', nodes: [{ id: 'x', title: 'Build UI', status: 'doing', owner: 'Astra' }, { id: 'y', title: 'Docs', deps: ['x'] }] } as never)
    const ui2 = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    const main2 = (await ui2.find({ key: 'graph-main' })) as unknown as El
    expect(kids(main2).map(c => c.type)).toEqual(['Svg'])
    await ui2.unmount()
  })
})
