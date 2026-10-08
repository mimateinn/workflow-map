// UI strings. Step titles stay exactly as the model wrote them. The plugin API exposes no locale, so the
// language comes from userConfig `language`, else from the script of the user's most recent typed prompt
// (cached in $.store), else from the plan's step titles (weak evidence: the model writes them in the
// user's language), else English. Scripts detected: Han → Traditional Chinese (Simplified-only text falls back
// to English: no Simplified UI), kana → Japanese, Hangul → Korean. Latin-script languages are never guessed:
// Spanish, French and German come only from the `language` setting.
import type { WorkflowStatus } from '../types/index'

export type Lang = 'en' | 'zh-Hant' | 'ja' | 'ko' | 'es' | 'fr' | 'de'
export const LANGS: readonly Lang[] = ['en', 'zh-Hant', 'ja', 'ko', 'es', 'fr', 'de']

const HAN = /[㐀-鿿豈-﫿]/
const KANA = /[぀-ヿ]/
const HANGUL = /[가-힯ᄀ-ᇿ]/
const LATIN_LETTERS = /[A-Za-z]/g
// Characters that exist only in Simplified Chinese (common ones; enough to tell the scripts apart).
const SIMPLIFIED_ONLY = new Set(
  [...'们这说时会对发过还进个么为从乐习书买东两严临举义乱争亏云亚产亲亿仅仓仪价众优伙伞伟传伤伦体侠侣侦侧侨俩债倾偿儿兰关兴养兽军农冯决况冻净凉减凤凭凯击创删别刮制剂剑剧劝办务动励劳势区医华协单卖卢卫却厂厅历压厌县参双发变叙号叹吓吗听启员响哑园围国图圆场坏块坚坛坝坟坠垒垦墙壮声处备复够头夸夹夺奋奖妆妇妈娱孙学宁宝实宠审宪宫宽对寻导寿将尔尘尝层属岁岂岗岛岭币帅师帐带帮库应庙废开异弃张弯归当录彻忆忧怀态总恋恶悬惊惯愤愿戏战户扑执扩扫扬扰抚抢护报担拟拥择挂挡挤挥损换据摄摆摇撑敌数斗无旧显晒晓晕暂术机杀杂权条来极构枪柜标栏树样档桥梦检楼横欢欧毁毕气汇汉汤沟没泪泽洁浅测济浓涛润涨渐渔湾湿满滚灭灯灵灾炉点炼烂烟烦烧热爱爷牵独狮猎猪献环现电画疗疯盏监盖盘码确碍礼祸离种积称稳穷竞笔笼签简粮紧纠红纪纯纸纹线练组细织终经结绕绘给络绝统继绩续维综绿缓编缩网罗罚职联肃肠肤胀胜脉脏脑脚脱舰艰艺节苏范荐药获营蓝虑虽补装见观规视览觉触计订认讨让训议讯记讲许论设访证评识诉词译试诗话该详语误说请读课谁调谈谢贝负财责败货质购贯贴贵费资赏赔赚赛赞赠赶跃践转轮软轻载较辆辑输边达过运还这进远违连迟选递遗邮针钟钢钱铁银链销锁错键镜长门闭问间闻队阳阴阵际陆陈险随隐难静页顶项顺须顾顿预领题颜风飞饭馆驱验骗鱼鲜鸟鸡黄齐龙'],
)

// Characters that exist only in Traditional Chinese, plus Cantonese-only ones (written in Traditional): evidence for zh-Hant.
const TRADITIONAL_ONLY = new Set([...'們這說時會對發過還進個麼為從樂習書買東兩嚴臨舉義亂爭虧雲亞產親億僅倉儀價眾優夥傘偉傳傷倫體俠侶偵側僑倆債傾償兒蘭關興養獸軍農馮決況凍淨涼減鳳憑凱擊創刪別製劑劍劇勸辦務動勵勞勢區醫華協單賣盧衛卻廠廳歷壓厭縣參雙變敘號嘆嚇嗎聽啟員響啞園圍國圖圓場壞塊堅壇壩墳墜壘墾牆壯聲處備夠頭誇夾奪奮獎妝婦媽娛孫學寧寶實寵審憲宮寬尋導壽將爾塵嘗層屬歲豈崗島嶺幣帥師帳帶幫庫應廟廢開棄張彎歸當錄徹憶憂懷態總戀惡懸驚慣憤願戲戰戶撲執擴掃揚擾撫搶護報擔擬擁擇掛擋擠揮損換據攝擺搖撐敵數鬥無舊顯曬曉暈暫術機殺雜權條來極構槍櫃標欄樹樣檔橋夢檢樓橫歡歐毀畢氣匯漢湯溝沒淚澤潔淺測濟濃濤潤漲漸漁灣濕滿滾滅燈靈災爐點煉爛煙煩燒熱愛爺牽獨獅獵豬獻環現電畫療瘋盞監蓋盤碼確礙禮禍離種積稱穩窮競筆籠簽簡糧緊糾紅紀純紙紋線練組細織終經結繞繪給絡絕統繼績續維綜綠緩編縮網羅罰職聯肅腸膚脹勝脈臟腦腳脫艦艱藝節蘇範薦藥獲營藍慮雖補裝見觀規視覽覺觸計訂認討讓訓議訊記講許論設訪證評識訴詞譯試詩話該詳語誤請讀課誰調談謝負財責敗貨質購貫貼貴費資賞賠賺賽讚贈趕躍踐轉輪軟輕載較輛輯輸邊達運違連遲選遞遺郵針鐘鋼錢鐵銀鏈銷鎖錯鍵鏡長門閉問間聞隊陽陰陣際陸陳險隨隱難靜頁頂項順須顧頓預領題顏風飛飯館驅驗騙魚鮮鳥雞黃齊龍殘嘅咗冇喺嗰唔啲乜嘢佢冧嚟咁啱搵睇諗哋噉嘞囉喎係咩嚿攞揸畀俾'])

/**
 * Script of a typed prompt → UI language; undefined when the text says too little (keep the cached one).
 * Kana → Japanese; Hangul → Korean. Traditional is the safe default for Han text: clearly Simplified text
 * (at least 2 simplified-only characters that outnumber the traditional-only and Cantonese ones) gets the
 * English UI, since there is no Simplified UI. A lone simplified character or a tie changes nothing.
 */
export function detectLang(text: string): Lang | undefined {
  if (KANA.test(text)) return 'ja'
  if (HANGUL.test(text)) return 'ko'
  if (HAN.test(text)) {
    const chars = [...text]
    const simp = chars.filter(ch => SIMPLIFIED_ONLY.has(ch)).length
    const trad = chars.filter(ch => TRADITIONAL_ONLY.has(ch)).length
    if (simp >= 2 && simp > trad) return 'en'
    if (simp === 0 || trad > simp) return 'zh-Hant'
    return undefined
  }
  return (text.match(LATIN_LETTERS)?.length ?? 0) >= 12 ? 'en' : undefined
}

