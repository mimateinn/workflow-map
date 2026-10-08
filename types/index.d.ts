export type WorkflowStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'dropped'

export type WorkflowNode = {
  id: string
  title: string
  status: WorkflowStatus
  deps: string[]
  lane?: string
  /** 用戶中途插入的工作：時間、來源、內容 */
  inserted?: { at: string; by: 'user'; note: string }
  note?: string
}

export type WorkflowMap = { version: number; updatedAt: string; nodes: WorkflowNode[] }

declare module 'claude-code' {
  interface PluginState {
    'workflow-map': {
      map: WorkflowMap
      expanded: boolean
      /** 計劃進行中用戶發出新訊息，而模型尚未記錄插入 */
      pending: boolean
      /** 全部完成後經過的輪數（≥ 2 即隱藏） */
      doneTurns: number
      /** /workflow-demo 開啟時顯示示範資料（只在記憶體） */
      demo: boolean
      /** 全圖面板「已完成」一欄是否展開 */
      doneOpen: boolean
    }
  }
}
