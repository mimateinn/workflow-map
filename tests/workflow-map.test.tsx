import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { applyOp, columns, DONE_ID, emptyMap, findCycle, focusedMap, focusSet, MORE_ID, plainLines, readyIds, stageView, textDiagram } from '../hooks/graph'
import { detectLang, resolveLang } from '../hooks/i18n'
import { THEMES } from '../hooks/svg'
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
    const m = ok(applyOp(plan(), { op: 'upsert', nodes: [{ id: 'B', status: 'done' }] }, NOW))
    expect(m.nodes.find(n => n.id === 'B')).toEqual({ id: 'B', title: '寫 API', status: 'done', deps: ['A'] })
  })
})

/** 記憶體檔案系統 + 引擎底層 stub。 */
function world(on: On, files: Record<string, string>, store?: Record<string, unknown>) {
  const toasts: string[] = []
  mock.store(on, store)
  mock.clock(on, { now: Date.parse(NOW) })
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
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__workflow-map__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  return { toasts }
}

const START = { cwd: ROOT, surface: 'desktop' as const, isInteractive: true }

describe('persistence', () => {
  test('corrupt JSON is backed up, map starts empty, one toast', async ($, on) => {
    const files: Record<string, string> = { [FILE]: '{ not json' }
    const w = world(on, files)
    await $.session.start(START)
    const backups = Object.keys(files).filter(p => p.includes('.bad-'))
    expect(backups.length).toBe(1)
    expect(files[backups[0]!]).toBe('{ not json')
    expect(JSON.parse(files[FILE]!).nodes).toEqual([])
    expect(w.toasts.length).toBe(1)
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
    expect(JSON.parse(files[FILE]!).nodes.length).toBe(2)
    const bad = await $.tool.call({ tool: TOOL, op: 'upsert', nodes: [{ id: 'A', deps: ['B'] }] })
    expect(bad.deny ?? bad.text ?? '').toMatch(/cycle/)
    expect(JSON.parse(files[FILE]!).nodes[0].deps).toEqual([])
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
    // 最多兩個控制，都不是數字
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.length).toBe(2)
    for (const b of buttons) expect(b.text).not.toMatch(/\d/)

    await ui.press({ key: 'toggle' })
    const all = await ui.findAll({ type: 'Svg' })
    expect(all.length).toBe(3)
    const graph = String(all[2]!.props.source)
    // 已完成一張卡 + 「寫 API ∥ 畫 UI」同一張卡；整合測試屬較遠的一層（小計劃不收，畫第三張）
    expect((graph.match(/rx='4'/g) ?? []).length).toBe(3)
    const card = graph.split("rx='4'")[2]!
    expect(card).toContain('寫 API')
    expect(card).toContain('畫 UI')
    expect(card).not.toContain('整合測試')
    expect((await ui.findAll({ type: 'Button' })).length).toBe(2)
    await ui.unmount()
  })

  test('terminal: one text line, expands to plain lines', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, op: 'set_plan', nodes: plan().nodes.map(({ id, title, status, deps }) => ({ id, title, status, deps })) })
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect((await ui.find({ type: 'Text', text: /1\/4/ }))?.text).toContain('寫 API')
    await ui.press({ key: 'toggle' })
    // 未有用戶輸入：介面語言跟步驟名稱（繁中）
    expect(await ui.find({ type: 'Text', text: /可開始/ })).toBeDefined()
    await ui.unmount()
  })

  test('/workflow-demo shows the sample from memory and never writes the file', async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    expect(files[FILE]).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect((await ui.find({ type: 'Text', text: /卡片版面/ }))?.text).toContain('5/12')
    await ui.unmount()
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    expect(files[FILE]).toBeUndefined()
  })
})

describe('language and palette', () => {
  test('auto picks Chinese only for CJK titles; explicit setting wins', () => {
    // 跟用戶最近一次輸入的文字，不跟步驟名稱
    expect(detectLang('幫我整理這個專案的說明文件')).toBe('zh-Hant')
    expect(detectLang('帮我整理这个项目的说明文件')).toBe('zh-Hans')
    expect(detectLang('please refactor the parser module')).toBe('en')
    expect(detectLang('ok')).toBeUndefined()
    // 用戶的廣東話（繁體）一律 zh-Hant；真簡體才 zh-Hans；單一簡體字或打和不改
    for (const s of ['乜撚嘢事呀你個工作流程寫住殘體字', '我認為你檢查下類似嘅設計啦', '仲有唔該改善下嗰個縮圖右上角個16同埋加3個顯示好核突'])
      expect([s, detectLang(s)]).toEqual([s, 'zh-Hant'])
    expect(detectLang('这个工作流程显示简体字了')).toBe('zh-Hans')
    expect(detectLang('幫我睇下这度')).toBe('zh-Hant')
    expect(detectLang('工作流程这')).toBeUndefined()
    expect(detectLang('個們这们')).toBeUndefined()
    expect(resolveLang('auto', 'zh-Hans')).toBe('zh-Hans')
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
    world(on, { [FILE]: JSON.stringify(plan) }, { lang: 'zh-Hans' })
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'workflow-map', surface: 'desktop', component: 'Pane', requestId: 'workflow-map', props: { title: 'x', isFocused: false, bodyColumns: 90 } as never })
    const all = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.source)).join('')
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
    expect(await empty()).toMatch(/^No workflow/)
    await submit('这个工作流程显示简体字了', 'composer')
    expect(await empty()).toMatch(/^尚无/)
    await submit('仲有唔該改善下嗰個縮圖右上角個16同埋加3個顯示好核突', 'composer')
    expect(await empty()).toMatch(/^尚無/)
    await submit('ok', 'composer')
    expect(await empty()).toMatch(/^尚無/)
  })
})

describe('pane', () => {
  test('stage view: done in one group, open steps layered by open deps, far levels folded', () => {
    const v = stageView(plan())
    expect(v.done.map(n => n.id)).toEqual(['A'])
    expect(v.levels.map(l => l.map(n => n.id))).toEqual([['B', 'C'], ['D']])
    expect(v.later).toEqual([])
  })

  test('desktop pane: stage cards, completed folded behind a secondary toggle', async ($, on) => {
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
    const all = await svgText(ui)
    // 未有用戶輸入 → 介面語言跟步驟名稱（繁中）
    expect(all).toContain('5 / 12')
    expect(all).toContain('階段 1 · 並行 3')
    expect(all).toContain('已完成 5 項')
    expect(all).toContain('稍後 2 項')
    for (const title of ['卡片版面', '連線走法', '深色主題', '截圖說明']) expect(all).toContain(title)
    expect(all).not.toContain('整理需求')
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map(b => [b.key, b.props.variant, /\d/.test(b.text)])).toEqual([
      ['fold-done', 'secondary', false],
      ['fold-future', 'secondary', false],
    ])
    await ui.press({ key: 'fold-done' })
    expect((await ui.find({ key: 'fold-done' }))?.text).toBe('收起已完成')
    expect(await svgText(ui)).toContain('整理需求')
    await ui.press({ key: 'fold-future' })
    expect(await svgText(ui)).toContain('階段 4')
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