// Short acknowledgements: never an "unrecorded request" (normalised: lower case, punctuation → space).
const CONFIRM = new Set([
  ...['ok', 'okay', 'okok', 'k', 'kk', 'yes', 'yep', 'yeah', 'y', 'sure', 'go', 'go ahead', 'continue', 'next', 'thanks', 'thank you', 'thx', 'ty', 'lgtm', 'done', 'nice', 'good', 'great', 'cool'],
  ...['好', '好啊', '好呀', '好的', '好嘅', '好啦', '得', '得啦', '得喇', '可以', '可以啊', '繼續', '继续', '收到', '冇問題', '沒問題', '没问题', '係', '係呀', '是', '是的', '對', '对', '嗯', '行', '上啦', '唔該', '多謝', '謝謝', '谢谢', '辛苦晒', '做得好'],
])
const REQUEST =
  /\b(add|fix|change|make|please|can you|could you|also|update|remove|delete|create|write|check|try|why|how|need|want|should|instead)\b|幫|帮|請|请|改|加|整|唔該|可唔可以|可否|能否|修|刪|删|查|試|试|仲有|另外|順便|顺便|點解|為何|为什么|要|想/i

/**
 * Does a typed message look like a new request (worth the amber "not recorded yet" dot)?
 * No for empty / image-only text, acknowledgements, or ≤ 12 characters; yes for ≥ 15 Han characters,
 * ≥ 6 Latin words, or a request word. A heuristic: it only decides whether a hint dot shows.
 */
export function looksLikeRequest(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  const norm = t.toLowerCase().replace(/[\s.,!?！？。，、~～…:：;；]+/g, ' ').trim()
  if (!norm || CONFIRM.has(norm) || norm.split(' ').every(w => CONFIRM.has(w))) return false
  if ([...t].length <= 12) return false
  if ((t.match(/[㐀-鿿豈-﫿]/g) ?? []).length >= 15) return true
  if ((t.match(/[A-Za-z]+/g) ?? []).length >= 6) return true
  return REQUEST.test(t)
}

/** userConfig `language` (auto | en | zh-Hant | ja | ko | es | fr | de) wins; else the cached prompt language; else the plan titles' script; else English. */
export function resolveLang(setting: unknown, cached: unknown, fromTitles?: Lang): Lang {
  if (LANGS.includes(setting as Lang)) return setting as Lang
  if (LANGS.includes(cached as Lang)) return cached as Lang
  return fromTitles ?? 'en'
}

export type Strings = {
  status: Record<WorkflowStatus, string>
  ready: string
  parallel: (titles: string) => string
  waits: (titles: string) => string
  inserted: (note: string) => string
  list: string
  sep: string
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
  empty: string
  paneTitle: string
  paneOpened: string
  commandDesc: string
  demoDesc: string
  demoOn: string
  demoOff: string
  corrupt: (problem: string, backup: string) => string
  readFail: (err: string) => string
  waitShort: (titles: string) => string
  /** 收起列「下一步：」 */
  upNext: string
  /** 展開列：已完成卡、稍後卡、卡內多出的列 */
  doneCard: (n: number) => string
  laterCard: (n: number) => string
  moreRows: (n: number) => string
  /** 全圖：階段卡標題、已完成卡、稍後卡、標題行狀態 */
  stage: (i: number, parallel: number) => string
  doneStage: (n: number) => string
  laterStage: (n: number) => string
  statusLine: (doing: number, blocked: number, ready: number) => string
  showDone: string
  hideDone: string
  showLater: string
  expandTip: string
  collapseTip: string
  openTip: string
  /** 用時（分鐘）→「12 分鐘」／「12m」 */
  dur: (min: number) => string
  /** 卡片上的短格式：「25分」／「25m」 */
  durShort: (min: number) => string
  /** 進行中太久沒更新 */
  stale: string
  /** 全圖：步驟詳情 */
  dWords: string
  dWaits: string
  dUnblocks: string
  dOwner: string
  dStarted: string
  dDone: string
  dLog: string
  detailOpen: string
  detailClose: string
  history: string
  hideHistory: string
  historyEmpty: string
  /** 說明卡 */
  help: string
  helpClose: string
  helpWhat: string
  helpLegendTitle: string
  helpLegend: { done: string; doing: string; todo: string; blocked: string; ins: string; stale: string; pending: string }
  helpUseTitle: string
  helpUse: string[]
  helpAiTitle: string
  helpAi: string[]
  helpCmdTitle: string
  /** 指令與設定：鍵（指令、設定名）不翻譯，只翻值 */
  helpCmds: { workflow: string; help: string; demo: string; export: string; undo: string; language: string; staleMinutes: string; suggestions: string; notify: string; join: string; leave: string }
  /** 建議：按下計劃中可開始的步驟時，放入輸入框的開頭 */
  continueLead: string
  fillFail: string
  /** 通知（toast）：子代理完成、受阻、久未更新；同時多個時合併成一則 */
  nDone: (title: string, who: string) => string
  nBlocked: (title: string) => string
  nStale: (title: string, min: number) => string
  nBatch: (n: number, list: string) => string
  /** 剩餘時間估算的說明（替代文字） */
  etaTip: (dur: string) => string
  /** 匯出：按鈕、完成通知 */
  exportBtn: string
  exported: (path: string) => string
  /** 還原：按鈕、通知 */
  undoBtn: string
  undone: (what: string) => string
  nothingToUndo: string
  /** 說明卡第一行的「語言」 */
  languageLabel: string
  /** 彈出清單最後一行：還有幾項（後面接「全圖」按鈕） */
  peekMore: (n: number) => string
  /** 由模型的待辦清單自動建立計劃時的通知；沒有計劃但做了不少工作時的一行提示 */
  autoPlanMade: string
  nudge: string
  /** 每個 session 的計劃：清單、加入、離開 */
  plans: string
  hidePlans: string
  noPlansHere: string
  noPlanBound: string
  join: string
  switchTo: string
  leave: string
  thisSession: string
  sessionsN: (n: number) => string
  joined: (title: string) => string
  left: string
  planNotFound: (ref: string) => string
  /** 全圖分段標題（原生面板的 Running／Finished） */
  secNow: string
  secNext: string
  secDone: string
  secLater: string
  /** 跨專案總覽 */
  projects: string
  hideProjects: string
  projectsEmpty: string
  viewing: (name: string) => string
  back: string
  unavailable: string
  untitled: string
}

