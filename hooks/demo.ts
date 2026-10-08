// /workflow-demo 用的示範資料：只在記憶體顯示，絕不寫入 .claude/workflow-map.json。
import type { WorkflowMap } from '../types/index'

const AT = '2026-01-01T00:00:00.000Z'

export const DEMO_MAP: WorkflowMap = {
  version: 1,
  updatedAt: AT,
  nodes: [
    { id: 'req', title: '整理需求', status: 'done', deps: [] },
    { id: 'model', title: '資料結構', status: 'done', deps: ['req'] },
    { id: 'tool', title: '模型工具', status: 'done', deps: ['model'] },
    { id: 'ui', title: '改介面', status: 'doing', deps: ['model'] },
    { id: 'strip', title: '進度條', status: 'todo', deps: ['ui'] },
    { id: 'test', title: '自動測試', status: 'doing', deps: ['tool'] },
    { id: 'try', title: '實際試用', status: 'todo', deps: ['strip', 'test', 'flat'] },
    { id: 'pub', title: '發佈', status: 'todo', deps: ['try', 'readme'] },
    { id: 'flat', title: '條狀設計', status: 'todo', deps: ['ui'], inserted: { at: AT, by: 'user', note: '改成條狀，不要方框' } },
    { id: 'readme', title: '改寫說明', status: 'doing', deps: [], inserted: { at: AT, by: 'user', note: '說明書改用書面語' } },
  ],
}
