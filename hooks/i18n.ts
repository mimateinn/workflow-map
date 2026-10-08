// 介面字串（步驟名稱照模型所寫，不翻譯）。types 沒有語系 API，所以由 userConfig `language` 決定；
// "auto" 時看步驟名稱有沒有中日韓文字。
import type { WorkflowStatus } from '../types/index'

export type Lang = 'zh' | 'en'

const CJK = /[㐀-鿿豈-﫿]/

export function pickLang(setting: unknown, sample: string): Lang {
  if (setting === 'en') return 'en'
  if (setting === 'zh-Hant') return 'zh'
  return CJK.test(sample) ? 'zh' : 'en'
}

export type Strings = {
  status: Record<WorkflowStatus, string>
  ready: string
  parallel: (titles: string) => string
  waits: (titles: string) => string
  inserted: (note: string) => string
  list: string
  open: string
  close: string
  progress: string
  doing: string
  next: string
  insertCount: string
  allDone: string
  progressTip: (done: number, total: number) => string
  unlogged: string
  unloggedTip: string
  moreTip: (n: number) => string
  steps: string
  insertLog: string
  noInserts: string
  stepLabel: (title: string, status: string) => string
  empty: string
  paneTitle: string
  paneOpened: string
  commandDesc: string
  demoDesc: string
  demoOn: string
  demoOff: string
  corrupt: (problem: string, backup: string) => string
  readFail: (err: string) => string
  more: (n: number) => string
  secDoing: string
  secNext: string
  doneCount: (n: number) => string
  hide: string
  waitShort: (titles: string) => string
}

export const STR: Record<Lang, Strings> = {
  zh: {
    status: { done: '已完成', doing: '進行中', todo: '未開始', blocked: '受阻', dropped: '已取消' },
    ready: '可開始',
    parallel: t => `並行：${t}`,
    waits: t => `待 ${t} 完成`,
    inserted: n => `插入：${n}`,
    list: '、',
    open: '（',
    close: '）',
    progress: '進度',
    doing: '進行中：',
    next: '下一步：',
    insertCount: '插入',
    allDone: '全部完成',
    progressTip: (d, t) => `已完成 ${d} 項，共 ${t} 項`,
    unlogged: '新要求未記錄',
    unloggedTip: '你剛發出的新要求尚未記入工作流程',
    moreTip: n => `另有 ${n} 項，按此開啟全圖`,
    steps: '步驟',
    insertLog: '插入記錄',
    noInserts: '尚無插入。',
    stepLabel: (t, s) => `（步驟：${t}，${s}）`,
    empty: '尚無工作流程。開始多步驟工作時會自動顯示。',
    paneTitle: '工作流程',
    paneOpened: '已開啟工作流程全圖。',
    commandDesc: '開啟工作流程全圖與插入記錄',
    demoDesc: '顯示／關閉示範工作流程（不影響真資料）',
    demoOn: '已顯示示範工作流程（只在畫面，不寫檔）。再執行 /workflow-demo 關閉。',
    demoOff: '已關閉示範，回到真實工作流程。',
    corrupt: (p, b) => `工作流程檔已損壞（${p}），原檔已備份為 ${b}，現重新開始。`,
    readFail: e => `無法讀取工作流程檔：${e}`,
    more: n => `另有 ${n} 項，請開啟全圖查看。`,
    secDoing: '進行中',
    secNext: '接下來',
    doneCount: n => `已完成 ${n} 項`,
    hide: '收起',
    waitShort: t => `待：${t}`,
  },
  en: {
    status: { done: 'Done', doing: 'In progress', todo: 'Not started', blocked: 'Blocked', dropped: 'Cancelled' },
    ready: 'ready',
    parallel: t => `parallel: ${t}`,
    waits: t => `waits for ${t}`,
    inserted: n => `added: ${n}`,
    list: ', ',
    open: ' (',
    close: ')',
    progress: 'Progress',
    doing: 'In progress: ',
    next: 'Next: ',
    insertCount: 'Added',
    allDone: 'All done',
    progressTip: (d, t) => `${d} of ${t} steps done`,
    unlogged: 'Not logged',
    unloggedTip: 'Your latest request is not on the map yet',
    moreTip: n => `${n} more — press to open the full map`,
    steps: 'Steps',
    insertLog: 'Added mid-plan',
    noInserts: 'Nothing added yet.',
    stepLabel: (t, s) => ` (step: ${t}, ${s})`,
    empty: 'No workflow yet. It appears when multi-step work starts.',
    paneTitle: 'Workflow',
    paneOpened: 'Opened the full workflow map.',
    commandDesc: 'Open the full workflow map and the log of added requests',
    demoDesc: 'Show or hide a sample workflow (does not touch your data)',
    demoOn: 'Showing a sample workflow (on screen only, nothing written). Run /workflow-demo again to hide it.',
    demoOff: 'Sample hidden; back to the real workflow.',
    corrupt: (p, b) => `The workflow file was damaged (${p}); it was backed up as ${b} and the map restarted.`,
    readFail: e => `Could not read the workflow file: ${e}`,
    more: n => `${n} more — open the full map to see them.`,
    secDoing: 'In progress',
    secNext: 'Up next',
    doneCount: n => `${n} done`,
    hide: 'Hide',
    waitShort: t => `waits for ${t}`,
  },
}