const ZH_HANT: Strings = {
  status: { done: '已完成', doing: '進行中', todo: '未開始', blocked: '受阻', dropped: '已取消' },
  ready: '可開始',
  parallel: t => `並行：${t}`,
  waits: t => `待 ${t} 完成`,
  inserted: n => `插入：${n}`,
  list: '、',
  sep: '；',
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
  empty: '尚無工作流程。開始多步驟工作時會自動顯示。',
  paneTitle: '工作流程',
  paneOpened: '已開啟工作流程全圖。',
  commandDesc: '開啟工作流程全圖（加 help 開啟說明）',
  demoDesc: '顯示／關閉示範工作流程（不影響真資料）',
  demoOn: '已顯示示範工作流程（只在畫面，不寫檔）。再執行 /workflow-demo 關閉。',
  demoOff: '已關閉示範，回到真實工作流程。',
  corrupt: (p, b) => `工作流程檔已損壞（${p}），原檔已備份為 ${b}，現重新開始。`,
  readFail: e => `無法讀取工作流程檔：${e}`,
  waitShort: t => `待 ${t}`,
  upNext: '下一步：',
  doneCard: n => `${n} 已完成`,
  laterCard: n => `+${n} 稍後`,
  moreRows: n => `+${n} 項`,
  stage: (i, p) => (p > 1 ? `階段 ${i} · 並行 ${p}` : `階段 ${i}`),
  doneStage: n => `已完成 ${n} 項`,
  laterStage: n => `稍後 ${n} 項`,
  statusLine: (d, b, r) => [d ? `${d} 進行中` : '', b ? `${b} 受阻` : '', !d && r ? `${r} 可開始` : ''].filter(Boolean).join(' · '),
  showDone: '顯示已完成',
  hideDone: '收起已完成',
  showLater: '顯示稍後',
  expandTip: '展開',
  collapseTip: '收起',
  openTip: '全圖',
  dur: m => (m < 1 ? '<1 分鐘' : m < 60 ? `${m} 分鐘` : `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ''}`),
  durShort: m => (m < 60 ? `${m}分` : `${Math.floor(m / 60)}時${m % 60 ? `${m % 60}分` : ''}`),
  stale: '久未更新',
  dWords: '用戶原話：',
  dWaits: '等待：',
  dUnblocks: '完成後可開始：',
  dOwner: '負責：',
  dStarted: '開始',
  dDone: '完成',
  dLog: '紀錄：',
  detailOpen: '詳情',
  detailClose: '收起',
  help: '說明',
  helpClose: '收起',
  helpWhat: '你的 AI 的工作計劃：做到哪裏、下一步、你中途加了甚麼。',
  helpLegendTitle: '圖示',
  helpLegend: { done: '已完成', doing: '進行中', todo: '未開始', blocked: '受阻', ins: '你中途加的要求', stale: '久未更新', pending: '要求未記入' },
  helpUseTitle: '使用',
  helpUse: ['「展開」／「收起」：卡片圖', '「全圖」：開啟這個全圖', '「詳情」：原話、等待、負責人、時間', '工具列：還原・匯出・歷史紀錄・計劃・專案', '1 2 3 選一句建議 · 0 收起'],
  helpAiTitle: '與 AI 合作',
  helpAi: ['每個工作階段有自己的計劃，AI 會自己更新', '做另一件事：說「開新計劃」', '子代理描述寫 [wm:<id>]，步驟自動同步'],
  helpCmdTitle: '指令與設定',
  helpCmds: {
    workflow: '開啟全圖',
    help: '開啟說明',
    demo: '顯示示範計劃',
    language: '介面語言',
    staleMinutes: '多少分鐘算久未更新（30）',
    suggestions: '下一句建議（開／關）',
    export: '把計劃寫成 Markdown（並複製）',
    undo: '還原上一次修改',
    notify: '通知（開／關）',
    join: '加入本專案的另一個計劃',
    leave: '離開目前的計劃',
  },
  nDone: (t, w) => `✓ ${t} 已完成${w ? `（${w}）` : ''}`,
  nBlocked: t => `! ${t} 受阻`,
  nStale: (t, m) => `${t}：${m} 分鐘沒有更新`,
  nBatch: (n, l) => `${n} 項更新：${l}`,
  etaTip: d => `估計還需 ${d}（按已完成步驟的用時）`,
  exportBtn: '匯出',
  exported: p => `已匯出到 ${p}（亦已複製）`,
  undoBtn: '還原',
  undone: w => `已還原：${w}`,
  nothingToUndo: '沒有可還原的操作',
  projects: '專案',
  hideProjects: '收起專案',
  projectsEmpty: '未有其他專案的計劃',
  viewing: n => `正在看 ${n}（唯讀）`,
  back: '返回',
  unavailable: '讀不到這個計劃',
  secNow: '進行中',
  secNext: '接著',
  secDone: '已完成',
  secLater: '稍後',
  plans: '計劃',
  hidePlans: '收起計劃',
  noPlansHere: '這個專案還沒有計劃',
  noPlanBound: '這個工作階段還沒有計劃。AI 開始多步驟工作時會自動建立；也可以加入本專案已有的計劃。',
  join: '加入',
  switchTo: '切換',
  leave: '離開',
  thisSession: '本工作階段',
  sessionsN: n => (n ? `另有 ${n} 個工作階段` : ''),
  joined: t => `已加入計劃：${t}`,
  left: '已離開計劃',
  planNotFound: r => `找不到計劃：${r}`,
  languageLabel: '語言',
  peekMore: n => `… 還有 ${n} 項`,
  autoPlanMade: '已根據待辦清單建立工作流程',
  nudge: '可用 /workflow 開始計劃',
  continueLead: '繼續做：',
  fillFail: '未能放入輸入框',
  history: '歷史紀錄',
  hideHistory: '收起歷史',
  historyEmpty: '未有封存的計劃',
  untitled: '（未命名）',
}

const EN: Strings = {
  status: { done: 'Done', doing: 'In progress', todo: 'Not started', blocked: 'Blocked', dropped: 'Cancelled' },
  ready: 'ready',
  parallel: t => `parallel: ${t}`,
  waits: t => `waits for ${t}`,
  inserted: n => `added: ${n}`,
  list: ', ',
  sep: '; ',
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
  empty: 'No workflow yet. It appears when multi-step work starts.',
  paneTitle: 'Workflow',
  paneOpened: 'Opened the full workflow map.',
  commandDesc: 'Open the full workflow map (add "help" for the guide)',
  demoDesc: 'Show or hide a sample workflow (does not touch your data)',
  demoOn: 'Showing a sample workflow (on screen only, nothing written). Run /workflow-demo again to hide it.',
  demoOff: 'Sample hidden; back to the real workflow.',
  corrupt: (p, b) => `The workflow file was damaged (${p}); it was backed up as ${b} and the map restarted.`,
  readFail: e => `Could not read the workflow file: ${e}`,
  waitShort: t => `waits for ${t}`,
  upNext: 'Next: ',
  doneCard: n => `${n} done`,
  laterCard: n => `+${n} later`,
  moreRows: n => `+${n} more`,
  stage: (i, p) => (p > 1 ? `Stage ${i} · ${p} parallel` : `Stage ${i}`),
  doneStage: n => `${n} done`,
  laterStage: n => `${n} later`,
  statusLine: (d, b, r) => [d ? `${d} in progress` : '', b ? `${b} blocked` : '', !d && r ? `${r} ready` : ''].filter(Boolean).join(' · '),
  showDone: 'Show done',
  hideDone: 'Hide done',
  showLater: 'Show later',
  expandTip: 'Expand',
  collapseTip: 'Collapse',
  openTip: 'Full view',
  dur: m => (m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`),
  durShort: m => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`),
  stale: 'no update',
  dWords: 'Your words: ',
  dWaits: 'Waits for: ',
  dUnblocks: 'Unblocks: ',
  dOwner: 'Owner: ',
  dStarted: 'Started',
  dDone: 'Done',
  dLog: 'History: ',
  detailOpen: 'Details',
  detailClose: 'Hide',
  help: 'Help',
  helpClose: 'Hide',
  helpWhat: "Your AI's plan, live: where it is, what's next, what you added.",
  helpLegendTitle: 'Legend',
  helpLegend: { done: 'Done', doing: 'In progress', todo: 'Not started', blocked: 'Blocked', ins: 'Added by you', stale: 'No update for a while', pending: 'Request not on the map yet' },
  helpUseTitle: 'Using it',
  helpUse: ['Expand / Collapse: the card graph', 'Full view: open this view', 'Details: your words, waits, owner, times', 'Toolbar: Undo · Export · History · Plans · Projects', '1 2 3 pick a suggestion · 0 hides them'],
  helpAiTitle: 'With your AI',
  helpAi: ['Each session has its own plan; the AI keeps it current', 'Unrelated task? Say "start a new plan"', "[wm:<id>] in an agent's description syncs that step"],
  helpCmdTitle: 'Commands & settings',
  helpCmds: {
    workflow: 'open the full view',
    help: 'open this help',
    demo: 'show a sample plan',
    language: 'interface language',
    staleMinutes: 'minutes before "no update" (30)',
    suggestions: 'next-prompt suggestions on/off',
    export: 'write the plan as Markdown (and copy it)',
    undo: 'undo the last change to the plan',
    notify: 'notifications on/off',
    join: 'join another plan of this project',
    leave: "leave this session's plan",
  },
  nDone: (t, w) => `✓ ${t} done${w ? ` (${w})` : ''}`,
  nBlocked: t => `! ${t} is blocked`,
  nStale: (t, m) => `${t}: no update for ${m} min`,
  nBatch: (n, l) => `${n} updates: ${l}`,
  etaTip: d => `About ${d} left (from the time finished steps took)`,
  exportBtn: 'Export',
  exported: p => `Exported to ${p} (also copied)`,
  undoBtn: 'Undo',
  undone: w => `Undid: ${w}`,
  nothingToUndo: 'Nothing to undo',
  projects: 'Projects',
  hideProjects: 'Hide projects',
  projectsEmpty: 'No project plans yet',
  viewing: n => `Viewing ${n} (read-only)`,
  back: 'Back',
  unavailable: 'This plan cannot be read',
  secNow: 'In progress',
  secNext: 'Next',
  secDone: 'Done',
  secLater: 'Later',
  plans: 'Plans',
  hidePlans: 'Hide plans',
  noPlansHere: 'No plans in this project yet',
  noPlanBound: 'This session has no plan yet. The AI creates one when multi-step work starts; you can also join an existing plan of this project.',
  join: 'Join',
  switchTo: 'Switch',
  leave: 'Leave',
  thisSession: 'this session',
  sessionsN: n => (n ? `${n} other session${n > 1 ? 's' : ''}` : ''),
  joined: t => `Joined plan: ${t}`,
  left: 'Left the plan',
  planNotFound: r => `No plan found: ${r}`,
  languageLabel: 'Language',
  peekMore: n => `… ${n} more`,
  autoPlanMade: 'Workflow created from the to-do list',
  nudge: 'Use /workflow to start a plan',
  continueLead: 'Continue: ',
  fillFail: 'Could not fill the prompt box',
  history: 'History',
  hideHistory: 'Hide history',
  historyEmpty: 'No archived plans yet',
  untitled: '(untitled)',
}

