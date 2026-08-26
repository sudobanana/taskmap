import { activePayloads, applyChanges, cleanText, dateString, entityRow, entityRows, nowIso, resolveParentId, resolveProjectId, resolveTask, timeString, uuid, type ApiAuth } from "./core.ts";

function validPriority(value: unknown) { return ["urgent", "high", "normal", "low"].includes(String(value)); }
function validStatus(value: unknown) { return ["not_started", "in_progress", "blocked", "done"].includes(String(value)); }
function normalizeTags(value: unknown) { return Array.isArray(value) ? [...new Set(value.map(tag => cleanText(tag, 80)).filter(Boolean))].slice(0, 50) : []; }

export async function createTask(auth: ApiAuth, body: any, actionType = "API_TASK_CREATED") {
  const title = cleanText(body.title, 500);
  if (!title) throw new Error("title is required");
  const tasks = activePayloads(await entityRows(auth.workspaceId, "task"));
  const projectId = await resolveProjectId(auth, body);
  const parentTaskId = await resolveParentId(auth, body);
  const status = body.status === undefined ? "not_started" : String(body.status);
  const priority = body.priority === undefined ? "normal" : String(body.priority);
  if (!validStatus(status)) throw new Error("Invalid task status");
  if (!validPriority(priority)) throw new Error("Invalid task priority");
  const now = nowIso();
  const recurrence = body.recurrence && typeof body.recurrence === "object" ? body.recurrence : null;
  const manualOrder = Number.isFinite(Number(body.manualOrder)) ? Number(body.manualOrder) : Math.min(1000, ...tasks.map(task => Number(task.manualOrder ?? 1000))) - 1000;
  const task: any = {
    id: crypto.randomUUID(), title, notes: String(body.notes ?? "").slice(0, 100000), tags: normalizeTags(body.tags), status, priority,
    projectId: projectId ?? null, parentTaskId: parentTaskId ?? null, autoCompletedByParentId: null,
    startDate: dateString(body.startDate), startTime: timeString(body.startTime),
    estimatedMinutes: body.estimatedMinutes == null || body.estimatedMinutes === "" ? null : Math.max(0, Number(body.estimatedMinutes)),
    dueDate: dateString(body.dueDate), dueTime: timeString(body.dueTime), manualOrder,
    createdAt: now, updatedAt: now, completedAt: status === "done" ? now : null, deletedAt: null, purgedAt: null,
    revision: 1, recurrence, recurrenceSeriesId: recurrence?.enabled ? (uuid(body.recurrenceSeriesId) ? String(body.recurrenceSeriesId) : crypto.randomUUID()) : null, recurrenceOccurrence: recurrence?.enabled ? Math.max(1, Number(body.recurrenceOccurrence ?? 1)) : null,
  };
  await applyChanges(auth, "task", task.id, actionType, null, task);
  return task;
}

export async function updateTask(auth: ApiAuth, body: any) {
  const { task } = await resolveTask(auth, body);
  const changes = body.changes && typeof body.changes === "object" ? { ...body.changes } : body.patch && typeof body.patch === "object" ? { ...body.patch } : {};
  if ("status" in changes && changes.status !== task.status) throw new Error("Use complete_task or reopen_task to change completion state");
  const allowed = new Set(["title", "notes", "tags", "priority", "projectId", "projectName", "parentTaskId", "parentTitle", "startDate", "startTime", "estimatedMinutes", "dueDate", "dueTime", "recurrence"]);
  for (const key of Object.keys(changes)) if (!allowed.has(key)) delete changes[key];
  const patch: Record<string, unknown> = {};
  if ("title" in changes) { const title = cleanText(changes.title, 500); if (!title) throw new Error("title cannot be empty"); patch.title = title; }
  if ("notes" in changes) patch.notes = String(changes.notes ?? "").slice(0, 100000);
  if ("tags" in changes) patch.tags = normalizeTags(changes.tags);
  if ("priority" in changes) { if (!validPriority(changes.priority)) throw new Error("Invalid task priority"); patch.priority = String(changes.priority); }
  if ("projectId" in changes || "projectName" in changes) patch.projectId = (await resolveProjectId(auth, changes)) ?? null;
  if ("parentTaskId" in changes || "parentTitle" in changes) {
    const parent = await resolveParentId(auth, changes);
    if (parent === task.id) throw new Error("A task cannot be its own parent");
    patch.parentTaskId = parent ?? null; patch.autoCompletedByParentId = null;
  }
  if ("startDate" in changes) patch.startDate = dateString(changes.startDate);
  if ("startTime" in changes) patch.startTime = timeString(changes.startTime);
  if ("estimatedMinutes" in changes) patch.estimatedMinutes = changes.estimatedMinutes == null || changes.estimatedMinutes === "" ? null : Math.max(0, Number(changes.estimatedMinutes));
  if ("dueDate" in changes) patch.dueDate = dateString(changes.dueDate);
  if ("dueTime" in changes) patch.dueTime = timeString(changes.dueTime);
  if ("recurrence" in changes) {
    const recurrence = changes.recurrence && typeof changes.recurrence === "object" ? changes.recurrence : null;
    patch.recurrence = recurrence;
    if (recurrence && (recurrence as any).enabled && !task.recurrenceSeriesId) { patch.recurrenceSeriesId = crypto.randomUUID(); patch.recurrenceOccurrence = 1; }
    if (!recurrence || !(recurrence as any).enabled) { patch.recurrenceSeriesId = null; patch.recurrenceOccurrence = null; }
  }
  const now = nowIso(); patch.updatedAt = now; patch.revision = Number(task.revision ?? 0) + 1;
  return await applyChanges(auth, "task", task.id, "API_TASK_UPDATED", task, patch);
}

