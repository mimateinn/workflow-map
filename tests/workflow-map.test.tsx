import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { applyOp, columns, emptyMap, findCycle, plainLines, readyIds, textDiagram } from '../hooks/graph'
import { pickLang } from '../hooks/i18n'
import { metroSvg, PALETTE } from '../hooks/svg'
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
    expect('error' in r && r.error).toMatch(/環/)
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
    expect('info' in r && r.info).toMatch(/保留/)
  })

  test('upsert changes only the given fields', () => {
    const m = ok(applyOp(plan(), { op: 'upsert', nodes: [{ id: 'B', status: 'done' }] }, NOW))
    expect(m.nodes.find(n => n.id === 'B')).toEqual({ id: 'B', title: '寫 API', status: 'done', deps: ['A'] })
  })
})

/** 記憶體檔案系統 + 引擎底層 stub。 */
function world(on: On, files: Record<string, string>) {
  const toasts: string[] = []
  mock.store(on)
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
    expect(bad.deny ?? bad.text ?? '').toMatch(/環/)
    expect(JSON.parse(files[FILE]!).nodes[0].deps).toEqual([])
  })
})

describe('band', () => {
  test('draws collapsed and expanded on desktop and terminal', async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    await $.session.start(START)
    await $.tool.call({
      tool: TOOL,
      op: 'set_plan',
      nodes: [
        { id: 'A', title: 'a', status: 'done' },
        { id: 'B', title: 'b', deps: ['A'] },
        { id: 'C', title: 'c', deps: ['A'] },
      ],
    })
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({
        plugin: 'workflow-map',
        surface,
        component: 'AbovePrompt',
        props: {
          hasSurvey: false,
          isWorking: false,
          maxRows: 30,
          bodyColumns: 100,
          scroll: { offset: 0, bodyRows: 29, contentRows: 0 },
          view: {},
        } as never,
      })
      expect(await ui.find({ key: 'toggle' })).toBeDefined()
      if (surface === 'desktop') {
        // 收起：一行膠囊（圖片模式、1:1 尺寸、透明底）
        const row = await ui.find({ type: 'Svg' })
        expect(String(row?.props?.source)).toContain('1/3')
        expect(row?.props?.isInteractive).toBeUndefined()
        // 膠囊底色不可是不透明淺色（真機深色主題會出現白塊）
        expect(String(row?.props?.source)).not.toMatch(/\.f-[a-z]+\{fill:#[ef][0-9a-f]{5}/i)
      } else {
        expect([surface, (await ui.find({ type: 'Text', text: /1\/3/ }))?.text]).toEqual([surface, expect.stringContaining('[✓1/3]')])
      }
      await ui.press({ key: 'toggle' })
      if (surface === 'desktop') expect([surface, await ui.find({ type: 'Svg' })]).toEqual([surface, expect.anything()])
      else expect([surface, await ui.find({ type: 'Text', text: /ready/ })]).toEqual([surface, expect.anything()])
      await ui.press({ key: 'toggle' })
      await ui.unmount()
    }
  })

  test('/workflow-demo shows the sample from memory and never writes the file', async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    expect(files[FILE]).toBeUndefined()
    const ui = await $.ui.mount({
      plugin: 'workflow-map',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 29 }, view: {} } as never,
    })
    expect((await ui.find({ type: 'Text', text: /改介面/ }))?.text).toContain('3/10')
    await ui.unmount()
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    expect(files[FILE]).toBeUndefined()
  })
})

describe('language and palette', () => {
  test('auto picks Chinese only for CJK titles; explicit setting wins', () => {
    expect(pickLang('auto', '整理需求')).toBe('zh')
    expect(pickLang('auto', 'Write docs')).toBe('en')
    expect(pickLang('zh-Hant', 'Write docs')).toBe('zh')
    expect(pickLang('en', '整理需求')).toBe('en')
    expect(plainLines(plan(), 'en').join(' / ')).toContain('ready')
    expect(plainLines(plan(), 'zh').join(' / ')).toContain('可開始')
  })

  test('every capsule text colour has at least 4.5:1 contrast on its own fill', () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
    }
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
      return (x! + 0.05) / (y! + 0.05)
    }
    for (const k of ['done', 'doing', 'todo', 'ready', 'blocked', 'dropped', 'ins', 'warn'] as const) {
      const p = PALETTE[k]
      expect([k, ratio(p.text, p.fill) >= 4.5]).toEqual([k, true])
    }
  })
})

describe('pane', () => {
  test('wrapped metro draws every step even when narrow', () => {
    const m = plan()
    const r = metroSvg(m, { lanes: 99, maxWidth: 200, compact: false, lang: 'zh', wrap: true })
    expect(r.hidden).toBe(0)
    for (const n of m.nodes) expect(r.source).toContain(n.title)
  })

  test('desktop pane: header, full map, grouped rows, done toggle', async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    await $.session.start(START)
    await $.command.run({ command: 'workflow-demo', args: '', origin: { kind: 'composer' } } as never)
    const ui = await $.ui.mount({
      plugin: 'workflow-map',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'workflow-map',
      props: { title: '工作流程', isFocused: false, bodyColumns: 60 } as never,
    })
    const svgs = await ui.findAll({ type: 'Svg' })
    const all = svgs.map(s => String(s.props?.source)).join('')
    for (const title of ['整理需求', '改介面', '條狀設計', '改寫說明', '發佈']) expect(all).toContain(title)
    expect(await ui.find({ type: 'Text', text: /進行中/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /接下來/ })).toBeDefined()
    expect((await ui.find({ key: 'done-toggle' }))?.text).toContain('已完成 3 項')
    await ui.press({ key: 'done-toggle' })
    expect((await ui.find({ key: 'done-toggle' }))?.text).toContain('▴')
    await ui.unmount()
  })
})
