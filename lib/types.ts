export type TaskStatus = "not_started" | "in_progress" | "blocked" | "done";
export type TaskPriority = "urgent" | "high" | "normal" | "low";

export type RecurrenceFrequency = "minute" | "hour" | "day" | "week" | "month" | "year";
export type RecurrenceEndMode = "forever" | "count" | "until";
export type RecurrenceOrdinal = 1 | 2 | 3 | 4 | 5 | -1;

export interface RecurrenceRule {
  enabled: boolean;
  frequency: RecurrenceFrequency;
  interval: number;
  weekdays: number[]; // 0=Sunday ... 6=Saturday
  monthDays: number[]; // 1..31, -1 = last day
  months: number[]; // 1..12; empty = every month
  ordinal: RecurrenceOrdinal | null;
  ordinalWeekday: number | null;
  /** Useful monthly/yearly patterns that are not a single weekday ordinal. */
  specialMonthly?: "first_weekday" | "last_weekday" | null;
  /** Dates intentionally skipped without changing the series rule. */
  excludedDates?: string[];
  endMode: RecurrenceEndMode;
  count: number | null;
  untilDate: string | null;
  /** Stable series anchor so interval rules do not drift as active occurrences advance. */
  anchorDate?: string | null;
  anchorTime?: string | null;
}

export interface TaskTemplateNode {
  templateNodeId: string;
  parentTemplateNodeId: string | null;
  title: string;
  notes: string;
  tags: string[];
  priority: TaskPriority;
  projectId: string | null;
  estimatedMinutes: number | null;
  recurrence?: RecurrenceRule | null;
}

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  nodes: TaskTemplateNode[];
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  tags: string[];
  status: TaskStatus;
  priority: TaskPriority;
  projectId: string | null;
  parentTaskId: string | null;
  /** Set only when this task was automatically completed by checking a parent. */
  autoCompletedByParentId: string | null;
  startDate: string | null;
  startTime: string | null;
  estimatedMinutes: number | null;
  dueDate: string | null;
  dueTime: string | null;
  manualOrder: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  /** Local permanent-delete marker. Purged rows are hidden from Trash but retained as a minimal tombstone/audit anchor. */
  purgedAt: string | null;
  revision: number;
  recurrence: RecurrenceRule | null;
  recurrenceSeriesId: string | null;
  recurrenceOccurrence: number | null;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCategory {
  id: string;
  name: string;
  rule: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskLayout {
  taskId: string;
  x: number;
  y: number;
  collapsed: boolean;
  updatedAt: string;
}

export interface Transaction {
  id: string;
  entityType: "task" | "task_layout" | "project" | "task_category" | "dev_backlog" | "task_template";
  entityId: string;
  actionType: string;
  /** Multiple entity transactions from one user action share a group id. */
  groupId?: string | null;
  deviceId: string;
  clientTimestamp: string;
  serverReceivedTimestamp: string | null;
  baseRevision: number;
  resultRevision: number;
  syncStatus: "pending" | "synced" | "conflict";
}

export interface TransactionChange {
  id: string;
  transactionId: string;
  fieldName: string;
  oldValue: unknown;
  newValue: unknown;
}

export type DevBacklogKind = "bug" | "feature" | "improvement" | "idea";
export type DevBacklogStatus = "open" | "planned" | "done";

export interface DevBacklogItem {
  id: string;
  title: string;
  details: string;
  kind: DevBacklogKind;
  status: DevBacklogStatus;
  createdAt: string;
  updatedAt: string;
}

export type AssistantAction =
  | { type: "create_task"; title: string; notes?: string; priority?: TaskPriority; projectName?: string; parentTitle?: string; startDate?: string | null; startTime?: string | null; estimatedMinutes?: number | null; dueDate?: string | null; dueTime?: string | null; tags?: string[] }
  | { type: "update_task"; taskTitle: string; title?: string; notes?: string; priority?: TaskPriority; status?: TaskStatus; projectName?: string | null; parentTitle?: string | null; startDate?: string | null; startTime?: string | null; estimatedMinutes?: number | null; dueDate?: string | null; dueTime?: string | null; tags?: string[] }
  | { type: "complete_task"; taskTitle: string }
  | { type: "reopen_task"; taskTitle: string }
  | { type: "delete_task"; taskTitle: string }
  | { type: "create_project"; name: string }
  | { type: "create_category"; name: string; rule: string }
  | { type: "delete_category"; name: string }
  | { type: "remember_backlog"; title: string; details?: string; kind?: DevBacklogKind }
  | { type: "filter_project"; projectName: string | null }
  | { type: "focus_parent"; taskTitle: string }
  | { type: "set_sort"; sort: TaskSortMode }
  | { type: "set_show_completed"; value: boolean }
  | { type: "open_task"; taskTitle: string }
  | { type: "set_recurrence"; taskTitle: string; rule: RecurrenceRule | null }
  | { type: "save_task_as_template"; taskTitle: string; templateName?: string }
  | { type: "use_template"; templateName: string; projectName?: string | null }
  | { type: "set_view"; view: "today" | "inbox" | "map" | "calendar" | "tasks" | "completed" | "templates" };

export type TaskSortMode = "manual" | "priority" | "due" | "start" | "created" | "alphabetical";
export type TodayFilter = "scheduled" | "unscheduled" | "urgent" | "completed" | null;