function parseDate(value: string) { const [y, m, d] = value.split("-").map(Number); return new Date(y, m - 1, d, 12, 0, 0, 0); }
function dateOnly(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function daysBetween(a: Date, b: Date) { return Math.floor((b.getTime() - a.getTime()) / 86400000); }
function monthsBetween(a: Date, b: Date) { return (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth(); }
function yearsBetween(a: Date, b: Date) { return b.getFullYear() - a.getFullYear(); }
function nthWeekdayOfMonth(date: Date, weekday: number) { const first = new Date(date.getFullYear(), date.getMonth(), 1, 12); return Math.floor((date.getDate() + ((first.getDay() - weekday + 7) % 7) - 1) / 7) + 1; }
function isLastWeekdayOfMonth(date: Date, weekday: number) { if (date.getDay() !== weekday) return false; const next = new Date(date); next.setDate(next.getDate() + 7); return next.getMonth() !== date.getMonth(); }
function isWeekday(date: Date) { return date.getDay() >= 1 && date.getDay() <= 5; }
function isFirstBusinessDay(date: Date) { if (!isWeekday(date)) return false; const cursor = new Date(date.getFullYear(), date.getMonth(), 1, 12); while (!isWeekday(cursor)) cursor.setDate(cursor.getDate() + 1); return cursor.getDate() === date.getDate(); }
function isLastBusinessDay(date: Date) { if (!isWeekday(date)) return false; const cursor = new Date(date.getFullYear(), date.getMonth() + 1, 0, 12); while (!isWeekday(cursor)) cursor.setDate(cursor.getDate() - 1); return cursor.getDate() === date.getDate(); }
function patternMatches(rule: any, start: Date, target: Date) {
  if (rule.specialMonthly === "first_weekday") return isFirstBusinessDay(target);
  if (rule.specialMonthly === "last_weekday") return isLastBusinessDay(target);
  if (rule.ordinal && rule.ordinalWeekday != null) { if (target.getDay() !== rule.ordinalWeekday) return false; return rule.ordinal === -1 ? isLastWeekdayOfMonth(target, rule.ordinalWeekday) : nthWeekdayOfMonth(target, rule.ordinalWeekday) === rule.ordinal; }
  if (Array.isArray(rule.monthDays) && rule.monthDays.length) { const last = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate(); return rule.monthDays.some((day: number) => day === -1 ? target.getDate() === last : target.getDate() === day); }
  return target.getDate() === start.getDate();
}
function occursOnDate(task: any, targetDate: string, occurrenceHint = 1) {
  const rule = task.recurrence; if (!rule?.enabled || !task.startDate) return false;
  if ((rule.excludedDates ?? []).includes(targetDate)) return false;
  if (rule.untilDate && targetDate > rule.untilDate) return false;
  if (rule.endMode === "count" && rule.count != null && occurrenceHint > rule.count) return false;
  const start = parseDate(rule.anchorDate ?? task.startDate), target = parseDate(targetDate);
  if (target < start) return false;
  if ((rule.months ?? []).length && !rule.months.includes(target.getMonth() + 1)) return false;
  const interval = Math.max(1, Number(rule.interval ?? 1));
  if (rule.frequency === "day") return daysBetween(start, target) % interval === 0 && (!(rule.weekdays ?? []).length || rule.weekdays.includes(target.getDay()));
  if (rule.frequency === "week") { const weeks = Math.floor(daysBetween(start, target) / 7); const validDay = (rule.weekdays ?? []).length ? rule.weekdays.includes(target.getDay()) : target.getDay() === start.getDay(); return weeks % interval === 0 && validDay; }
  if (rule.frequency === "month") return monthsBetween(start, target) % interval === 0 && patternMatches(rule, start, target);
  if (rule.frequency === "year") { if (yearsBetween(start, target) % interval !== 0) return false; const allowedMonth = (rule.months ?? []).length ? rule.months.includes(target.getMonth() + 1) : target.getMonth() === start.getMonth(); return allowedMonth && patternMatches(rule, start, target); }
  return false;
}
function timeMinutes(value: string | null) { if (!value) return 9 * 60; const [h, m] = value.split(":").map(Number); return h * 60 + m; }
function minutesTime(value: number) { const normalized = ((value % 1440) + 1440) % 1440; return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`; }
function nextOccurrence(task: any): { date: string; time: string | null } | null {
  const rule = task.recurrence; if (!rule?.enabled || !task.startDate) return null;
  const currentOccurrence = Number(task.recurrenceOccurrence ?? 1);
  if (rule.endMode === "count" && rule.count != null && currentOccurrence >= rule.count) return null;
  if (rule.frequency === "minute" || rule.frequency === "hour") {
    const current = parseDate(task.startDate), currentMinutes = timeMinutes(task.startTime); current.setHours(Math.floor(currentMinutes / 60), currentMinutes % 60, 0, 0);
    const step = Math.max(1, Number(rule.interval ?? 1)) * (rule.frequency === "hour" ? 60 : 1);
    for (let tries = 0; tries < 100000; tries++) { current.setMinutes(current.getMinutes() + step); const candidateDate = dateOnly(current); if (rule.endMode === "until" && rule.untilDate && candidateDate > rule.untilDate) return null; if (!(rule.excludedDates ?? []).includes(candidateDate)) return { date: candidateDate, time: minutesTime(current.getHours() * 60 + current.getMinutes()) }; }
    return null;
  }
  let cursor = parseDate(task.startDate);
  for (let i = 0; i < 366 * 100; i++) { cursor.setDate(cursor.getDate() + 1); const candidate = dateOnly(cursor); if (rule.endMode === "until" && rule.untilDate && candidate > rule.untilDate) return null; if (occursOnDate(task, candidate, currentOccurrence + 1)) return { date: candidate, time: task.startTime }; }
  return null;
}
function shiftDateByOffset(value: string | null, fromDate: string | null, toDate: string) {
  if (!value || !fromDate) return value; const from = parseDate(fromDate), target = parseDate(value), next = parseDate(toDate); const offsetDays = Math.round((target.getTime() - from.getTime()) / 86400000); next.setDate(next.getDate() + offsetDays); return dateOnly(next);
}

export async function completeTask(auth: ApiAuth, body: any) {
  const { task } = await resolveTask(auth, body);
  if (task.status === "done") return { task, changed: 0 };
  const rows = await entityRows(auth.workspaceId, "task"), tasks = activePayloads(rows);
  const descendants: any[] = [], queue = [task.id], seen = new Set<string>();
  while (queue.length) { const parentId = queue.shift()!; for (const child of tasks.filter(candidate => candidate.parentTaskId === parentId)) { if (seen.has(child.id)) continue; seen.add(child.id); descendants.push(child); queue.push(child.id); } }
  const targets = [task, ...descendants.filter(child => child.status !== "done")];
  const groupId = crypto.randomUUID(), now = nowIso();
  for (const target of targets) {
    if (target.status === "done") continue;
    const patch = { status: "done", completedAt: now, autoCompletedByParentId: target.id === task.id ? null : task.id, updatedAt: now, revision: Number(target.revision ?? 0) + 1 };
    await applyChanges(auth, "task", target.id, target.id === task.id ? "API_TASK_COMPLETED" : "API_TASK_COMPLETED_BY_PARENT", target, patch, groupId);
  }
  let nextTask: any = null;
  if (task.recurrence?.enabled) {
    const next = nextOccurrence(task);
    if (next) {
      const seriesId = task.recurrenceSeriesId ?? task.id, desiredOccurrence = Number(task.recurrenceOccurrence ?? 1) + 1;
      const series = tasks.filter(candidate => candidate.recurrenceSeriesId === seriesId && !candidate.deletedAt);
      const alreadyAdvanced = series.some(candidate => Number(candidate.recurrenceOccurrence ?? 0) >= desiredOccurrence);
      const duplicateDateTime = series.some(candidate => candidate.startDate === next.date && candidate.startTime === next.time);
      if (!alreadyAdvanced && !duplicateDateTime) {
        nextTask = await createTask(auth, {
          title: task.title, notes: task.notes, tags: task.tags, priority: task.priority, projectId: task.projectId, parentTaskId: task.parentTaskId,
          startDate: next.date, startTime: next.time, estimatedMinutes: task.estimatedMinutes,
          dueDate: shiftDateByOffset(task.dueDate, task.startDate, next.date), dueTime: task.dueTime, recurrence: task.recurrence,
          recurrenceSeriesId: seriesId, recurrenceOccurrence: desiredOccurrence,
        }, "API_RECURRENCE_ADVANCED");
      }
    }
  }
  return { taskId: task.id, changed: targets.length, nextOccurrence: nextTask };
}
export async function reopenTask(auth: ApiAuth, body: any) {
  const { task } = await resolveTask(auth, body);
  const tasks = activePayloads(await entityRows(auth.workspaceId, "task"));
  const targets = [task, ...tasks.filter(candidate => candidate.autoCompletedByParentId === task.id)];
  const groupId = crypto.randomUUID(), now = nowIso(); let changed = 0;
  for (const target of targets) {
    if (target.status !== "done") continue;
    const patch = { status: "not_started", completedAt: null, autoCompletedByParentId: null, updatedAt: now, revision: Number(target.revision ?? 0) + 1 };
    await applyChanges(auth, "task", target.id, target.id === task.id ? "API_TASK_REOPENED" : "API_TASK_REOPENED_WITH_PARENT", target, patch, groupId); changed++;
  }
  return { taskId: task.id, changed };
}
export async function deleteTask(auth: ApiAuth, body: any) {
  const { task } = await resolveTask(auth, body);
  const childMode = body.childMode === "cascade" ? "cascade" : "orphan";
  const tasks = activePayloads(await entityRows(auth.workspaceId, "task"));
  const deleteIds = new Set<string>([task.id]);
  if (childMode === "cascade") { const queue = [task.id]; while (queue.length) { const parentId = queue.shift()!; for (const child of tasks.filter(candidate => candidate.parentTaskId === parentId)) { if (deleteIds.has(child.id)) continue; deleteIds.add(child.id); queue.push(child.id); } } }
  const now = nowIso(), groupId = crypto.randomUUID();
  if (childMode === "orphan") {
    for (const child of tasks.filter(candidate => candidate.parentTaskId === task.id)) {
      const patch = { parentTaskId: null, autoCompletedByParentId: null, updatedAt: now, revision: Number(child.revision ?? 0) + 1 };
      await applyChanges(auth, "task", child.id, "API_TASK_ORPHANED_BY_PARENT_DELETE", child, patch, groupId);
    }
  }
  for (const id of deleteIds) {
    const target = tasks.find(candidate => candidate.id === id); if (!target || target.deletedAt) continue;
    const patch = { deletedAt: now, updatedAt: now, revision: Number(target.revision ?? 0) + 1 };
    await applyChanges(auth, "task", id, id === task.id ? "API_TASK_DELETED" : "API_TASK_DELETED_WITH_PARENT", target, patch, groupId);
  }
  return { taskId: task.id, deleted: deleteIds.size, childMode };
}
export async function restoreTask(auth: ApiAuth, body: any) {
  const { task } = await resolveTask(auth, body, true);
  if (!task.deletedAt) return { taskId: task.id, restored: 0 };
  const parent = task.parentTaskId ? await entityRow(auth.workspaceId, "task", task.parentTaskId) : null;
  const parentActive = !task.parentTaskId || Boolean(parent?.payload && !parent.is_deleted);
  const now = nowIso();
  const patch = { deletedAt: null, parentTaskId: parentActive ? task.parentTaskId : null, autoCompletedByParentId: parentActive ? task.autoCompletedByParentId : null, updatedAt: now, revision: Number(task.revision ?? 0) + 1 };
  await applyChanges(auth, "task", task.id, "API_TASK_RESTORED", task, patch);
  return { taskId: task.id, restored: 1 };
}
