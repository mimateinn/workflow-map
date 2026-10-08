# workflow-map file format

This is how `workflow-map` stores a plan. Other tools (Codex, Grok, scripts, other Claude sessions) can read and write the same files if they follow the rules below.

## Files

| Path (relative to the project root) | What it holds |
|---|---|
| `.claude/workflow-map.json` | The current plan. |
| `.claude/workflow-map.history/<timestamp>-<slug>.json` | One archived plan per file, same shape plus `archivedAt`. `<timestamp>` is the ISO time with `:` and `.` replaced by `-`, so names sort by time. |
| `.claude/workflow-map.v1-backup-<timestamp>.json` | The original text of a version 1 file, saved once before it was migrated. |
| `.claude/workflow-map.bad-<timestamp>.json` | A file that could not be parsed, saved before the plan restarted empty. |
| `.claude/workflow-map.undo.json` | Up to 10 earlier versions of the plan, newest last (`{ version: 1, snapshots: [{ at, label, map }] }`), for `/workflow undo`. An undo is applied as a new write, so it merges like any other change. |
| `.claude/workflow-map.export.md` | The plan as Markdown, written only by `/workflow export` or the Export button. |

All files are UTF-8 JSON. The plugin writes them pretty-printed with a trailing newline.

## Current plan (`schemaVersion` 2)

```json
{
  "schemaVersion": 2,
  "version": 1,
  "planId": "p-mgh3k2a1-x7f2",
  "title": "Dark mode",
  "createdAt": "2026-10-08T08:00:00.000Z",
  "updatedAt": "2026-10-08T09:12:00.000Z",
  "nodes": [
    {
      "id": "ui",
      "title": "Card layout",
      "status": "doing",
      "deps": ["model"],
      "owner": "Builder",
      "updatedAt": "2026-10-08T09:12:00.000Z",
      "startedAt": "2026-10-08T08:40:00.000Z",
      "log": [{ "at": "2026-10-08T08:40:00.000Z", "status": "doing", "by": "Builder" }]
    }
  ],
  "tombstones": [{ "id": "old-step", "at": "2026-10-08T09:00:00.000Z" }]
}
```

### Plan fields

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | number | `2`. Missing means version 1. A reader must not rewrite a file whose `schemaVersion` is higher than it knows. |
| `version` | number | Always `1`. Kept for readers written for version 1. |
| `planId` | string | Changes when a new plan starts. Merges only happen within one `planId`. |
| `title` | string | A short name for the task; may be empty. |
| `createdAt`, `updatedAt` | ISO 8601 string | When the plan started and when it last changed. |
| `archivedAt` | ISO 8601 string | History files only. |
| `nodes` | array | The steps, in display order. |
| `tombstones` | array of `{ id, at }` | Steps deleted from this plan and when they were deleted (see the merge rules). |

Unknown fields are preserved. A writer must copy through any field it does not understand, at the plan level and in each node.

### Node fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique within the plan; short and stable (`"A"`, `"build-ui"`). |
| `title` | string | Shown to the user, in the user's language. |
| `status` | `todo` · `doing` · `done` · `blocked` · `dropped` | `dropped` steps are hidden and not counted. |
| `deps` | string[] | Ids that must finish first. Every id must exist, and the graph must have no cycles. |
| `owner` | string, optional | Who does the step: an agent type or name, `"me"`, … |
| `note` | string, optional | A short remark. |
| `inserted` | `{ at, by: "user", note }`, optional | Work the user asked for mid-plan; `note` is their words. |
| `updatedAt` | ISO string | When the node last changed. **Set it whenever you change a node.** |
| `startedAt` | ISO string, optional | The first time the status became `doing`. |
| `doneAt` | ISO string, optional | When the status became `done`; removed if the step is reopened. |
| `log` | array of `{ at, status, by? }`, optional | Status changes, oldest first, at most 10 entries. |

Two steps run in parallel when neither depends on the other, directly or through other steps.

## Writing safely (merge rules)

Several writers may touch the file at once (this plugin, another session, Codex, Grok). The file system offers no atomic rename to plugins, so every writer must **read, merge and write**:

1. Read the file and parse it.
2. Make your change. Set `updatedAt` to the current time on each node you add or change. When you delete a node, add `{ "id", "at": <now> }` to `tombstones`, and remove the id from other nodes' `deps`.
3. Just before writing, read the file again. If its `planId` differs from the one you started from and it has nodes, someone started a new plan: do not write. Read it again and redo your change.
4. Merge per node:
   - for each `id`, keep the copy with the newer `updatedAt` (on a tie, keep yours);
   - a node is deleted when a tombstone for its `id` is at least as new as the node's `updatedAt`, so a deletion never comes back from an older copy. Re-creating the id with a newer `updatedAt` revives it and drops the tombstone;
   - keep your order of nodes, then add nodes only the file had;
   - drop `deps` that point at deleted nodes;
   - reject the merge if it creates a dependency cycle.
5. Write the whole file.

## New plans and history

A new plan starts when the model calls `new_plan`, or calls `set_plan` while every step of the current plan is `done` or `dropped`. The current plan, as it is on disk at that moment, is first written to `.claude/workflow-map.history/`. Then the new plan, with a new `planId` and empty `tombstones`, replaces `.claude/workflow-map.json`. Nothing from the old plan is carried over: user-inserted steps are kept across `set_plan` only within the same plan.

## Migration from version 1

A version 1 file has no `schemaVersion`, `planId`, `title`, `createdAt` or `tombstones`, and its nodes have no `updatedAt`. On first load the plugin:

1. saves the original text as `.claude/workflow-map.v1-backup-<timestamp>.json`;
2. adds `schemaVersion: 2`, a new `planId`, `title: ""`, `createdAt` (the file's `updatedAt`), `tombstones: []`, and `updatedAt` on every node (the file's `updatedAt`);
3. writes the result back.

Nothing is removed. A reader that only needs `nodes[].id/title/status/deps` works with both versions.

## Sub-agent sync

When a sub-agent is started with `[wm:<id>]` in its description (or prompt) and a step with that id exists, the plugin sets the step to `doing` with `owner` = the agent's name or type. When that agent's turn ends, the step becomes `done`, or `blocked` with a note if the agent errored, was stopped, or refused.