const JA: Strings = {
  ...EN,
  status: { done: '完了', doing: '進行中', todo: '未着手', blocked: '停止中', dropped: '取消' },
  ready: '着手可',
  parallel: t => `並行：${t}`,
  waits: t => `${t} の完了待ち`,
  inserted: n => `追加：${n}`,
  list: '、',
  sep: '；',
  open: '（',
  close: '）',
  progress: '進捗',
  doing: '進行中：',
  next: '次：',
  insertCount: '追加',
  allDone: 'すべて完了',
  progressTip: (d, t) => `${t} 件中 ${d} 件完了`,
  unlogged: '未記録',
  unloggedTip: '最新の依頼はまだ計画に入っていません',
  empty: 'ワークフローはまだありません。複数ステップの作業が始まると表示されます。',
  paneTitle: 'ワークフロー',
  paneOpened: 'ワークフロー全体を開きました。',
  commandDesc: 'ワークフロー全体を開く（help でヘルプ）',
  demoDesc: 'サンプルのワークフローを表示／非表示（データには触れません）',
  demoOn: 'サンプルを表示中（画面のみ、書き込みなし）。もう一度 /workflow-demo で閉じます。',
  demoOff: 'サンプルを閉じました。',
  corrupt: (p, b) => `ワークフローファイルが壊れていました（${p}）。${b} にバックアップして作り直しました。`,
  readFail: e => `ワークフローファイルを読めません：${e}`,
  waitShort: t => `${t} 待ち`,
  upNext: '次：',
  doneCard: n => `${n} 完了`,
  laterCard: n => `+${n} 後で`,
  moreRows: n => `+${n} 件`,
  stage: (i, p) => (p > 1 ? `ステージ ${i} · 並行 ${p}` : `ステージ ${i}`),
  doneStage: n => `完了 ${n} 件`,
  laterStage: n => `後で ${n} 件`,
  statusLine: (d, b, r) => [d ? `${d} 進行中` : '', b ? `${b} 停止中` : '', !d && r ? `${r} 着手可` : ''].filter(Boolean).join(' · '),
  showDone: '完了を表示',
  hideDone: '完了を隠す',
  showLater: '後でを表示',
  expandTip: '開く',
  collapseTip: '閉じる',
  openTip: '全体',
  dur: m => (m < 1 ? '1分未満' : m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}`),
  durShort: m => (m < 60 ? `${m}分` : `${Math.floor(m / 60)}時${m % 60 ? `${m % 60}分` : ''}`),
  stale: '更新なし',
  dWords: 'あなたの言葉：',
  dWaits: '待ち：',
  dUnblocks: '完了後に着手可：',
  dOwner: '担当：',
  dStarted: '開始',
  dDone: '完了',
  dLog: '履歴：',
  detailOpen: '詳細',
  detailClose: '閉じる',
  help: 'ヘルプ',
  helpClose: '閉じる',
  helpWhat: 'AI の作業計画をリアルタイムで：どこまで進んだか、次は何か、あなたが途中で足したこと。',
  helpLegendTitle: '凡例',
  helpLegend: { done: '完了', doing: '進行中', todo: '未着手', blocked: '停止中', ins: 'あなたが追加', stale: 'しばらく更新なし', pending: '依頼がまだ計画にない' },
  helpUseTitle: '使い方',
  helpUse: ['開く／閉じる：カード図', '全体：この全体ビューを開く', '「詳細」：あなたの言葉・待ち・担当・時間', 'ツールバー：元に戻す・エクスポート・履歴・計画・プロジェクト', '1 2 3 で提案を選ぶ · 0 で隠す'],
  helpAiTitle: 'AI との使い方',
  helpAi: ['セッションごとに計画があり、AI が更新します', '別の作業なら「新しい計画を始めて」と伝える', 'エージェントの説明に [wm:<id>] でステップを同期'],
  helpCmdTitle: 'コマンドと設定',
  helpCmds: {
    workflow: '全体ビューを開く',
    help: 'このヘルプを開く',
    demo: 'サンプル計画を表示',
    language: '表示言語',
    staleMinutes: '「更新なし」までの分数（30）',
    suggestions: '次の入力の提案（オン／オフ）',
    export: '計画を Markdown に書き出す（コピーも）',
    undo: '直前の変更を元に戻す',
    notify: '通知（オン／オフ）',
    join: 'このプロジェクトの別の計画に参加',
    leave: '今の計画から離れる',
  },
  nDone: (t, w) => `✓ ${t} 完了${w ? `（${w}）` : ''}`,
  nBlocked: t => `! ${t} が停止中`,
  nStale: (t, m) => `${t}：${m} 分間更新なし`,
  nBatch: (n, l) => `${n} 件の更新：${l}`,
  etaTip: d => `残り約 ${d}（完了したステップの所要時間から推定）`,
  exportBtn: 'エクスポート',
  exported: p => `${p} に書き出しました（コピー済み）`,
  undoBtn: '元に戻す',
  undone: w => `元に戻しました：${w}`,
  nothingToUndo: '元に戻す操作はありません',
  projects: 'プロジェクト',
  hideProjects: 'プロジェクトを隠す',
  projectsEmpty: 'プロジェクトの計画はまだありません',
  viewing: n => `${n} を表示中（読み取り専用）`,
  back: '戻る',
  unavailable: 'この計画は読めません',
  secNow: '進行中',
  secNext: '次',
  secDone: '完了',
  secLater: '後で',
  plans: '計画',
  hidePlans: '計画を隠す',
  noPlansHere: 'このプロジェクトにはまだ計画がありません',
  noPlanBound: 'このセッションにはまだ計画がありません。複数ステップの作業が始まると AI が作ります。既存の計画に参加することもできます。',
  join: '参加',
  switchTo: '切り替え',
  leave: '離れる',
  thisSession: 'このセッション',
  sessionsN: n => (n ? `他 ${n} セッション` : ''),
  joined: t => `計画に参加しました：${t}`,
  left: '計画から離れました',
  planNotFound: r => `計画が見つかりません：${r}`,
  languageLabel: '言語',
  peekMore: n => `… 他 ${n} 件`,
  autoPlanMade: 'ToDo リストからワークフローを作成しました',
  nudge: '/workflow で計画を始められます',
  continueLead: '続けて：',
  fillFail: '入力欄に入れられませんでした',
  history: '履歴',
  hideHistory: '履歴を隠す',
  historyEmpty: '保存された計画はまだありません',
  untitled: '（無題）',
}

const KO: Strings = {
  ...EN,
  status: { done: '완료', doing: '진행 중', todo: '시작 전', blocked: '막힘', dropped: '취소' },
  ready: '시작 가능',
  parallel: t => `병행: ${t}`,
  waits: t => `${t} 완료 대기`,
  inserted: n => `추가: ${n}`,
  progress: '진행',
  doing: '진행 중: ',
  next: '다음: ',
  insertCount: '추가',
  allDone: '모두 완료',
  progressTip: (d, t) => `${t}개 중 ${d}개 완료`,
  unlogged: '기록 안 됨',
  unloggedTip: '최근 요청이 아직 계획에 없습니다',
  empty: '아직 워크플로가 없습니다. 여러 단계 작업이 시작되면 표시됩니다.',
  paneTitle: '워크플로',
  paneOpened: '전체 워크플로를 열었습니다.',
  commandDesc: '전체 워크플로 열기 (help로 도움말)',
  demoDesc: '예시 워크플로 표시/숨기기 (데이터는 건드리지 않음)',
  demoOn: '예시를 표시 중입니다 (화면에만, 저장 안 함). /workflow-demo를 다시 실행하면 닫힙니다.',
  demoOff: '예시를 닫았습니다.',
  corrupt: (p, b) => `워크플로 파일이 손상되었습니다 (${p}). ${b}에 백업하고 새로 시작했습니다.`,
  readFail: e => `워크플로 파일을 읽을 수 없습니다: ${e}`,
  waitShort: t => `${t} 대기`,
  upNext: '다음: ',
  doneCard: n => `${n} 완료`,
  laterCard: n => `+${n} 나중`,
  moreRows: n => `+${n}개`,
  stage: (i, p) => (p > 1 ? `단계 ${i} · 병행 ${p}` : `단계 ${i}`),
  doneStage: n => `완료 ${n}개`,
  laterStage: n => `나중 ${n}개`,
  statusLine: (d, b, r) => [d ? `${d} 진행 중` : '', b ? `${b} 막힘` : '', !d && r ? `${r} 시작 가능` : ''].filter(Boolean).join(' · '),
  showDone: '완료 보기',
  hideDone: '완료 숨기기',
  showLater: '나중 보기',
  expandTip: '펼치기',
  collapseTip: '접기',
  openTip: '전체',
  dur: m => (m < 1 ? '1분 미만' : m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ''}`),
  durShort: m => (m < 60 ? `${m}분` : `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`),
  stale: '업데이트 없음',
  dWords: '내가 한 말: ',
  dWaits: '대기: ',
  dUnblocks: '완료 후 시작 가능: ',
  dOwner: '담당: ',
  dStarted: '시작',
  dDone: '완료',
  dLog: '기록: ',
  detailOpen: '자세히',
  detailClose: '닫기',
  help: '도움말',
  helpClose: '닫기',
  helpWhat: 'AI의 작업 계획을 실시간으로: 어디까지 했는지, 다음은 무엇인지, 내가 중간에 추가한 것.',
  helpLegendTitle: '범례',
  helpLegend: { done: '완료', doing: '진행 중', todo: '시작 전', blocked: '막힘', ins: '내가 추가함', stale: '한동안 업데이트 없음', pending: '요청이 아직 계획에 없음' },
  helpUseTitle: '사용법',
  helpUse: ['펼치기 / 접기: 카드 보기', '전체: 이 전체 보기 열기', '자세히: 내가 한 말·대기·담당·시간', '도구 모음: 실행 취소 · 내보내기 · 기록 · 계획 · 프로젝트', '1 2 3 제안 선택 · 0 숨기기'],
  helpAiTitle: 'AI와 함께',
  helpAi: ['세션마다 계획이 있고 AI가 직접 업데이트합니다', '다른 작업이면 "새 계획 시작"이라고 말하세요', '에이전트 설명에 [wm:<id>]를 넣으면 단계가 동기화됩니다'],
  helpCmdTitle: '명령과 설정',
  helpCmds: {
    workflow: '전체 보기 열기',
    help: '이 도움말 열기',
    demo: '예시 계획 보기',
    language: '인터페이스 언어',
    staleMinutes: '"업데이트 없음"까지의 분 (30)',
    suggestions: '다음 입력 제안 켜기/끄기',
    export: '계획을 Markdown으로 내보내기 (복사 포함)',
    undo: '마지막 변경 되돌리기',
    notify: '알림 켜기/끄기',
    join: '이 프로젝트의 다른 계획에 참여',
    leave: '현재 계획에서 나가기',
  },
  nDone: (t, w) => `✓ ${t} 완료${w ? ` (${w})` : ''}`,
  nBlocked: t => `! ${t} 막힘`,
  nStale: (t, m) => `${t}: ${m}분 동안 업데이트 없음`,
  nBatch: (n, l) => `업데이트 ${n}개: ${l}`,
  etaTip: d => `약 ${d} 남음 (완료된 단계의 소요 시간 기준)`,
  exportBtn: '내보내기',
  exported: p => `${p}에 내보냈습니다 (복사됨)`,
  undoBtn: '실행 취소',
  undone: w => `되돌림: ${w}`,
  nothingToUndo: '되돌릴 작업이 없습니다',
  projects: '프로젝트',
  hideProjects: '프로젝트 숨기기',
  projectsEmpty: '아직 프로젝트 계획이 없습니다',
  viewing: n => `${n} 보는 중 (읽기 전용)`,
  back: '뒤로',
  unavailable: '이 계획을 읽을 수 없습니다',
  secNow: '진행 중',
  secNext: '다음',
  secDone: '완료',
  secLater: '나중',
  plans: '계획',
  hidePlans: '계획 숨기기',
  noPlansHere: '이 프로젝트에는 아직 계획이 없습니다',
  noPlanBound: '이 세션에는 아직 계획이 없습니다. 여러 단계 작업이 시작되면 AI가 만듭니다. 기존 계획에 참여할 수도 있습니다.',
  join: '참여',
  switchTo: '전환',
  leave: '나가기',
  thisSession: '이 세션',
  sessionsN: n => (n ? `다른 세션 ${n}개` : ''),
  joined: t => `계획에 참여했습니다: ${t}`,
  left: '계획에서 나갔습니다',
  planNotFound: r => `계획을 찾을 수 없습니다: ${r}`,
  languageLabel: '언어',
  peekMore: n => `… ${n}개 더`,
  autoPlanMade: '할 일 목록으로 워크플로를 만들었습니다',
  nudge: '/workflow 로 계획을 시작할 수 있습니다',
  continueLead: '계속: ',
  fillFail: '입력창에 넣지 못했습니다',
  history: '기록',
  hideHistory: '기록 숨기기',
  historyEmpty: '보관된 계획이 아직 없습니다',
  untitled: '(제목 없음)',
}

