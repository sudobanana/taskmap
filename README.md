# TaskMap QA rebuild v15

A local-first TaskMap prototype using Next.js, React, TypeScript, Dexie/IndexedDB, React Flow, and an optional OpenAI-powered **Ask TaskMap** assistant.

## V15 data behavior

- IndexedDB schema **v10 preserves tasks and QA progress** but resets saved Mind Map node positions/collapse state once so the redesigned planning canvas opens cleanly.
- Existing QA checks are demoted to Normal; only the newest v15 Mind Map/task-drag checks seed as **Urgent**.
- Task deletion remains soft/tombstoned and writes normal transaction history.
- Recurring tasks continue to keep one active materialized occurrence while Calendar projects future occurrences virtually.

## New in v15

- Mind Map is redesigned as a visual planning workspace around the real parent/child hierarchy rather than a loose grid of task cards.
- Parent/child trees receive a clean automatic initial layout and can be reset at any time with **Auto Arrange**.
- Layout direction can switch between **Left → right** and **Top → bottom**.
- Parent nodes can collapse/expand whole descendant branches without changing task relationships.
- Planning nodes show useful context including priority, project, due date, tags, recurrence, completion state, and child count.
- Completed nodes can be Dimmed, shown normally, or hidden.
- The right-side Available Tasks tray remains scope-aware; tasks can be dropped onto empty canvas or directly onto a node to make them a child.
- Hierarchy connections remain selectable/deletable and use a distinct solid-line style.
- Task-list drag behavior is restored with a dedicated draggable `⋮⋮` handle. Manual sort supports insertion-line reordering, while dropping directly onto another task makes it a subtask even outside Manual sort. Sidebar project drops still work.

## Previous feature set

- Task-card Tags render as clickable filters beside Project and Parent chips.
- Task Details renders Tags as clickable filters too.
- Task Details field layout now persists explicit rows instead of auto-packing a flat grid.
- Dragging a field shows exact own-row / left-column / right-column destinations.
- Moving one field out of a pair leaves its partner full-width; the following row does not jump upward.

- Full recurrence rule builder with minute/hour/day/week/month/year intervals, selected weekdays, weekday/weekend presets, selected months, first/last day, specific month days, First–Fifth/Last weekday, first/last weekday, skipped-date exceptions, and Forever / Count / Until endings.
- Inbox now renders subtasks and nested descendants beneath their parent.
- Template creation/editing now looks and behaves like a task list: hierarchy rows, selection, task-like details, drag-to-reorder/nest, and comma-delimited Quick Add.
- **Use Template** immediately navigates to the newly created parent-focused Tasks view.
- Delete Task in Task Details plus multi-select delete in Tasks, Inbox, Today, and Completed.
- Parent deletion asks whether to delete all descendants or keep children by making them top-level.
- Normal Quick Add supports comma-delimited multi-task creation.
- Transaction History is collapsed by default.
- Task Details fields can be rearranged by dragging their labels; the saved layout keeps a responsive two-column grid.
- Expanded Notes is a sanitized rich HTML editor with formatting, links, raw HTML mode, pasted HTML, and pasted/dropped images.

## Enable Ask TaskMap

Copy `.env.example` to `.env.local` and set:

```text
OPENAI_API_KEY=your_key_here
```

Then restart TaskMap. On Vercel, add the same `OPENAI_API_KEY` in Project Settings → Environment Variables.

## Run locally on Windows

Double-click **`START TASKMAP.bat`**.

Or run:

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## Architecture

Current task state is materialized in IndexedDB for fast reads. Committed user actions update that state and append immutable transactions with field-level old/new values. Recurrence rules remain compact and Calendar only expands the visible date. Templates are separate definitions that create fresh task IDs when used. Task Detail field layout is local UI preference state and does not alter task history.

## TaskMap v1.1.1 — Mobile fixes and recovery

TaskMap v1.0 is the former v15.1 desktop/local-first checkpoint. v1.1 added the responsive mobile shell. v1.1.1 fixes mobile pill filtering and persistent deletion, adds Settings → Trash recovery, mobile project creation, and the Quick Add hierarchy syntax (`>`, `<`, `<<`, and commas). Template Quick Add also preserves the current template focus when adding new rows.
