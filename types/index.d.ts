export type WorkflowStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'dropped'

/** 一次狀態變化（最多保留 10 筆） */
export type NodeLogEntry = { at: string; status: WorkflowStatus; by?: string }

export type WorkflowNode = {
  id: string
  title: string
  status: WorkflowStatus
  deps: string[]
  lane?: string
  /** 用戶中途插入的工作：時間、來源、內容 */
  inserted?: { at: string; by: 'user'; note: string }
  note?: string
  /** 誰負責（自由文字：Builder、Grok、me…） */
  owner?: string
  /** 此步驟最後一次被改的時間（合併時以較新者為準） */
  updatedAt?: string
  /** 第一次變成 doing 的時間 */
  startedAt?: string
  /** 變成 done 的時間 */
  doneAt?: string
  log?: NodeLogEntry[]
}

/** 已刪除的步驟：記住刪除時間，合併時不會被舊資料復活 */
export type Tombstone = { id: string; at: string }

export type WorkflowMap = {
  /** 檔案格式版本（見 docs/FORMAT.md）；缺少 = 1 */
  schemaVersion?: number
  /** 舊欄位，一律 1，保留給舊讀者 */
  version: number
  /** 計劃 id：換計劃時改變；合併只在同一個計劃內進行 */
  planId?: string
  title?: string
  createdAt?: string
  updatedAt: string
  /** 只在歷史檔：封存時間 */
  archivedAt?: string
  nodes: WorkflowNode[]
  tombstones?: Tombstone[]
  /** 綁著這個計劃的 session id（資訊用；真正的綁定在外掛的 $.store） */
  sessions?: string[]
  /** 建立這個計劃的 session id */
  createdBy?: string
}

/** 下一句建議（併入自 next-steps） */
export type Suggestion = { label: string; prompt: string }
export type SuggestView = { kind: 'hidden' } | { kind: 'loading'; turnId: string } | { kind: 'offer'; items: Suggestion[] }

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
      /** 全圖面板「較遠的未來」是否展開 */
      futureOpen: boolean
      /** 全圖面板「歷史紀錄」是否展開 */
      historyOpen: boolean
      /** 這個 session 綁定的計劃 id（'' = 未綁定） */
      bound: string
      /** 全圖面板「計劃」清單是否展開 */
      plansOpen: boolean
      /** 全圖面板「專案」總覽是否展開 */
      projectsOpen: boolean
      /** 全圖面板正在唯讀檢視的另一個專案根目錄（'' = 本專案） */
      viewRoot: string
      /** 說明卡的語言分頁（'' = 介面語言） */
      helpLang: string
      /** 下一句建議的狀態（併入自 next-steps） */
      suggest: SuggestView
      /** 全圖面板最上面的說明卡是否打開 */
      helpOpen: boolean
      /** 全圖面板展開詳情的步驟 id（'' = 無） */
      selected: string
      /** 子代理 id → 步驟 id（[wm:<id>] 同步） */
      agents: Record<string, string>
      /** 每分鐘跳一次，令用時刷新 */
      tick: number
      /** 本輪開始時間（ms），用來判斷「本輪新插入」 */
      turnAt: number
      /** 介面語言（由用戶最近一次輸入的文字判斷） */
      lang: string
      /** app 主題是淺色（由 /config 的 theme 判斷；Svg 以圖片繪製讀不到主題） */
      light: boolean
    }
  }
}