const ES: Strings = {
  ...EN,
  status: { done: 'Hecho', doing: 'En curso', todo: 'Sin empezar', blocked: 'Bloqueado', dropped: 'Cancelado' },
  ready: 'listo',
  parallel: t => `en paralelo: ${t}`,
  waits: t => `espera a ${t}`,
  inserted: n => `añadido: ${n}`,
  progress: 'Progreso',
  doing: 'En curso: ',
  next: 'Siguiente: ',
  insertCount: 'Añadidos',
  allDone: 'Todo hecho',
  progressTip: (d, t) => `${d} de ${t} pasos hechos`,
  unlogged: 'Sin registrar',
  unloggedTip: 'Tu última petición aún no está en el plan',
  empty: 'Aún no hay flujo. Aparece cuando empieza un trabajo de varios pasos.',
  paneTitle: 'Flujo de trabajo',
  paneOpened: 'Se abrió el flujo completo.',
  commandDesc: 'Abrir el flujo completo (añade "help" para la ayuda)',
  demoDesc: 'Mostrar u ocultar un flujo de ejemplo (no toca tus datos)',
  demoOn: 'Mostrando un ejemplo (solo en pantalla, nada se guarda). Ejecuta /workflow-demo otra vez para ocultarlo.',
  demoOff: 'Ejemplo oculto; de vuelta al flujo real.',
  corrupt: (p, b) => `El archivo del flujo estaba dañado (${p}); se guardó como ${b} y el plan empezó de nuevo.`,
  readFail: e => `No se pudo leer el archivo del flujo: ${e}`,
  waitShort: t => `espera a ${t}`,
  upNext: 'Siguiente: ',
  doneCard: n => `${n} hechos`,
  laterCard: n => `+${n} después`,
  moreRows: n => `+${n} más`,
  stage: (i, p) => (p > 1 ? `Etapa ${i} · ${p} en paralelo` : `Etapa ${i}`),
  doneStage: n => `${n} hechos`,
  laterStage: n => `${n} después`,
  statusLine: (d, b, r) => [d ? `${d} en curso` : '', b ? `${b} bloqueados` : '', !d && r ? `${r} listos` : ''].filter(Boolean).join(' · '),
  showDone: 'Ver hechos',
  hideDone: 'Ocultar hechos',
  showLater: 'Ver después',
  expandTip: 'Expandir',
  collapseTip: 'Contraer',
  openTip: 'Vista completa',
  stale: 'sin novedades',
  dWords: 'Tus palabras: ',
  dWaits: 'Espera a: ',
  dUnblocks: 'Desbloquea: ',
  dOwner: 'Responsable: ',
  dStarted: 'Empezó',
  dDone: 'Hecho',
  dLog: 'Historial: ',
  detailOpen: 'Detalles',
  detailClose: 'Ocultar',
  help: 'Ayuda',
  helpClose: 'Ocultar',
  helpWhat: 'El plan de tu IA, en vivo: dónde va, qué sigue y qué añadiste.',
  helpLegendTitle: 'Leyenda',
  helpLegend: { done: 'Hecho', doing: 'En curso', todo: 'Sin empezar', blocked: 'Bloqueado', ins: 'Añadido por ti', stale: 'Sin novedades hace rato', pending: 'Petición aún no en el plan' },
  helpUseTitle: 'Uso',
  helpUse: ['Expandir / Contraer: las tarjetas', 'Vista completa: abrir esta vista', 'Detalles: tus palabras, esperas, responsable, horas', 'Barra: Deshacer · Exportar · Historial · Planes · Proyectos', '1 2 3 elige una sugerencia · 0 las oculta'],
  helpAiTitle: 'Con tu IA',
  helpAi: ['Cada sesión tiene su plan; la IA lo mantiene al día', '¿Otra tarea? Di "empieza un plan nuevo"', '[wm:<id>] en la descripción de un agente sincroniza ese paso'],
  helpCmdTitle: 'Comandos y ajustes',
  helpCmds: {
    workflow: 'abrir la vista completa',
    help: 'abrir esta ayuda',
    demo: 'ver un plan de ejemplo',
    language: 'idioma de la interfaz',
    staleMinutes: 'minutos hasta "sin novedades" (30)',
    suggestions: 'sugerencias de siguiente mensaje sí/no',
    export: 'escribir el plan en Markdown (y copiarlo)',
    undo: 'deshacer el último cambio',
    notify: 'avisos sí/no',
    join: 'unirse a otro plan del proyecto',
    leave: 'salir del plan de esta sesión',
  },
  nDone: (t, w) => `✓ ${t} hecho${w ? ` (${w})` : ''}`,
  nBlocked: t => `! ${t} está bloqueado`,
  nStale: (t, m) => `${t}: sin novedades en ${m} min`,
  nBatch: (n, l) => `${n} novedades: ${l}`,
  etaTip: d => `Quedan unos ${d} (según lo que tardaron los pasos hechos)`,
  exportBtn: 'Exportar',
  exported: p => `Exportado a ${p} (también copiado)`,
  undoBtn: 'Deshacer',
  undone: w => `Deshecho: ${w}`,
  nothingToUndo: 'Nada que deshacer',
  projects: 'Proyectos',
  hideProjects: 'Ocultar proyectos',
  projectsEmpty: 'Aún no hay planes de proyectos',
  viewing: n => `Viendo ${n} (solo lectura)`,
  back: 'Volver',
  unavailable: 'No se puede leer este plan',
  secNow: 'En curso',
  secNext: 'Siguiente',
  secDone: 'Hecho',
  secLater: 'Después',
  plans: 'Planes',
  hidePlans: 'Ocultar planes',
  noPlansHere: 'Aún no hay planes en este proyecto',
  noPlanBound: 'Esta sesión aún no tiene plan. La IA crea uno cuando empieza un trabajo de varios pasos; también puedes unirte a un plan existente.',
  join: 'Unirse',
  switchTo: 'Cambiar',
  leave: 'Salir',
  thisSession: 'esta sesión',
  sessionsN: n => (n ? `${n} otra${n > 1 ? 's' : ''} sesi${n > 1 ? 'ones' : 'ón'}` : ''),
  joined: t => `Te uniste al plan: ${t}`,
  left: 'Saliste del plan',
  planNotFound: r => `No se encontró el plan: ${r}`,
  languageLabel: 'Idioma',
  peekMore: n => `… ${n} más`,
  autoPlanMade: 'Flujo de trabajo creado a partir de la lista de tareas',
  nudge: 'Usa /workflow para empezar un plan',
  continueLead: 'Continúa: ',
  fillFail: 'No se pudo rellenar el cuadro de texto',
  history: 'Historial',
  hideHistory: 'Ocultar historial',
  historyEmpty: 'Aún no hay planes archivados',
  untitled: '(sin título)',
}

