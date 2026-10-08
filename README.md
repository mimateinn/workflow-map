# workflow-map

**See what your AI is doing — and what's next.** A live plan for Claude Code, right above your prompt.

![workflow-map intro](docs/intro.gif)

▶ [Watch the intro in full quality (MP4, 22 s)](docs/intro.mp4)

## What it does

- **One row above the prompt** — the step that is running, what comes next, and a segmented progress bar (`3/9`).
- **Expand for the card graph** — GitHub-Actions-style cards: finished work folded into "✓ N done", parallel steps stacked in one card, later steps folded into "+N later".
- **Your interjections are kept** — when you ask for something mid-plan, Claude records it as a violet ◇ step (with the time and your words) before acting on it, so it doesn't get lost.
- **Full view on demand** — `/workflow` opens stage-by-stage cards, showing what each waiting step is waiting for.

| Collapsed | Expanded |
|---|---|
| ![Collapsed row](docs/collapsed.png) | ![Expanded card graph](docs/expanded.png) |

![Full workflow pane](docs/pane.png)

<sub>Screenshots are rendered by the plugin's own drawing code (dark theme), not mock-ups.</sub>

## Install

Requires **Claude Code 2.1.287 or later**.

### Desktop app

Settings → Plugins → **Add from a repository** → enter `mimateinn/workflow-map`.

### Inside a Claude Code session

```
/plugin install workflow-map --marketplace mimateinn/workflow-map
```

### From your shell

```sh
claude plugin install workflow-map --marketplace mimateinn/workflow-map
```

Or in two steps (add the marketplace, then install from it):

```sh
claude plugin marketplace add mimateinn/workflow-map
claude plugin install workflow-map@workflow-map
```

Add `--scope project` to install for the current project only (default: `user`).

### Install with one prompt

Paste this into Claude Code and it will install the plugin for you:

```text
Install the Claude Code plugin "workflow-map" from the GitHub marketplace mimateinn/workflow-map.
Run: claude plugin install workflow-map --marketplace mimateinn/workflow-map
If that command is not available, run `claude --version` and tell me — it needs 2.1.287 or later.
When it succeeds, confirm with `claude plugin list` and tell me to restart Claude Code if the map does not appear.
```

To try it without a real plan, run `/workflow-demo` (shows a sample; run it again to hide it).

## How it works

- The plugin gives Claude a `workflow_map` tool (`set_plan` / `upsert` / `status` / `insert` / `remove` / `show`) plus a short system-prompt note: keep the map current for work of more than three steps, and when you interject mid-plan, record it with `insert` first.
- The map is stored in your project at **`.claude/workflow-map.json`**, so later sessions and other agents can read it. Updates that would create a cycle or point to a missing step are rejected and the map is left unchanged. A damaged file is backed up before the map restarts.
- **Focus mode:** with more than six steps, only what's running, what's ready and the next level are drawn; done and far-future steps fold into one card each. Steps you inserted this turn are always shown.
- **Language follows you:** the interface uses the language of your most recent prompt (English, Traditional or Simplified Chinese). Step titles are shown as Claude wrote them.
- `/workflow` — open the full map (registered as `/workflow-map` if another plugin already owns `/workflow`). `/workflow-demo` — toggle a sample map (on screen only, nothing is written).
- In the terminal the map is drawn as text (a one-line summary that expands into a step list).
- The map hides when there is no plan, and hides itself again shortly after everything is done.

## Options

| Option | Values | Default |
|---|---|---|
| `language` | `auto`, `en`, `zh-Hant`, `zh-Hans` | `auto` (language of your latest prompt; English when unsure) |

Set it in the plugin's settings, or from the shell:

```sh
claude plugin configure workflow-map                                   # show options
echo '{"language":"en"}' | claude plugin configure workflow-map --values-stdin
```

## Privacy

Everything stays on your machine. The map lives in one local file (`.claude/workflow-map.json` in your project); the plugin makes no network requests.

## Development

```sh
claude plugin validate .
claude plugin test .
```

## License

MIT — see [LICENSE](LICENSE).

---

## 繁體中文

**workflow-map** 在 Claude Code 輸入框上方以一行顯示目前工作：正在做甚麼、下一步、分段進度條。按 ▾ 展開成卡片圖（已完成收成「✓ N 已完成」、並行步驟疊在同一張卡）；輸入 `/workflow` 開啟全圖。你中途提出的要求會先以紫色菱形 ◇ 記錄下來，不會被遺忘。資料只存於專案的 `.claude/workflow-map.json`，不連網。介面語言跟隨你最近一次輸入（英文／繁中／簡中），亦可在設定 `language` 指定。

安裝（需要 Claude Code 2.1.287 或以上）：

- 桌面版：設定 → Plugins → Add from a repository → `mimateinn/workflow-map`
- 對話內：`/plugin install workflow-map --marketplace mimateinn/workflow-map`
- 終端機：`claude plugin install workflow-map --marketplace mimateinn/workflow-map`

想先看效果：輸入 `/workflow-demo`（只在畫面顯示，不寫入任何檔案）。
