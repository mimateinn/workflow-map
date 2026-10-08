# workflow-map 工作流程圖

在 Claude Code 輸入框上方，以一行膠囊顯示目前工作的進度：完成了多少、哪些正在進行、下一步是甚麼。你在中途提出的新要求會以紫色「⊕」記號標示，不會被遺忘。

## 你會看到甚麼

- **平時（收起）**：一行膠囊，例如 `[3/10]  [改介面]  [自動測試]  [→ 發佈]  [⊕ 2]`。第一粒膠囊內的填色就是整體進度；橙色實心膠囊是「正在進行」，會輕輕發光。
- **展開**：按右邊的 ▾ 圖示，變成一張精簡路線圖：每條線是一條可同時進行的工作線，膠囊是步驟；走過的路是實線，未走的是虛線。再按 ▴ 收起。
- **全圖**：放不下的步驟會收成「+N」按鈕，按下開啟全圖；也可輸入 `/workflow`。全圖有進度條、大路線圖、全部步驟及插入記錄。
- 沒有計劃時不顯示；全部完成後顯示一次，之後自動隱藏。
- 想先看看效果：輸入 `/workflow-demo` 顯示示範（只在畫面，不寫入任何檔案），再輸入一次關閉。

## 安裝

**桌面版**：設定 → Plugins → Add from a repository，輸入 `mimateinn/workflow-map`。

**終端機**：

```
/plugin install workflow-map --marketplace mimateinn/workflow-map
```

詢問是否加入 marketplace 時輸入 `y`，再選擇安裝範圍。

## 設定

`language`：`auto`（預設）、`zh-Hant`、`en`。`auto` 時，步驟名稱含中日韓文字就用繁體中文介面，否則用英文。步驟名稱本身照 Claude 所寫，不翻譯。

## 技術說明

- 外掛提供工具 `workflow_map`（`set_plan`／`upsert`／`status`／`insert`／`remove`／`show`），並在系統提示加入一段簡短說明：工作多於三步時維持此圖；用戶中途提出計劃以外的要求時，先以 `insert` 記錄再處理。
- 會形成循環依賴或指向不存在步驟的更新會被拒絕，原圖不變。
- 資料存於專案的 `.claude/workflow-map.json`，其他 AI 及之後的工作階段均可讀取。檔案損壞時會先備份為 `workflow-map.bad-<時間>.json` 再重新開始。
- 用戶插入的步驟即使計劃重訂也會保留，須明確移除。
- 圖以 SVG 圖片模式繪製（透明底、1:1 尺寸、不縮放）。Claude Code 的外掛 API 沒有主題資訊，也沒有橫向捲動，所以：膠囊一律用不透明中深色底配淺色字（深淺主題都清楚），放不下的欄收成「+N」。
- 終端機以文字顯示：`[✓3/10] [▶改介面] → [發佈] · [+2]`。
- 開發：`claude plugin validate .`、`claude plugin test .`（以 Claude Code 2.1.293 驗證）。

### 色板（其他 mod 可直接沿用）

字色對膠囊底的對比全部 ≥ 4.5:1（有測試檢查）。膠囊高 20px、圓角 = 高度一半、字 11.5px、膠囊間距 ≥ 16px。

| 用途 | 底色 | 字色 |
|---|---|---|
| 已完成（前加 ✓） | `#5c4037` | `#fbe4da` |
| 進行中（外圈光暈 `#d97757`） | `#b5532f` | `#ffffff` |
| 未開始 | `#3f3f46` | `#f4f4f5` |
| 可開始（框 `#d97757`，前加 →） | `#3f3f46` | `#ffffff` |
| 受阻 | `#a3282c` | `#ffffff` |
| 已取消（刪除線） | `#52525b` | `#d4d4d8` |
| 插入（記號 `#8b5cf6`） | `#5b3fa8` | `#ffffff` |
| 警示 | `#8a5a00` | `#ffffff` |

線：已走過 `#d97757` 實線 2px；未走 `rgba(128,128,128,.55)` 虛線 1.5px。進度條底 `rgba(128,128,128,.35)`。

## English

**workflow-map** shows the current work as one calm row of capsules above the Claude Code prompt: overall progress (the first capsule fills up), what is running now (glowing accent capsules), what is next, and how many requests you added mid-plan (purple ⊕). Press ▾ for a compact metro-line view of parallel branches; press "+N" or run `/workflow` for the full map and a log of added requests. `/workflow-demo` shows a sample without touching your data. Claude keeps the map current through the `workflow_map` tool and records your interjections with `insert` before acting on them. Data lives in `.claude/workflow-map.json` in your project. Set `language` to `auto`, `zh-Hant` or `en`.

Install — desktop: Settings → Plugins → Add from a repository → `mimateinn/workflow-map`. Terminal: `/plugin install workflow-map --marketplace mimateinn/workflow-map`.

## 授權 License

MIT，見 [LICENSE](LICENSE)。
