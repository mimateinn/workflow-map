import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { applyOp, columns, DONE_ID, elapsedMin, emptyMap, etaMin, exportMarkdown, findCycle, focusedMap, focusSet, isStale, mergeMaps, migrate, MORE_ID, plainLines, readyIds, stageView, textDiagram } from '../hooks/graph'
import { detectLang, looksLikeRequest, resolveLang } from '../hooks/i18n'
import { metaOf, THEMES } from '../hooks/svg'
import { demoMap } from '../hooks/demo'
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
    // 標題行兩張 + 卡片圖：已完成小卡（+ 指著時清單的圖示）、各層的卡；沒有收起的步驟 → 沒有幽靈卡
    expect(all.length).toBe(5)
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

describe('eta', () => {
  const at = (min: number) => new Date(Date.parse(NOW) + min * 60_000).toISOString()
  const node = (id: string, status: 'done' | 'doing' | 'todo', deps: string[], started?: number, done?: number) => ({
    id,
    title: id,
    status,
    deps,
    ...(started === undefined ? {} : { startedAt: at(started) }),
    ...(done === undefined ? {} : { doneAt: at(done) }),
  })

  test('median of finished steps × stages, parallel steps counted once per stage', () => {
    const map = {
      ...emptyMap(),
      nodes: [
        node('a', 'done', [], 0, 10),
        node('b', 'done', ['a'], 10, 30),
        node('c', 'done', ['b'], 30, 60),
        // 第 1 層：進行中（已用 5 分）與未開始並行 → max(20 − 5, 20) = 20
        node('d', 'doing', ['c'], 65),
        node('e', 'todo', ['c']),
        // 第 2 層 → 20
        node('f', 'todo', ['d', 'e']),
      ],
    }
    expect(etaMin(map as never, Date.parse(at(70)))).toBe(40)
    // 少於 3 個有時間的已完成步驟：不估
    expect(etaMin({ ...map, nodes: map.nodes.filter(n => n.id !== 'a') } as never, Date.parse(at(70)))).toBeUndefined()
  })

  test('the band and the pane show ≈ time when the demo has enough timings', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const band = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await svgText(band)).toMatch(/≈ \dh/)
    await band.unmount()
    const pane = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 120 } as never })
    expect(await allText(pane)).toMatch(/≈ \dh/)
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
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(110)
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
