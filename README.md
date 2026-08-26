# TaskMap QA rebuild v12

A local-first TaskMap prototype using Next.js, React, TypeScript, Dexie/IndexedDB, React Flow, and an optional OpenAI-powered **Ask TaskMap** assistant.

## V12 data behavior

- IndexedDB schema **v8 preserves existing QA progress**.
- Existing QA checks are demoted to Normal; only the newest v12 regression check seeds as **Urgent**.
- Task deletion remains soft/tombstoned and writes normal transaction history.
- Recurring tasks continue to keep one active materialized occurrence while Calendar projects future occurrences virtually.

## New in v12

- Task Details inputs are editable again: only field labels/drag handles initiate dragging.
- Lower-row field dragging remains supported, including untitled action blocks via their dedicated handles.
- QA specifically validates editing every Task Details field after rearranging the layout.

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