const FR: Strings = {
  ...EN,
  status: { done: 'Fait', doing: 'En cours', todo: 'À faire', blocked: 'Bloqué', dropped: 'Annulé' },
  ready: 'prêt',
  parallel: t => `en parallèle : ${t}`,
  waits: t => `attend ${t}`,
  inserted: n => `ajouté : ${n}`,
  progress: 'Avancement',
  doing: 'En cours : ',
  next: 'Ensuite : ',
  insertCount: 'Ajoutés',
  allDone: 'Tout est fait',
  progressTip: (d, t) => `${d} étapes sur ${t} faites`,
  unlogged: 'Non noté',
  unloggedTip: "Votre dernière demande n'est pas encore dans le plan",
  empty: 'Pas encore de flux. Il apparaît quand un travail en plusieurs étapes commence.',
  paneTitle: 'Flux de travail',
  paneOpened: 'Vue complète ouverte.',
  commandDesc: 'Ouvrir la vue complète (ajoutez "help" pour l’aide)',
  demoDesc: 'Afficher ou masquer un exemple (ne touche pas à vos données)',
  demoOn: 'Exemple affiché (à l’écran seulement, rien n’est écrit). Relancez /workflow-demo pour le masquer.',
  demoOff: 'Exemple masqué ; retour au vrai flux.',
  corrupt: (p, b) => `Le fichier du flux était abîmé (${p}) ; il a été sauvegardé sous ${b} et le plan repart de zéro.`,
  readFail: e => `Impossible de lire le fichier du flux : ${e}`,
  waitShort: t => `attend ${t}`,
  upNext: 'Ensuite : ',
  doneCard: n => `${n} faites`,
  laterCard: n => `+${n} plus tard`,
  moreRows: n => `+${n} de plus`,
  stage: (i, p) => (p > 1 ? `Étape ${i} · ${p} en parallèle` : `Étape ${i}`),
  doneStage: n => `${n} faites`,
  laterStage: n => `${n} plus tard`,
  statusLine: (d, b, r) => [d ? `${d} en cours` : '', b ? `${b} bloquées` : '', !d && r ? `${r} prêtes` : ''].filter(Boolean).join(' · '),
  showDone: 'Voir les faites',
  hideDone: 'Masquer les faites',
  showLater: 'Voir la suite',
  expandTip: 'Déplier',
  collapseTip: 'Replier',
  openTip: 'Vue complète',
  stale: 'pas de nouvelles',
  dWords: 'Vos mots : ',
  dWaits: 'Attend : ',
  dUnblocks: 'Débloque : ',
  dOwner: 'Responsable : ',
  dStarted: 'Commencé',
  dDone: 'Fait',
  dLog: 'Historique : ',
  detailOpen: 'Détails',
  detailClose: 'Masquer',
  help: 'Aide',
  helpClose: 'Masquer',
  helpWhat: 'Le plan de votre IA, en direct : où il en est, la suite, ce que vous avez ajouté.',
  helpLegendTitle: 'Légende',
  helpLegend: { done: 'Fait', doing: 'En cours', todo: 'À faire', blocked: 'Bloqué', ins: 'Ajouté par vous', stale: 'Pas de nouvelles depuis un moment', pending: 'Demande pas encore dans le plan' },
  helpUseTitle: 'Utilisation',
  helpUse: ['Déplier / Replier : les cartes', 'Vue complète : ouvrir cette vue', 'Détails : vos mots, attentes, responsable, horaires', 'Barre : Annuler · Exporter · Historique · Plans · Projets', '1 2 3 choisir une suggestion · 0 les masque'],
  helpAiTitle: 'Avec votre IA',
  helpAi: ["Chaque session a son plan ; l'IA le tient à jour", 'Autre tâche ? Dites « nouveau plan »', "[wm:<id>] dans la description d'un agent synchronise l'étape"],
  helpCmdTitle: 'Commandes et réglages',
  helpCmds: {
    workflow: 'ouvrir la vue complète',
    help: 'ouvrir cette aide',
    demo: 'afficher un plan exemple',
    language: "langue de l'interface",
    staleMinutes: 'minutes avant « pas de nouvelles » (30)',
    suggestions: 'suggestions du prochain message oui/non',
    export: 'écrire le plan en Markdown (et le copier)',
    undo: 'annuler la dernière modification',
    notify: 'notifications oui/non',
    join: 'rejoindre un autre plan du projet',
    leave: 'quitter le plan de cette session',
  },
  nDone: (t, w) => `✓ ${t} fait${w ? ` (${w})` : ''}`,
  nBlocked: t => `! ${t} est bloqué`,
  nStale: (t, m) => `${t} : pas de nouvelles depuis ${m} min`,
  nBatch: (n, l) => `${n} mises à jour : ${l}`,
  etaTip: d => `Environ ${d} restantes (d'après la durée des étapes faites)`,
  exportBtn: 'Exporter',
  exported: p => `Exporté dans ${p} (aussi copié)`,
  undoBtn: 'Annuler',
  undone: w => `Annulé : ${w}`,
  nothingToUndo: 'Rien à annuler',
  projects: 'Projets',
  hideProjects: 'Masquer les projets',
  projectsEmpty: 'Aucun plan de projet pour le moment',
  viewing: n => `${n} (lecture seule)`,
  back: 'Retour',
  unavailable: 'Impossible de lire ce plan',
  secNow: 'En cours',
  secNext: 'Ensuite',
  secDone: 'Fait',
  secLater: 'Plus tard',
  plans: 'Plans',
  hidePlans: 'Masquer les plans',
  noPlansHere: 'Aucun plan dans ce projet',
  noPlanBound: 'Cette session n’a pas encore de plan. L’IA en crée un quand un travail en plusieurs étapes commence ; vous pouvez aussi rejoindre un plan existant.',
  join: 'Rejoindre',
  switchTo: 'Changer',
  leave: 'Quitter',
  thisSession: 'cette session',
  sessionsN: n => (n ? `${n} autre${n > 1 ? 's' : ''} session${n > 1 ? 's' : ''}` : ''),
  joined: t => `Plan rejoint : ${t}`,
  left: 'Plan quitté',
  planNotFound: r => `Plan introuvable : ${r}`,
  languageLabel: 'Langue',
  peekMore: n => `… ${n} de plus`,
  autoPlanMade: 'Flux de travail créé à partir de la liste de tâches',
  nudge: 'Utilisez /workflow pour commencer un plan',
  continueLead: 'Continue : ',
  fillFail: 'Impossible de remplir la zone de saisie',
  history: 'Historique',
  hideHistory: "Masquer l'historique",
  historyEmpty: 'Aucun plan archivé',
  untitled: '(sans titre)',
}

