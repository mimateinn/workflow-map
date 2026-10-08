// UI strings. Step titles stay exactly as the model wrote them. The plugin API exposes no locale, so the
// language comes from userConfig `language`, else from the script of the user's most recent typed prompt
// (cached in $.store), else from the plan's step titles (weak evidence: the model writes them in the
// user's language), else English.
import type { WorkflowStatus } from '../types/index'

export type Lang = 'zh-Hant' | 'zh-Hans' | 'en'
export const LANGS: readonly Lang[] = ['zh-Hant', 'zh-Hans', 'en']

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
 * Traditional is the safe default for Han text: zh-Hans only when at least 2 simplified-only characters
 * appear AND they outnumber the traditional-only (incl. Cantonese) ones. A lone simplified character
 * (a pasted name, a typo) or a tie never changes the language.
 */
export function detectLang(text: string): Lang | undefined {
  if (HANGUL.test(text) || KANA.test(text)) return 'en' // ja/ko not shipped yet: English chrome
  if (HAN.test(text)) {
    const chars = [...text]
    const simp = chars.filter(ch => SIMPLIFIED_ONLY.has(ch)).length
    const trad = chars.filter(ch => TRADITIONAL_ONLY.has(ch)).length
    if (simp >= 2 && simp > trad) return 'zh-Hans'
    if (simp === 0 || trad > simp) return 'zh-Hant'
    return undefined
  }
  return (text.match(LATIN_LETTERS)?.length ?? 0) >= 12 ? 'en' : undefined
}

/** userConfig `language` (auto | zh-Hant | zh-Hans | en) wins; else the cached prompt language; else the plan titles' script; else English. */
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
  hideLater: string
  expandTip: string
  collapseTip: string
  openTip: string
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
  commandDesc: '開啟工作流程全圖',
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
  hideLater: '收起稍後',
  expandTip: '展開',
  collapseTip: '收起',
  openTip: '開啟全圖',
}

const ZH_HANS: Strings = {
  ...ZH_HANT,
  status: { done: '已完成', doing: '进行中', todo: '未开始', blocked: '受阻', dropped: '已取消' },
  ready: '可开始',
  parallel: t => `并行：${t}`,
  waits: t => `待 ${t} 完成`,
  progress: '进度',
  doing: '进行中：',
  next: '下一步：',
  allDone: '全部完成',
  progressTip: (d, t) => `已完成 ${d} 项，共 ${t} 项`,
  unlogged: '新要求未记录',
  unloggedTip: '你刚发出的新要求尚未记入工作流程',
  empty: '尚无工作流程。开始多步骤工作时会自动显示。',
  paneTitle: '工作流程',
  paneOpened: '已打开工作流程全图。',
  commandDesc: '打开工作流程全图',
  demoDesc: '显示／关闭示范工作流程（不影响真实数据）',
  demoOn: '已显示示范工作流程（只在画面，不写文件）。再执行 /workflow-demo 关闭。',
  demoOff: '已关闭示范，回到真实工作流程。',
  corrupt: (p, b) => `工作流程文件已损坏（${p}），原文件已备份为 ${b}，现重新开始。`,
  readFail: e => `无法读取工作流程文件：${e}`,
  upNext: '下一步：',
  doneCard: n => `${n} 已完成`,
  laterCard: n => `+${n} 稍后`,
  moreRows: n => `+${n} 项`,
  stage: (i, p) => (p > 1 ? `阶段 ${i} · 并行 ${p}` : `阶段 ${i}`),
  doneStage: n => `已完成 ${n} 项`,
  laterStage: n => `稍后 ${n} 项`,
  statusLine: (d, b, r) => [d ? `${d} 进行中` : '', b ? `${b} 受阻` : '', !d && r ? `${r} 可开始` : ''].filter(Boolean).join(' · '),
  showDone: '显示已完成',
  hideDone: '收起已完成',
  showLater: '显示稍后',
  hideLater: '收起稍后',
  expandTip: '展开',
  collapseTip: '收起',
  openTip: '打开全图',
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
  commandDesc: 'Open the full workflow map',
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
  hideLater: 'Hide later',
  expandTip: 'Expand',
  collapseTip: 'Collapse',
  openTip: 'Open full map',
}

export const STR: Record<Lang, Strings> = { 'zh-Hant': ZH_HANT, 'zh-Hans': ZH_HANS, en: EN }
