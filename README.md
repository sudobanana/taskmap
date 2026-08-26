# TaskMap QA rebuild v14

A local-first TaskMap prototype using Next.js, React, TypeScript, Dexie/IndexedDB, React Flow, and an optional OpenAI-powered **Ask TaskMap** assistant.

## V14 data behavior

- IndexedDB schema **v9 preserves existing QA progress**.
- Existing QA checks are demoted to Normal; only the newest v14 calendar/icon checks seed as **Urgent**.
- Task deletion remains soft/tombstoned and writes normal transaction history.
- Recurring tasks continue to keep one active materialized occurrence while Calendar projects future occurrences virtually.

## New in v14

- Calendar now has Day and Week views.
- Week view can show either Monday–Friday (5 days) or Monday–Sunday (7 days).
- Unscheduled tasks share one strip across the top of the visible week and can be dragged into any day/time.
- Scheduled blocks can move vertically and across day columns, resize, or be dragged back to the Week Tasks strip to unschedule.
- Completed and virtual recurring occurrences remain visible in Week view using the same rules as Day view.
- The current-time line appears only inside today's week column.
- Calendar view/week-length preferences persist locally.
- The Chrome tab favicon and PWA icon now use the same indigo GitBranch mark as the TaskMap sidebar brand.
- Today now includes a Completed filter; Scheduled, Unscheduled, and Urgent counters exclude completed tasks, while Completed counts only tasks completed today.

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