const DE: Strings = {
  ...EN,
  status: { done: 'Erledigt', doing: 'In Arbeit', todo: 'Offen', blocked: 'Blockiert', dropped: 'Abgebrochen' },
  ready: 'bereit',
  parallel: t => `parallel: ${t}`,
  waits: t => `wartet auf ${t}`,
  inserted: n => `hinzugefügt: ${n}`,
  progress: 'Fortschritt',
  doing: 'In Arbeit: ',
  next: 'Als Nächstes: ',
  insertCount: 'Hinzugefügt',
  allDone: 'Alles erledigt',
  progressTip: (d, t) => `${d} von ${t} Schritten erledigt`,
  unlogged: 'Nicht erfasst',
  unloggedTip: 'Deine letzte Bitte steht noch nicht im Plan',
  empty: 'Noch kein Ablauf. Er erscheint, sobald mehrstufige Arbeit beginnt.',
  paneTitle: 'Ablauf',
  paneOpened: 'Gesamtansicht geöffnet.',
  commandDesc: 'Gesamtansicht öffnen ("help" für die Hilfe)',
  demoDesc: 'Beispielablauf ein- oder ausblenden (deine Daten bleiben unberührt)',
  demoOn: 'Beispiel wird angezeigt (nur auf dem Bildschirm, nichts gespeichert). /workflow-demo erneut zum Ausblenden.',
  demoOff: 'Beispiel ausgeblendet; zurück zum echten Ablauf.',
  corrupt: (p, b) => `Die Ablaufdatei war beschädigt (${p}); sie wurde als ${b} gesichert und der Plan neu begonnen.`,
  readFail: e => `Ablaufdatei konnte nicht gelesen werden: ${e}`,
  waitShort: t => `wartet auf ${t}`,
  upNext: 'Als Nächstes: ',
  doneCard: n => `${n} erledigt`,
  laterCard: n => `+${n} später`,
  moreRows: n => `+${n} weitere`,
  stage: (i, p) => (p > 1 ? `Stufe ${i} · ${p} parallel` : `Stufe ${i}`),
  doneStage: n => `${n} erledigt`,
  laterStage: n => `${n} später`,
  statusLine: (d, b, r) => [d ? `${d} in Arbeit` : '', b ? `${b} blockiert` : '', !d && r ? `${r} bereit` : ''].filter(Boolean).join(' · '),
  showDone: 'Erledigte zeigen',
  hideDone: 'Erledigte ausblenden',
  showLater: 'Später zeigen',
  expandTip: 'Ausklappen',
  collapseTip: 'Einklappen',
  openTip: 'Gesamtansicht',
  dur: m => (m < 1 ? '<1 Min.' : m < 60 ? `${m} Min.` : `${Math.floor(m / 60)} Std.${m % 60 ? ` ${m % 60} Min.` : ''}`),
  stale: 'keine Neuigkeit',
  dWords: 'Deine Worte: ',
  dWaits: 'Wartet auf: ',
  dUnblocks: 'Gibt frei: ',
  dOwner: 'Zuständig: ',
  dStarted: 'Begonnen',
  dDone: 'Erledigt',
  dLog: 'Verlauf: ',
  detailOpen: 'Details',
  detailClose: 'Ausblenden',
  help: 'Hilfe',
  helpClose: 'Ausblenden',
  helpWhat: 'Der Plan deiner KI, live: wo sie steht, was als Nächstes kommt, was du ergänzt hast.',
  helpLegendTitle: 'Legende',
  helpLegend: { done: 'Erledigt', doing: 'In Arbeit', todo: 'Offen', blocked: 'Blockiert', ins: 'Von dir ergänzt', stale: 'Länger keine Neuigkeit', pending: 'Bitte noch nicht im Plan' },
  helpUseTitle: 'Bedienung',
  helpUse: ['Ausklappen / Einklappen: die Karten', 'Gesamtansicht: diese Ansicht öffnen', 'Details: deine Worte, Wartet auf, Zuständig, Zeiten', 'Leiste: Rückgängig · Exportieren · Verlauf · Pläne · Projekte', '1 2 3 Vorschlag wählen · 0 blendet aus'],
  helpAiTitle: 'Mit deiner KI',
  helpAi: ['Jede Sitzung hat ihren Plan; die KI hält ihn aktuell', 'Andere Aufgabe? Sag „neuer Plan“', '[wm:<id>] in der Beschreibung eines Agenten synchronisiert den Schritt'],
  helpCmdTitle: 'Befehle & Einstellungen',
  helpCmds: {
    workflow: 'Gesamtansicht öffnen',
    help: 'diese Hilfe öffnen',
    demo: 'Beispielplan zeigen',
    language: 'Sprache der Oberfläche',
    staleMinutes: 'Minuten bis „keine Neuigkeit“ (30)',
    suggestions: 'Vorschläge für die nächste Eingabe an/aus',
    export: 'Plan als Markdown schreiben (und kopieren)',
    undo: 'letzte Änderung rückgängig machen',
    notify: 'Benachrichtigungen an/aus',
    join: 'einem anderen Plan des Projekts beitreten',
    leave: 'den Plan dieser Sitzung verlassen',
  },
  nDone: (t, w) => `✓ ${t} erledigt${w ? ` (${w})` : ''}`,
  nBlocked: t => `! ${t} ist blockiert`,
  nStale: (t, m) => `${t}: seit ${m} Min. keine Neuigkeit`,
  nBatch: (n, l) => `${n} Neuigkeiten: ${l}`,
  etaTip: d => `Noch etwa ${d} (nach der Dauer erledigter Schritte)`,
  exportBtn: 'Exportieren',
  exported: p => `Exportiert nach ${p} (auch kopiert)`,
  undoBtn: 'Rückgängig',
  undone: w => `Rückgängig gemacht: ${w}`,
  nothingToUndo: 'Nichts rückgängig zu machen',
  projects: 'Projekte',
  hideProjects: 'Projekte ausblenden',
  projectsEmpty: 'Noch keine Projektpläne',
  viewing: n => `${n} (nur lesen)`,
  back: 'Zurück',
  unavailable: 'Dieser Plan ist nicht lesbar',
  secNow: 'In Arbeit',
  secNext: 'Als Nächstes',
  secDone: 'Erledigt',
  secLater: 'Später',
  plans: 'Pläne',
  hidePlans: 'Pläne ausblenden',
  noPlansHere: 'Noch keine Pläne in diesem Projekt',
  noPlanBound: 'Diese Sitzung hat noch keinen Plan. Die KI legt einen an, sobald mehrstufige Arbeit beginnt; du kannst auch einem vorhandenen Plan beitreten.',
  join: 'Beitreten',
  switchTo: 'Wechseln',
  leave: 'Verlassen',
  thisSession: 'diese Sitzung',
  sessionsN: n => (n ? `${n} weitere Sitzung${n > 1 ? 'en' : ''}` : ''),
  joined: t => `Plan beigetreten: ${t}`,
  left: 'Plan verlassen',
  planNotFound: r => `Kein Plan gefunden: ${r}`,
  languageLabel: 'Sprache',
  peekMore: n => `… ${n} weitere`,
  autoPlanMade: 'Workflow aus der To-do-Liste erstellt',
  nudge: 'Mit /workflow einen Plan beginnen',
  continueLead: 'Weiter: ',
  fillFail: 'Eingabefeld konnte nicht gefüllt werden',
  history: 'Verlauf',
  hideHistory: 'Verlauf ausblenden',
  historyEmpty: 'Noch keine archivierten Pläne',
  untitled: '(ohne Titel)',
}

export const STR: Record<Lang, Strings> = { en: EN, 'zh-Hant': ZH_HANT, ja: JA, ko: KO, es: ES, fr: FR, de: DE }

/** Help card tabs: English first, then the others, each in its own name. */
export const HELP_TABS: readonly (readonly [Lang, string])[] = [
  ['en', 'English'],
  ['zh-Hant', '繁體中文'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
]
