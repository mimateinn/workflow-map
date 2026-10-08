// /workflow-demo 用的示範資料：只在記憶體顯示，絕不寫入 .claude/workflow-map.json。
// 展示：已完成收成一組、三個並行（其中一個是用戶插入）、一個受阻、較遠的步驟收成「稍後」。
import type { WorkflowMap } from '../types/index'

const AT = '2026-01-01T00:00:00.000Z'

export const DEMO_MAP: WorkflowMap = {
  version: 1,
  updatedAt: AT,
  nodes: [
    { id: 'req', title: '整理需求', status: 'done', deps: [] },
    { id: 'model', title: '資料結構', status: 'done', deps: ['req'] },
    { id: 'api', title: '模型工具', status: 'done', deps: ['model'] },
    { id: 'ui', title: '介面骨架', status: 'done', deps: ['model'] },
    { id: 'lang', title: '多語文字', status: 'done', deps: ['api'] },
    { id: 'cards', title: '卡片版面', status: 'doing', deps: ['ui'] },
    { id: 'wires', title: '連線走法', status: 'doing', deps: ['ui'] },
    { id: 'dark', title: '深色主題', status: 'doing', deps: ['ui'], inserted: { at: AT, by: 'user', note: '要跟系統深淺色' } },
    { id: 'test', title: '自動測試', status: 'todo', deps: ['cards', 'wires'] },
    { id: 'shots', title: '截圖說明', status: 'blocked', deps: ['dark'], note: '等設計定稿' },
    { id: 'try', title: '實機試用', status: 'todo', deps: ['test', 'shots'] },
    { id: 'pub', title: '發佈', status: 'todo', deps: ['try', 'lang'] },
  ],
}
