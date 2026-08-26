import { db } from "./db";
import { getDeviceId } from "./device";
import { shouldDelayQaSeed } from "./workspace-storage";
import type { DevBacklogItem, DevBacklogKind, Project, Task, TaskCategory, TaskLayout, TaskTemplate, TaskTemplateNode, TransactionChange } from "./types";
import { localDateOnly } from "./format";
import { nextOccurrence } from "./recurrence";

const nowIso = () => new Date().toISOString();

function shiftDateByOffset(value: string | null, fromDate: string | null, toDate: string) {
  if (!value || !fromDate) return value;
  const parse = (text: string) => { const [y,m,d] = text.split("-").map(Number); return new Date(y,m-1,d,12); };
  const from = parse(fromDate), target = parse(value), next = parse(toDate);
  const offsetDays = Math.round((target.getTime() - from.getTime()) / 86400000);
  next.setDate(next.getDate() + offsetDays);
  return `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,"0")}-${String(next.getDate()).padStart(2,"0")}`;
}

function changedFields<T extends Record<string, unknown>>(before: T, patch: Partial<T>) {
  return Object.entries(patch).filter(([key, value]) => before[key] !== value);
}

async function nextManualOrder() {
  // New tasks should appear at the top when Manual sort is active.
  const first = await db.tasks.orderBy("manualOrder").first();
  return (first?.manualOrder ?? 1000) - 1000;
}

export async function createTask(input: Partial<Task> & Pick<Task, "title">, options?: { groupId?: string | null; actionType?: string }) {
  const now = nowIso();
  const task: Task = {
    id: crypto.randomUUID(),
    title: input.title.trim(),
    notes: input.notes ?? "",
    tags: input.tags ?? [],
    status: input.status ?? "not_started",
    priority: input.priority ?? "normal",
    projectId: input.projectId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    autoCompletedByParentId: input.autoCompletedByParentId ?? null,
    startDate: input.startDate ?? null,
    startTime: input.startTime ?? null,
    estimatedMinutes: input.estimatedMinutes ?? null,
    dueDate: input.dueDate ?? null,
    dueTime: input.dueTime ?? null,
    manualOrder: input.manualOrder ?? await nextManualOrder(),
    createdAt: now,
    updatedAt: now,
    completedAt: input.status === "done" ? now : null,
    deletedAt: null,
    purgedAt: null,
    revision: 1,
    recurrence: input.recurrence ?? null,
    recurrenceSeriesId: input.recurrenceSeriesId ?? (input.recurrence?.enabled ? crypto.randomUUID() : null),
    recurrenceOccurrence: input.recurrenceOccurrence ?? (input.recurrence?.enabled ? 1 : null),
  };

  const txId = crypto.randomUUID();
  await db.transaction("rw", db.tasks, db.transactions, db.transactionChanges, async () => {
    await db.tasks.add(task);
    await db.transactions.add({
      id: txId,
      entityType: "task",
      entityId: task.id,
      actionType: options?.actionType ?? "TASK_CREATED",
      groupId: options?.groupId ?? null,
      deviceId: getDeviceId(),
      clientTimestamp: now,
      serverReceivedTimestamp: null,
      baseRevision: 0,
      resultRevision: 1,
      syncStatus: "pending",
    });
    await db.transactionChanges.add({
      id: crypto.randomUUID(),
      transactionId: txId,
      fieldName: "__entity__",
      oldValue: null,
      newValue: task,
    });
  });
  return task;
}

export async function updateTask(id: string, patch: Partial<Task>, actionType = "TASK_UPDATED") {
  const before = await db.tasks.get(id);
  if (!before) throw new Error("Task not found");

  const meaningfulPatch = Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => (before as unknown as Record<string, unknown>)[key] !== value)
  ) as Partial<Task>;
  if (!Object.keys(meaningfulPatch).length) return before;

  const updatedAt = nowIso();
  const sanitizedPatch: Partial<Task> = { ...meaningfulPatch, updatedAt, revision: before.revision + 1 };
  if ("parentTaskId" in meaningfulPatch || "status" in meaningfulPatch) sanitizedPatch.autoCompletedByParentId = null;
  const changes = changedFields(before as unknown as Record<string, unknown>, sanitizedPatch as Record<string, unknown>);
  const txId = crypto.randomUUID();

  await db.transaction("rw", db.tasks, db.transactions, db.transactionChanges, async () => {
    await db.tasks.update(id, sanitizedPatch);
    await db.transactions.add({
      id: txId,
      entityType: "task",
      entityId: id,
      actionType,
      deviceId: getDeviceId(),
      clientTimestamp: updatedAt,
      serverReceivedTimestamp: null,
      baseRevision: before.revision,
      resultRevision: before.revision + 1,
      syncStatus: "pending",
    });
    await db.transactionChanges.bulkAdd(
      changes.map(([fieldName, newValue]) => ({
        id: crypto.randomUUID(),
        transactionId: txId,
        fieldName,
        oldValue: (before as unknown as Record<string, unknown>)[fieldName],
        newValue,
      }))
    );
  });

  return db.tasks.get(id);
}


export async function changeTaskProject(taskId: string, projectId: string | null, includeDescendants: boolean) {
  const allTasks = await db.tasks.filter(task => !task.deletedAt).toArray();
  const root = allTasks.find(task => task.id === taskId);
  if (!root) throw new Error("Task not found");
  const ids = new Set<string>([taskId]);
  if (includeDescendants) {
    const queue = [taskId];
    while (queue.length) {
      const parentId = queue.shift()!;
      for (const child of allTasks.filter(task => task.parentTaskId === parentId)) {
        if (ids.has(child.id)) continue;
        ids.add(child.id);
        queue.push(child.id);
      }
    }
  }
  const now = nowIso();
  const groupId = crypto.randomUUID();
  await db.transaction("rw", db.tasks, db.transactions, db.transactionChanges, async () => {
    for (const id of ids) {
      const before = await db.tasks.get(id);
      if (!before || before.projectId === projectId) continue;
      const patch: Partial<Task> = { projectId, updatedAt: now, revision: before.revision + 1 };
      await db.tasks.update(id, patch);
      const txId = crypto.randomUUID();
      await db.transactions.add({
        id: txId,
        entityType: "task",
        entityId: id,
        actionType: id === taskId ? "TASK_PROJECT_CHANGED" : "TASK_PROJECT_CHANGED_WITH_PARENT",
        groupId,
        deviceId: getDeviceId(),
        clientTimestamp: now,
        serverReceivedTimestamp: null,
        baseRevision: before.revision,
        resultRevision: before.revision + 1,
        syncStatus: "pending",
      });
      await db.transactionChanges.bulkAdd([
        { id: crypto.randomUUID(), transactionId: txId, fieldName: "projectId", oldValue: before.projectId, newValue: projectId },
        { id: crypto.randomUUID(), transactionId: txId, fieldName: "updatedAt", oldValue: before.updatedAt, newValue: now },
        { id: crypto.randomUUID(), transactionId: txId, fieldName: "revision", oldValue: before.revision, newValue: before.revision + 1 },
      ]);
    }
  });
  return db.tasks.get(taskId);
}

export async function deleteTaskSet(taskIds: string[], childMode: "cascade" | "orphan") {
  const uniqueRoots = [...new Set(taskIds)];
  if (!uniqueRoots.length) return;
  const allTasks = await db.tasks.filter(task => !task.deletedAt).toArray();
  const rootSet = new Set(uniqueRoots);
  const deleteIds = new Set(uniqueRoots);

  if (childMode === "cascade") {
    const queue = [...uniqueRoots];
    while (queue.length) {
      const parentId = queue.shift()!;
      for (const child of allTasks.filter(task => task.parentTaskId === parentId)) {
        if (deleteIds.has(child.id)) continue;
        deleteIds.add(child.id);
        queue.push(child.id);
      }
    }
  }

  const now = nowIso();
  const groupId = crypto.randomUUID();
  await db.transaction("rw", db.tasks, db.transactions, db.transactionChanges, async () => {
    if (childMode === "orphan") {
      for (const child of allTasks.filter(task => task.parentTaskId && rootSet.has(task.parentTaskId) && !deleteIds.has(task.id))) {
        const before = await db.tasks.get(child.id);
        if (!before) continue;
        const patch: Partial<Task> = { parentTaskId: null, autoCompletedByParentId: null, updatedAt: now, revision: before.revision + 1 };
        await db.tasks.update(child.id, patch);
        const txId = crypto.randomUUID();
        await db.transactions.add({ id: txId, entityType: "task", entityId: child.id, actionType: "TASK_ORPHANED_BY_PARENT_DELETE", groupId, deviceId: getDeviceId(), clientTimestamp: now, serverReceivedTimestamp: null, baseRevision: before.revision, resultRevision: before.revision + 1, syncStatus: "pending" });
        await db.transactionChanges.bulkAdd([
          { id: crypto.randomUUID(), transactionId: txId, fieldName: "parentTaskId", oldValue: before.parentTaskId, newValue: null },
          { id: crypto.randomUUID(), transactionId: txId, fieldName: "autoCompletedByParentId", oldValue: before.autoCompletedByParentId, newValue: null },
        ]);
      }
    }

    for (const id of deleteIds) {
      const before = await db.tasks.get(id);
      if (!before || before.deletedAt) continue;
      const patch: Partial<Task> = { deletedAt: now, updatedAt: now, revision: before.revision + 1 };
      await db.tasks.update(id, patch);
      const txId = crypto.randomUUID();
      await db.transactions.add({ id: txId, entityType: "task", entityId: id, actionType: childMode === "cascade" && !rootSet.has(id) ? "TASK_DELETED_WITH_PARENT" : "TASK_DELETED", groupId, deviceId: getDeviceId(), clientTimestamp: now, serverReceivedTimestamp: null, baseRevision: before.revision, resultRevision: before.revision + 1, syncStatus: "pending" });
      await db.transactionChanges.bulkAdd([
        { id: crypto.randomUUID(), transactionId: txId, fieldName: "deletedAt", oldValue: before.deletedAt, newValue: now },
      ]);
    }
  });
}

export async function restoreTaskSet(taskIds: string[], includeHierarchy = false) {
  const requested = [...new Set(taskIds)];
  if (!requested.length) return;
  const allTasks = await db.tasks.toArray();
  const byId = new Map(allTasks.map(task => [task.id, task]));
  const restoreIds = new Set(requested.filter(id => byId.get(id)?.deletedAt && !byId.get(id)?.purgedAt));

  if (includeHierarchy) {
    const queue = [...restoreIds];
    while (queue.length) {
      const id = queue.shift()!;
      const task = byId.get(id);
      if (!task) continue;
      if (task.parentTaskId) {
        const parent = byId.get(task.parentTaskId);
        if (parent?.deletedAt && !parent.purgedAt && !restoreIds.has(parent.id)) {
          restoreIds.add(parent.id);
          queue.push(parent.id);
        }
      }
      for (const child of allTasks.filter(candidate => candidate.parentTaskId === id && candidate.deletedAt && !candidate.purgedAt)) {
        if (restoreIds.has(child.id)) continue;
        restoreIds.add(child.id);
        queue.push(child.id);
      }
    }
  }

  const now = nowIso();
  const groupId = crypto.randomUUID();
  await db.transaction("rw", db.tasks, db.transactions, db.transactionChanges, async () => {
    for (const id of restoreIds) {
      const before = await db.tasks.get(id);
      if (!before?.deletedAt || before.purgedAt) continue;
      const parent = before.parentTaskId ? await db.tasks.get(before.parentTaskId) : null;
      const parentWillBeActive = !before.parentTaskId || Boolean(parent && (!parent.deletedAt || restoreIds.has(parent.id)));
      const patch: Partial<Task> = {
        deletedAt: null,
        parentTaskId: parentWillBeActive ? before.parentTaskId : null,
        autoCompletedByParentId: parentWillBeActive ? before.autoCompletedByParentId : null,
        updatedAt: now,
        revision: before.revision + 1,
      };
      await db.tasks.update(id, patch);
      const txId = crypto.randomUUID();
      await db.transactions.add({
        id: txId,
        entityType: "task",
        entityId: id,
        actionType: "TASK_RESTORED",
        groupId,
        deviceId: getDeviceId(),
        clientTimestamp: now,
        serverReceivedTimestamp: null,
        baseRevision: before.revision,
        resultRevision: before.revision + 1,
        syncStatus: "pending",
      });
      await db.transactionChanges.bulkAdd([
        { id: crypto.randomUUID(), transactionId: txId, fieldName: "deletedAt", oldValue: before.deletedAt, newValue: null },
        ...(before.parentTaskId !== patch.parentTaskId ? [{ id: crypto.randomUUID(), transactionId: txId, fieldName: "parentTaskId", oldValue: before.parentTaskId, newValue: patch.parentTaskId }] : []),
      ]);
    }
  });
}

export async function permanentlyDeleteTaskSet(taskIds: string[]) {
  const ids = [...new Set(taskIds)];
  if (!ids.length) return;
  const now = nowIso();
  const candidates = (await db.tasks.bulkGet(ids)).filter((task): task is Task => Boolean(task?.deletedAt && !task?.purgedAt));
  if (!candidates.length) return;
  await db.transaction("rw", db.tasks, db.taskLayouts, db.transactions, db.transactionChanges, async () => {
    for (const before of candidates) {
      const patch: Partial<Task> = {
        purgedAt: now,
        notes: "",
        tags: [],
        startDate: null,
        startTime: null,
        estimatedMinutes: null,
        dueDate: null,
        dueTime: null,
        recurrence: null,
        updatedAt: now,
        revision: before.revision + 1,
      };
      await db.tasks.update(before.id, patch);
      await db.taskLayouts.delete(before.id);
      const txId = crypto.randomUUID();
      await db.transactions.add({ id: txId, entityType: "task", entityId: before.id, actionType: "TASK_PERMANENTLY_DELETED", deviceId: getDeviceId(), clientTimestamp: now, serverReceivedTimestamp: null, baseRevision: before.revision, resultRevision: before.revision + 1, syncStatus: "pending" });
      await db.transactionChanges.add({ id: crypto.randomUUID(), transactionId: txId, fieldName: "purgedAt", oldValue: before.purgedAt ?? null, newValue: now });
    }
  });
}

export async function toggleTaskComplete(task: Task) {
  const done = task.status !== "done";
  const allTasks = await db.tasks.filter(candidate => !candidate.deletedAt).toArray();
  const groupId = crypto.randomUUID();

  if (done) {
    const descendants: Task[] = [];
    const queue = [task.id];
    const seen = new Set<string>();
    while (queue.length) {
      const parentId = queue.shift()!;
      for (const child of allTasks.filter(candidate => candidate.parentTaskId === parentId)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        descendants.push(child);
        queue.push(child.id);
      }
    }

    const targets = [task, ...descendants.filter(child => child.status !== "done")];
    const now = nowIso();
    await db.transaction("rw", db.tasks, db.transactions, db.transactionChanges, async () => {
      for (const target of targets) {
        const before = await db.tasks.get(target.id);
        if (!before) continue;
        const patch: Partial<Task> = {
          status: "done",
          completedAt: now,
          autoCompletedByParentId: target.id === task.id ? null : task.id,
          updatedAt: now,
          revision: before.revision + 1,
        };
        const changes = changedFields(before as unknown as Record<string, unknown>, patch as Record<string, unknown>);
        await db.tasks.update(target.id, patch);
        const txId = crypto.randomUUID();
        await db.transactions.add({
          id: txId, entityType: "task", entityId: target.id, actionType: target.id === task.id ? "TASK_COMPLETED" : "TASK_COMPLETED_BY_PARENT", groupId,
          deviceId: getDeviceId(), clientTimestamp: now, serverReceivedTimestamp: null, baseRevision: before.revision, resultRevision: before.revision + 1, syncStatus: "pending",
        });
        await db.transactionChanges.bulkAdd(changes.map(([fieldName, newValue]) => ({
          id: crypto.randomUUID(), transactionId: txId, fieldName, oldValue: (before as unknown as Record<string, unknown>)[fieldName], newValue,
        })));
      }
    });
    if (task.recurrence?.enabled) {
      const completed = await db.tasks.get(task.id);
      const next = completed ? nextOccurrence(completed) : null;
      if (completed && next) {
        const seriesId = completed.recurrenceSeriesId ?? completed.id;
        const desiredOccurrence = (completed.recurrenceOccurrence ?? 1) + 1;
        const existingSeries = await db.tasks.where("recurrenceSeriesId").equals(seriesId).filter(candidate => !candidate.deletedAt).toArray();
        const alreadyAdvanced = existingSeries.some(candidate => (candidate.recurrenceOccurrence ?? 0) >= desiredOccurrence);
        const duplicateDateTime = existingSeries.some(candidate => candidate.startDate === next.date && candidate.startTime === next.time);
        if (!alreadyAdvanced && !duplicateDateTime) await createTask({
          title: completed.title, notes: completed.notes, tags: completed.tags, priority: completed.priority,
          projectId: completed.projectId, parentTaskId: completed.parentTaskId, startDate: next.date, startTime: next.time,
          estimatedMinutes: completed.estimatedMinutes, dueDate: shiftDateByOffset(completed.dueDate, completed.startDate, next.date), dueTime: completed.dueTime,
          recurrence: completed.recurrence, recurrenceSeriesId: seriesId, recurrenceOccurrence: desiredOccurrence,
        });
      }
    }
    return db.tasks.get(task.id);
  }

  // Reopen the parent and only descendants that were completed by that parent action.
  const targets = [task, ...allTasks.filter(candidate => candidate.autoCompletedByParentId === task.id)];
  const now = nowIso();
  await db.transaction("rw", db.tasks, db.transactions, db.transactionChanges, async () => {
    for (const target of targets) {
      const before = await db.tasks.get(target.id);
      if (!before || before.status !== "done") continue;
      const patch: Partial<Task> = { status: "not_started", completedAt: null, autoCompletedByParentId: null, updatedAt: now, revision: before.revision + 1 };
      const changes = changedFields(before as unknown as Record<string, unknown>, patch as Record<string, unknown>);
      await db.tasks.update(target.id, patch);
      const txId = crypto.randomUUID();
      await db.transactions.add({
        id: txId, entityType: "task", entityId: target.id, actionType: target.id === task.id ? "TASK_REOPENED" : "TASK_REOPENED_WITH_PARENT", groupId,
        deviceId: getDeviceId(), clientTimestamp: now, serverReceivedTimestamp: null, baseRevision: before.revision, resultRevision: before.revision + 1, syncStatus: "pending",
      });
      await db.transactionChanges.bulkAdd(changes.map(([fieldName, newValue]) => ({
        id: crypto.randomUUID(), transactionId: txId, fieldName, oldValue: (before as unknown as Record<string, unknown>)[fieldName], newValue,
      })));
    }
  });
  return db.tasks.get(task.id);
}

export async function addDevBacklogItem(title: string, details = "", kind: DevBacklogKind = "feature") {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("Backlog title is required");
  const now = nowIso();
  const item: DevBacklogItem = { id: crypto.randomUUID(), title: trimmed, details: details.trim(), kind, status: "open", createdAt: now, updatedAt: now };
  const txId = crypto.randomUUID();
  await db.transaction("rw", db.devBacklog, db.transactions, db.transactionChanges, async () => {
    await db.devBacklog.add(item);
    await db.transactions.add({ id: txId, entityType: "dev_backlog", entityId: item.id, actionType: "DEV_BACKLOG_ADDED", deviceId: getDeviceId(), clientTimestamp: now, serverReceivedTimestamp: null, baseRevision: 0, resultRevision: 1, syncStatus: "pending" });
    await db.transactionChanges.add({ id: crypto.randomUUID(), transactionId: txId, fieldName: "__entity__", oldValue: null, newValue: item });
  });
  return item;
}

export async function updateDevBacklogItem(id: string, patch: Partial<DevBacklogItem>) {
  const before = await db.devBacklog.get(id);
  if (!before) throw new Error("Backlog item not found");
  const now = nowIso();
  const nextPatch = { ...patch, updatedAt: now };
  const changes = changedFields(before as unknown as Record<string, unknown>, nextPatch as unknown as Record<string, unknown>);
  if (!changes.length) return before;
  const txId = crypto.randomUUID();
  await db.transaction("rw", db.devBacklog, db.transactions, db.transactionChanges, async () => {
    await db.devBacklog.update(id, nextPatch);
    await db.transactions.add({ id: txId, entityType: "dev_backlog", entityId: id, actionType: "DEV_BACKLOG_UPDATED", deviceId: getDeviceId(), clientTimestamp: now, serverReceivedTimestamp: null, baseRevision: 1, resultRevision: 2, syncStatus: "pending" });
    await db.transactionChanges.bulkAdd(changes.map(([fieldName, newValue]) => ({ id: crypto.randomUUID(), transactionId: txId, fieldName, oldValue: (before as unknown as Record<string, unknown>)[fieldName], newValue })));
  });
  return db.devBacklog.get(id);
}

function manualOrderAt(orderedTasks: Task[], taskId: string, destinationIndex: number) {
  const moved = orderedTasks.find(task => task.id === taskId);
  if (!moved) return null;
  const without = orderedTasks.filter(task => task.id !== taskId);
  const clamped = Math.max(0, Math.min(destinationIndex, without.length));
  const next = [...without.slice(0, clamped), moved, ...without.slice(clamped)];
  const index = next.findIndex(task => task.id === taskId);
  const previous = next[index - 1];
  const following = next[index + 1];

  if (previous && following) return (previous.manualOrder + following.manualOrder) / 2;
  if (previous) return previous.manualOrder + 1000;
  if (following) return following.manualOrder - 1000;
  return 1000;
}

export async function reorderTask(taskId: string, orderedTasks: Task[], destinationIndex: number) {
  const manualOrder = manualOrderAt(orderedTasks, taskId, destinationIndex);
  if (manualOrder == null) return;
  return updateTask(taskId, { manualOrder }, "TASK_REORDERED");
}

export async function moveTaskInList(taskId: string, orderedTasks: Task[], destinationIndex: number, parentTaskId: string | null) {
  const manualOrder = manualOrderAt(orderedTasks, taskId, destinationIndex);
  if (manualOrder == null) return;
  return updateTask(taskId, { manualOrder, parentTaskId }, "TASK_MOVED");
}

export async function moveTaskNode(taskId: string, x: number, y: number) {
  const now = nowIso();
  const before = await db.taskLayouts.get(taskId);
  if (before && before.x === x && before.y === y) return;
  const txId = crypto.randomUUID();
  const next: TaskLayout = { taskId, x, y, collapsed: before?.collapsed ?? false, updatedAt: now };

  await db.transaction("rw", db.taskLayouts, db.transactions, db.transactionChanges, async () => {
    await db.taskLayouts.put(next);
    await db.transactions.add({
      id: txId,
      entityType: "task_layout",
      entityId: taskId,
      actionType: "MAP_NODE_MOVED",
      deviceId: getDeviceId(),
      clientTimestamp: now,
      serverReceivedTimestamp: null,
      baseRevision: 0,
      resultRevision: 0,
      syncStatus: "pending",
    });
    await db.transactionChanges.bulkAdd([
      { id: crypto.randomUUID(), transactionId: txId, fieldName: "x", oldValue: before?.x ?? null, newValue: x },
      { id: crypto.randomUUID(), transactionId: txId, fieldName: "y", oldValue: before?.y ?? null, newValue: y },
    ]);
  });
}


export async function setTaskNodeCollapsed(taskId: string, collapsed: boolean, fallbackX = 0, fallbackY = 0) {
  const now = nowIso();
  const before = await db.taskLayouts.get(taskId);
  if (before && before.collapsed === collapsed) return;
  const txId = crypto.randomUUID();
  const next: TaskLayout = { taskId, x: before?.x ?? fallbackX, y: before?.y ?? fallbackY, collapsed, updatedAt: now };
  await db.transaction("rw", db.taskLayouts, db.transactions, db.transactionChanges, async () => {
    await db.taskLayouts.put(next);
    await db.transactions.add({
      id: txId,
      entityType: "task_layout",
      entityId: taskId,
      actionType: collapsed ? "MAP_BRANCH_COLLAPSED" : "MAP_BRANCH_EXPANDED",
      deviceId: getDeviceId(),
      clientTimestamp: now,
      serverReceivedTimestamp: null,
      baseRevision: 0,
      resultRevision: 0,
      syncStatus: "pending",
    });
    await db.transactionChanges.add({ id: crypto.randomUUID(), transactionId: txId, fieldName: "collapsed", oldValue: before?.collapsed ?? false, newValue: collapsed });
  });
}

export async function arrangeTaskNodes(entries: Array<{ taskId: string; x: number; y: number }>) {
  if (!entries.length) return;
  const now = nowIso();
  const groupId = crypto.randomUUID();
  const deviceId = getDeviceId();
  await db.transaction("rw", db.taskLayouts, db.transactions, db.transactionChanges, async () => {
    for (const entry of entries) {
      const before = await db.taskLayouts.get(entry.taskId);
      if (before && before.x === entry.x && before.y === entry.y) continue;
      const txId = crypto.randomUUID();
      await db.taskLayouts.put({ taskId: entry.taskId, x: entry.x, y: entry.y, collapsed: before?.collapsed ?? false, updatedAt: now });
      await db.transactions.add({
        id: txId,
        entityType: "task_layout",
        entityId: entry.taskId,
        actionType: "MAP_AUTO_ARRANGED",
        groupId,
        deviceId,
        clientTimestamp: now,
        serverReceivedTimestamp: null,
        baseRevision: 0,
        resultRevision: 0,
        syncStatus: "pending",
      });
      await db.transactionChanges.bulkAdd([
        { id: crypto.randomUUID(), transactionId: txId, fieldName: "x", oldValue: before?.x ?? null, newValue: entry.x },
        { id: crypto.randomUUID(), transactionId: txId, fieldName: "y", oldValue: before?.y ?? null, newValue: entry.y },
      ]);
    }
  });
}

export async function createProject(name: string, color = "#5B5BD6") {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Project name is required");
  const now = nowIso();
  const project: Project = { id: crypto.randomUUID(), name: trimmed, color, createdAt: now, updatedAt: now };
  const txId = crypto.randomUUID();
  await db.transaction("rw", db.projects, db.transactions, db.transactionChanges, async () => {
    await db.projects.add(project);
    await db.transactions.add({
      id: txId,
      entityType: "project",
      entityId: project.id,
      actionType: "PROJECT_CREATED",
      deviceId: getDeviceId(),
      clientTimestamp: now,
      serverReceivedTimestamp: null,
      baseRevision: 0,
      resultRevision: 1,
      syncStatus: "pending",
    });
    await db.transactionChanges.add({ id: crypto.randomUUID(), transactionId: txId, fieldName: "__entity__", oldValue: null, newValue: project });
  });
  return project;
}

export async function updateProject(id: string, patch: Pick<Partial<Project>, "name" | "color">) {
  const before = await db.projects.get(id);
  if (!before) throw new Error("Project not found");
  const nextPatch: Partial<Project> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("Project name is required");
    const duplicate = (await db.projects.toArray()).find(project => project.id !== id && project.name.trim().toLowerCase() === name.toLowerCase());
    if (duplicate) throw new Error(`Project already exists: ${name}`);
    nextPatch.name = name;
  }
  if (patch.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(patch.color)) throw new Error("Project color must be a six-digit hex value");
    nextPatch.color = patch.color;
  }
  const meaningful = Object.fromEntries(Object.entries(nextPatch).filter(([key,value]) => (before as unknown as Record<string,unknown>)[key] !== value)) as Partial<Project>;
  if (!Object.keys(meaningful).length) return before;
  const now = nowIso();
  meaningful.updatedAt = now;
  const txId = crypto.randomUUID();
  await db.transaction("rw", db.projects, db.transactions, db.transactionChanges, async () => {
    await db.projects.update(id, meaningful);
    await db.transactions.add({ id:txId, entityType:"project", entityId:id, actionType:"PROJECT_UPDATED", deviceId:getDeviceId(), clientTimestamp:now, serverReceivedTimestamp:null, baseRevision:1, resultRevision:2, syncStatus:"pending" });
    await db.transactionChanges.bulkAdd(Object.entries(meaningful).map(([fieldName,newValue]) => ({ id:crypto.randomUUID(), transactionId:txId, fieldName, oldValue:(before as unknown as Record<string,unknown>)[fieldName] ?? null, newValue })));
  });
  return db.projects.get(id);
}

export async function deleteProject(id: string, taskMode: "detach" | "cascade") {
  const project = await db.projects.get(id);
  if (!project) throw new Error("Project not found");
  const allTasks = (await db.tasks.toArray()).filter(task => !task.purgedAt);
  const assigned = allTasks.filter(task => task.projectId === id);
  const affectedIds = new Set(assigned.map(task => task.id));
  if (taskMode === "cascade") {
    const queue = [...affectedIds];
    while (queue.length) {
      const parentId = queue.shift()!;
      for (const child of allTasks.filter(task => task.parentTaskId === parentId)) {
        if (affectedIds.has(child.id)) continue;
        affectedIds.add(child.id);
        queue.push(child.id);
      }
    }
  }
  const now = nowIso();
  const groupId = crypto.randomUUID();
  await db.transaction("rw", db.projects, db.tasks, db.transactions, db.transactionChanges, async () => {
    if (taskMode === "detach") {
      for (const before of assigned) {
        const patch: Partial<Task> = { projectId:null, updatedAt:now, revision:before.revision + 1 };
        await db.tasks.update(before.id, patch);
        const txId = crypto.randomUUID();
        await db.transactions.add({ id:txId, entityType:"task", entityId:before.id, actionType:"TASK_DETACHED_BY_PROJECT_DELETE", groupId, deviceId:getDeviceId(), clientTimestamp:now, serverReceivedTimestamp:null, baseRevision:before.revision, resultRevision:before.revision + 1, syncStatus:"pending" });
        await db.transactionChanges.bulkAdd([
          { id:crypto.randomUUID(), transactionId:txId, fieldName:"projectId", oldValue:before.projectId, newValue:null },
          { id:crypto.randomUUID(), transactionId:txId, fieldName:"updatedAt", oldValue:before.updatedAt, newValue:now },
          { id:crypto.randomUUID(), transactionId:txId, fieldName:"revision", oldValue:before.revision, newValue:before.revision + 1 },
        ]);
      }
    } else {
      for (const taskId of affectedIds) {
        const before = allTasks.find(task => task.id === taskId);
        if (!before || before.deletedAt) continue;
        const patch: Partial<Task> = { deletedAt:now, updatedAt:now, revision:before.revision + 1 };
        if (before.projectId === id) patch.projectId = null;
        await db.tasks.update(before.id, patch);
        const txId = crypto.randomUUID();
        await db.transactions.add({ id:txId, entityType:"task", entityId:before.id, actionType:before.projectId === id ? "TASK_DELETED_WITH_PROJECT" : "TASK_DELETED_WITH_PROJECT_DESCENDANT", groupId, deviceId:getDeviceId(), clientTimestamp:now, serverReceivedTimestamp:null, baseRevision:before.revision, resultRevision:before.revision + 1, syncStatus:"pending" });
        const changes: TransactionChange[] = [
          { id:crypto.randomUUID(), transactionId:txId, fieldName:"deletedAt", oldValue:before.deletedAt, newValue:now },
          { id:crypto.randomUUID(), transactionId:txId, fieldName:"updatedAt", oldValue:before.updatedAt, newValue:now },
          { id:crypto.randomUUID(), transactionId:txId, fieldName:"revision", oldValue:before.revision, newValue:before.revision + 1 },
        ];
        if (before.projectId === id) changes.push({ id:crypto.randomUUID(), transactionId:txId, fieldName:"projectId", oldValue:before.projectId, newValue:null });
        await db.transactionChanges.bulkAdd(changes);
      }
    }
    await db.projects.delete(id);
    const txId = crypto.randomUUID();
    await db.transactions.add({ id:txId, entityType:"project", entityId:id, actionType:taskMode === "cascade" ? "PROJECT_DELETED_WITH_TASKS" : "PROJECT_DELETED_KEEP_TASKS", groupId, deviceId:getDeviceId(), clientTimestamp:now, serverReceivedTimestamp:null, baseRevision:1, resultRevision:2, syncStatus:"pending" });
    await db.transactionChanges.add({ id:crypto.randomUUID(), transactionId:txId, fieldName:"__entity__", oldValue:project, newValue:null });
  });
  return { projectId:id, taskMode, assignedTasks:assigned.length, affectedTasks:affectedIds.size };
}

export async function createTaskCategory(name: string, rule: string, color = "#5B5BD6") {
  const trimmedName = name.trim();
  const trimmedRule = rule.trim();
  if (!trimmedName || !trimmedRule) throw new Error("Category name and rule are required");
  const now = nowIso();
  const category: TaskCategory = { id: crypto.randomUUID(), name: trimmedName, rule: trimmedRule, color, createdAt: now, updatedAt: now };
  const txId = crypto.randomUUID();
  await db.transaction("rw", db.taskCategories, db.transactions, db.transactionChanges, async () => {
    await db.taskCategories.add(category);
    await db.transactions.add({
      id: txId,
      entityType: "task_category",
      entityId: category.id,
      actionType: "TASK_CATEGORY_CREATED",
      deviceId: getDeviceId(),
      clientTimestamp: now,
      serverReceivedTimestamp: null,
      baseRevision: 0,
      resultRevision: 1,
      syncStatus: "pending",
    });
    await db.transactionChanges.add({ id: crypto.randomUUID(), transactionId: txId, fieldName: "__entity__", oldValue: null, newValue: category });
  });
  return category;
}

export async function deleteTaskCategory(id: string) {
  const category = await db.taskCategories.get(id);
  if (!category) return;
  const now = nowIso();
  const txId = crypto.randomUUID();
  await db.transaction("rw", db.taskCategories, db.transactions, db.transactionChanges, async () => {
    await db.taskCategories.delete(id);
    await db.transactions.add({
      id: txId,
      entityType: "task_category",
      entityId: id,
      actionType: "TASK_CATEGORY_DELETED",
      deviceId: getDeviceId(),
      clientTimestamp: now,
      serverReceivedTimestamp: null,
      baseRevision: 1,
      resultRevision: 2,
      syncStatus: "pending",
    });
    await db.transactionChanges.add({ id: crypto.randomUUID(), transactionId: txId, fieldName: "__entity__", oldValue: category, newValue: null });
  });
}


export async function createTaskTemplate(name: string, nodes: TaskTemplateNode[], description = "") {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Template name is required");
  if (!nodes.length) throw new Error("Template needs at least one task");
  const now = nowIso();
  const template: TaskTemplate = { id: crypto.randomUUID(), name: trimmed, description: description.trim(), nodes, createdAt: now, updatedAt: now };
  const txId = crypto.randomUUID();
  await db.transaction("rw", db.taskTemplates, db.transactions, db.transactionChanges, async () => {
    await db.taskTemplates.add(template);
    await db.transactions.add({ id: txId, entityType: "task_template", entityId: template.id, actionType: "TASK_TEMPLATE_CREATED", deviceId: getDeviceId(), clientTimestamp: now, serverReceivedTimestamp: null, baseRevision: 0, resultRevision: 1, syncStatus: "pending" });
    await db.transactionChanges.add({ id: crypto.randomUUID(), transactionId: txId, fieldName: "__entity__", oldValue: null, newValue: template });
  });
  return template;
}

export async function updateTaskTemplate(id: string, patch: Partial<TaskTemplate>) {
  const before = await db.taskTemplates.get(id);
  if (!before) throw new Error("Template not found");
  const now = nowIso();
  const nextPatch = { ...patch, updatedAt: now };
  const changes = changedFields(before as unknown as Record<string, unknown>, nextPatch as unknown as Record<string, unknown>);
  if (!changes.length) return before;
  const txId = crypto.randomUUID();
  await db.transaction("rw", db.taskTemplates, db.transactions, db.transactionChanges, async () => {
    await db.taskTemplates.update(id, nextPatch);
    await db.transactions.add({ id: txId, entityType: "task_template", entityId: id, actionType: "TASK_TEMPLATE_UPDATED", deviceId: getDeviceId(), clientTimestamp: now, serverReceivedTimestamp: null, baseRevision: 1, resultRevision: 2, syncStatus: "pending" });
    await db.transactionChanges.bulkAdd(changes.map(([fieldName,newValue]) => ({ id: crypto.randomUUID(), transactionId: txId, fieldName, oldValue: (before as unknown as Record<string, unknown>)[fieldName], newValue })));
  });
  return db.taskTemplates.get(id);
}

export async function deleteTaskTemplate(id: string) {
  const before = await db.taskTemplates.get(id);
  if (!before) return;
  const now = nowIso();
  const txId = crypto.randomUUID();
  await db.transaction("rw", db.taskTemplates, db.transactions, db.transactionChanges, async () => {
    await db.taskTemplates.delete(id);
    await db.transactions.add({ id: txId, entityType: "task_template", entityId: id, actionType: "TASK_TEMPLATE_DELETED", deviceId: getDeviceId(), clientTimestamp: now, serverReceivedTimestamp: null, baseRevision: 1, resultRevision: 2, syncStatus: "pending" });
    await db.transactionChanges.add({ id: crypto.randomUUID(), transactionId: txId, fieldName: "__entity__", oldValue: before, newValue: null });
  });
}

export async function saveTaskHierarchyAsTemplate(rootTaskId: string, name?: string) {
  const all = await db.tasks.filter(task => !task.deletedAt).toArray();
  const root = all.find(task => task.id === rootTaskId);
  if (!root) throw new Error("Task not found");
  const nodes: TaskTemplateNode[] = [];
  const idMap = new Map<string,string>();
  const queue = [root];
  const selected: Task[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    selected.push(current);
    queue.push(...all.filter(task => task.parentTaskId === current.id));
  }
  for (const task of selected) idMap.set(task.id, crypto.randomUUID());
  for (const task of selected) nodes.push({ templateNodeId: idMap.get(task.id)!, parentTemplateNodeId: task.parentTaskId && idMap.has(task.parentTaskId) ? idMap.get(task.parentTaskId)! : null, title: task.title, notes: task.notes, tags: task.tags ?? [], priority: task.priority, projectId: task.projectId, estimatedMinutes: task.estimatedMinutes, recurrence: task.recurrence });
  return createTaskTemplate(name?.trim() || root.title, nodes, `Saved from task hierarchy: ${root.title}`);
}

export async function useTaskTemplate(templateId: string, options?: { projectId?: string | null; startDate?: string | null }) {
  const template = await db.taskTemplates.get(templateId);
  if (!template) throw new Error("Template not found");
  const taskIds = new Map<string,string>();
  const created: Task[] = [];
  const ordered = [...template.nodes].sort((a,b) => Number(Boolean(a.parentTemplateNodeId)) - Number(Boolean(b.parentTemplateNodeId)));
  let unresolved = ordered;
  while (unresolved.length) {
    const nextRound: TaskTemplateNode[] = [];
    let progressed = false;
    for (const node of unresolved) {
      if (node.parentTemplateNodeId && !taskIds.has(node.parentTemplateNodeId)) { nextRound.push(node); continue; }
      const createdTask = await createTask({ title: node.title, notes: node.notes, tags: node.tags, priority: node.priority, projectId: options?.projectId !== undefined ? options.projectId : node.projectId, parentTaskId: node.parentTemplateNodeId ? taskIds.get(node.parentTemplateNodeId)! : null, startDate: options?.startDate ?? null, estimatedMinutes: node.estimatedMinutes, recurrence: node.recurrence ?? null });
      taskIds.set(node.templateNodeId, createdTask.id);
      created.push(createdTask);
      progressed = true;
    }
    if (!progressed) throw new Error("Template hierarchy contains an invalid parent relationship");
    unresolved = nextRound;
  }
  return created;
}

export async function seedQaChecklist() {
  if (shouldDelayQaSeed()) return;
  const today = localDateOnly();

  const checklist: Array<Partial<Task> & Pick<Task, "title">> = [
    {
      title: "Create a new task",
      notes: "Use the quick-add field to create a task. Confirm it appears immediately and remains after refresh.",
    },
    {
      title: "Edit a task title",
      notes: "Open this task, change the title, and click away. Confirm one TASK_TITLE_CHANGED transaction is created.",
    },
    {
      title: "Verify amber unsaved field indicator",
      notes: "Change any Task Details field without clicking away. Confirm the field outline/state is amber and says Unsaved; after blur it should return to normal.",
    },
    {
      title: "Verify one transaction per completed field edit",
      notes: "Change Duration through several values before clicking away. Confirm only the final value creates a transaction.",
      estimatedMinutes: 15,
    },
    {
      title: "Edit task notes",
      notes: "Change these notes, then click away. Confirm the notes save once and history records one notes transaction.",
    },
    {
      title: "Change task status",
      notes: "Change Status between Not started, In progress, and Blocked. Each committed change should persist.",
    },
    {
      title: "Change task priority",
      notes: "Change Priority and confirm the list/map priority indicator updates after the field is committed.",
    },
    {
      title: "Assign a task to a project",
      notes: "Move this task to another project after creating one, then verify project filtering reflects the change.",
    },
    {
      title: "Set a start date",
      notes: "Set and clear Start date. Confirm it persists and is represented in transaction history.",
    },
    {
      title: "Set a start time",
      notes: "Set and clear Start time. With a Start date set, confirm the task becomes scheduled on Calendar.",
    },
    {
      title: "Set estimated duration",
      notes: "Set Duration in minutes and confirm Calendar uses the duration to size a scheduled block.",
    },
    {
      title: "Set a due date",
      notes: "Set and clear Due date. A task due today without a start time should appear in Today as unscheduled.",
    },
    {
      title: "Set a due time",
      notes: "Set and clear Due time and verify it persists after refresh.",
    },
    {
      title: "Verify Task Details field alignment",
      notes: "Open Task Details and visually verify Duration, Start date/time, Due date/time, Project, Priority, and Status align consistently.",
    },
    {
      title: "Complete and reopen a task",
      notes: "Check this task complete, then click it again to reopen it. Both actions should create transactions.",
    },
    {
      title: "Completed task stays visible on Today",
      notes: "This task is due today. Complete it from Today and confirm it remains visible in-place with completed styling.",
      dueDate: today,
    },
    {
      title: "Open the Completed view",
      notes: "Complete a task, open Completed in the sidebar, verify it appears there, then reopen it.",
    },
    {
      title: "Toggle Show completed",
      notes: "Use the Show completed control on Tasks/Today and verify completed tasks hide/show without being deleted.",
    },
    {
      title: "Drag a task to manually reorder",
      notes: "With Sort = Manual, drag this task above/below another task. Refresh and confirm the order persists.",
    },
    {
      title: "Reorder a task with arrow controls",
      notes: "With Sort = Manual, use the up/down controls as the non-drag reordering option and confirm order persists.",
    },
    {
      title: "Change predefined task sort mode",
      notes: "Test Priority, Due date, Start date, Created date, and Alphabetical sorts; return to Manual afterward.",
    },
    {
      title: "Create a new project",
      notes: "Use + New Project in the sidebar. Confirm the project is clickable and remains after refresh.",
    },
    {
      title: "Filter tasks by project",
      notes: "Click TaskMap QA Checklist in the sidebar, then All projects. Confirm the visible task set changes correctly.",
    },
    {
      title: "Open Inbox tasks",
      notes: "Create a task with no project and no parent, then open Inbox and confirm it appears there.",
    },
    {
      title: "Move a mind-map node",
      notes: "Open Map, drag this node, release it, refresh, and confirm its position persists.",
    },
    {
      title: "Connect two mind-map nodes",
      notes: "Open Map and drag a right-side connector to another task's left-side connector. Confirm an edge appears and the child relationship persists.",
    },
    {
      title: "Disconnect mind-map nodes",
      notes: "Select an existing map edge and press Delete/Backspace. Confirm the edge and parent relationship are removed.",
    },
    {
      title: "Verify map prevents circular parent relationships",
      notes: "Create a parent/child edge, then attempt to connect the child back as the parent's parent. The app should refuse the cycle.",
    },
    {
      title: "Today Urgent counter filters tasks",
      notes: "Set a task to Urgent, open Today and click Urgent. Only urgent tasks should remain; click Urgent again to clear the filter.",
      dueDate: today,
    },
    {
      title: "Today Scheduled counter filters tasks",
      notes: "Open Today and click Scheduled. Only tasks with a start time should remain; click again to clear.",
      startDate: today,
      startTime: "10:00",
      estimatedMinutes: 60,
    },
    {
      title: "Today Unscheduled counter filters tasks",
      notes: "Open Today and click Unscheduled. Only today's tasks without a start time should remain; click again to clear.",
      dueDate: today,
      estimatedMinutes: 30,
    },
    {
      title: "Calendar creates a timed block from start time and duration",
      notes: "Open Calendar. This task should occupy a 90-minute block starting at 2:00 PM.",
      startDate: today,
      startTime: "14:00",
      estimatedMinutes: 90,
    },
    {
      title: "Calendar shows unscheduled due-today tasks at the top",
      notes: "Open Calendar. This due-today task has no start time and should appear in Today's tasks above the timeline.",
      dueDate: today,
      estimatedMinutes: 45,
    },
    {
      title: "Calendar shows urgent unscheduled tasks at the top",
      notes: "Set this task to Urgent, then open Calendar. It should appear in Day Tasks even without a start time.",
    },
    {
      title: "Open transaction history",
      notes: "Edit this task, then verify Task Details history shows the action and old → new values.",
    },
    {
      title: "Verify task changes persist after page refresh",
      notes: "Edit this task, refresh the page, and confirm the latest local state remains in IndexedDB.",
    },
    {
      title: "Verify offline status indicator",
      notes: "Disconnect the network while TaskMap is open and confirm the header changes to Offline without losing local task access.",
    },
    {
      title: "Verify offline page reload after prior online load",
      notes: "After TaskMap has loaded online once, go offline and refresh/reopen it. Confirm the cached app shell and IndexedDB tasks load.",
    },
    {
      title: "Verify pending transaction count updates",
      notes: "Make a local edit and confirm the pending-sync count/status reflects locally queued transactions.",
    },
    {
      title: "Manual drag shows an insertion line",
      notes: "With Sort = Manual, drag a task between two rows. Confirm a highlighted line clearly shows the exact insertion point before dropping.",
    },
    {
      title: "New tasks appear at the top in Manual sort",
      notes: "With Sort = Manual, create a new task and confirm it appears at the top of the current task stack and stays there after refresh.",
    },
    {
      title: "Dropping onto a task creates a subtask",
      notes: "Drag another task onto the middle of this row. Confirm the drop target highlights and the dragged task becomes this task's child.",
    },
    {
      title: "Parent Task field assigns hierarchy",
      notes: "Open Task Details and change Parent task. Confirm the hierarchy updates in Tasks and the Mind Map.",
    },
    {
      title: "Parent task link opens the parent",
      notes: "This seeded subtask has a parent. Open Task Details and use Open parent to navigate directly to it.",
    },
    {
      title: "Parent filter shows parent and all descendants",
      notes: "Use a Parent tag or Show this task + all subtasks. Confirm only the parent and its descendant tree are visible until the filter is cleared.",
    },
    {
      title: "Subtasks render indented under their parent",
      notes: "Confirm this seeded subtask is directly below its parent and visibly indented in the Tasks checklist.",
    },
    {
      title: "Project and Parent tags are clickable",
      notes: "Click the Project tag to filter by that project, then click the Parent tag to focus the parent hierarchy.",
    },
    {
      title: "Tasks navigation resets to All Projects",
      notes: "Select a project, navigate elsewhere, then click Tasks in the side menu. Confirm the project scope resets to All Projects.",
    },
    {
      title: "Calendar block can be dragged to a new start time",
      notes: "Drag this scheduled block vertically and release it. Confirm one transaction updates Start time and the block stays at the new time.",
      startDate: today,
      startTime: "09:00",
      estimatedMinutes: 60,
    },
    {
      title: "Calendar bottom resize changes duration",
      notes: "Resize the bottom edge of this scheduled block. Confirm one transaction changes Estimated Duration after release.",
      startDate: today,
      startTime: "11:00",
      estimatedMinutes: 60,
    },
    {
      title: "Calendar top resize changes start and duration",
      notes: "Resize the top edge of this block. Confirm Start time and Duration update together in a single transaction.",
      startDate: today,
      startTime: "13:00",
      estimatedMinutes: 90,
    },
    {
      title: "Calendar can move backward and forward by day",
      notes: "Use Previous day, Today, and Next day. Confirm the heading and scheduled/unscheduled tasks match the selected date.",
    },
    {
      title: "Completed tasks remain on Calendar",
      notes: "Complete this scheduled task and confirm it remains in its time slot with completed styling instead of disappearing.",
      startDate: today,
      startTime: "16:00",
      estimatedMinutes: 45,
    },
    {
      title: "Calendar shows a live current-time line",
      notes: "Open Calendar on Today and confirm a horizontal current-time line appears at the correct time and is absent on other days.",
    },
    {
      title: "Mind Map All Tasks filter",
      notes: "Set Map Scope to All tasks. Confirm every task is on the canvas and the Available tasks tray is hidden.",
    },
    {
      title: "Mind Map Project filter and available-task tray",
      notes: "Set Map Scope to By project. Confirm only project tasks are on the map and tasks outside the project appear in the right-hand tray.",
    },
    {
      title: "Mind Map Parent filter and available-task tray",
      notes: "Set Map Scope to By parent. Confirm the parent plus descendants are mapped and all other tasks appear in the tray.",
    },
    {
      title: "Drag an available task from the tray onto the map",
      notes: "With a project or parent map scope active, drag a task from the right tray onto empty map space. Confirm it joins that scope and its drop position persists.",
    },
    {
      title: "Mind Map parent relationships auto-render as lines",
      notes: "Set a Parent task outside the map UI, then open the map. Confirm the parent/subtask connector appears automatically.",
    },
    {
      title: "Select and delete a Mind Map connection",
      notes: "Click a connection line and confirm it highlights. Delete it with Delete/Backspace or the Delete connection button and confirm the parent relationship clears.",
    },
    { title: "Task Details shifts workspace when room is available", notes: "On a wide screen, open Task Details and confirm the task workspace reflows left instead of being covered. Close it and confirm full width returns." },
    { title: "Inbox navigation resets to All Projects", notes: "Select a project, then click Inbox. Confirm the project filter resets to All Projects before Inbox is shown." },
    { title: "Search Tasks filters visible tasks", notes: "Use the top search input. Confirm title, notes, project, parent, and tag matches narrow the current scope immediately and clearing search restores it." },
    { title: "Parent completion checks incomplete descendants", notes: "Create a parent with multiple nested children, leave some incomplete, then complete the parent. Confirm all incomplete descendants are completed." },
    { title: "Reopening a parent only reopens auto-completed descendants", notes: "Complete one child manually first, then complete and reopen the parent. Confirm only children completed by the parent action reopen." },
    { title: "Drag a task onto a sidebar project", notes: "Drag a task row onto a project in the sidebar. Confirm the project highlights, the task is reassigned, and its Project tag updates." },
    { title: "Drag Day Task onto Calendar to schedule", notes: "In Calendar, drag an unscheduled Day Task onto a time. Confirm start date/time are set from the drop and duration is preserved." },
    { title: "Drag scheduled task into Day Tasks to unschedule", notes: "Drag a scheduled calendar block into Day Tasks. Confirm start time clears while the selected date remains assigned." },
    { title: "Open Ask TaskMap assistant", notes: "Open Ask TaskMap and confirm it explains how to configure OPENAI_API_KEY when no key is available." },
    { title: "Assistant executes normal TaskMap actions", notes: "With OPENAI_API_KEY configured, ask the assistant to create/update/schedule tasks and confirm actions go through normal TaskMap transactions." },
    { title: "Assistant handles multi-action real-world instructions", notes: "Ask for a project plus multiple tasks, hierarchy, priorities, and scheduling in one instruction. Confirm the proposed actions execute in order." },
    { title: "Assistant remembers hidden bugs and feature ideas", notes: "Ask TaskMap to remember a bug or feature. Confirm it appears only in the assistant Development Backlog, not the normal task views." },
    { title: "Development backlog can be reviewed and updated", notes: "Open the assistant Backlog tab, review hidden items, and change an item status without creating normal tasks." },
    { title: "Templates appears in the left menu", notes: "Click Templates in the sidebar and confirm the reusable workflow library opens without changing live tasks.", priority: "normal" },
    { title: "Create a parent + children task template", notes: "Create a template such as Monday Chores with child tasks Do dishes and Fold clothes. Confirm the hierarchy preview is correct.", priority: "normal" },
    { title: "Use Template creates the full task hierarchy", notes: "Use a saved template. Confirm a fresh parent and all child tasks are created at once with new task IDs.", priority: "normal" },
    { title: "Save existing task hierarchy as a template", notes: "Open a parent Task Details and choose Save task + subtasks as template. Confirm it appears in Templates and can be reused.", priority: "normal" },
    { title: "Make a task repeat every X minutes or hours", notes: "In Task Details enable Repeat, choose minute/hour and an interval, save it, and confirm the recurring badge appears.", priority: "normal" },
    { title: "Make a task repeat by day/week/month/year", notes: "Test interval recurrence plus weekday, month-day, last-day, ordinal weekday, and selected-month combinations.", priority: "normal" },
    { title: "Recurring task supports count, until date, or forever", notes: "Change Ends between Forever, After X occurrences, and On a date. Confirm the saved recurrence reflects the selection.", priority: "normal" },
    { title: "Recurring completion hides old active occurrence", notes: "Complete a recurring task from Tasks. Confirm the completed occurrence disappears from active task views and the next occurrence becomes the single active row.", priority: "normal" },
    { title: "Recurring history keeps completed occurrences", notes: "After completing a recurring task, open Completed and confirm the old occurrence remains available as historical evidence.", priority: "normal" },
    { title: "Calendar projects future recurring occurrences virtually", notes: "Navigate Calendar into the future and confirm recurring blocks appear with projected styling without creating large numbers of task rows.", priority: "normal" },
    { title: "Task Details panel is larger on wide screens", notes: "Open Task Details on a wide display. Confirm the panel is larger and the Tasks workspace shifts over when room exists.", priority: "normal" },
    { title: "Notes can expand into a full-note window", notes: "Open Task Details, click Expand in Notes, and confirm the complete note can be viewed and edited in a larger modal.", priority: "normal" },
    { title: "Parent link in Task Details focuses parent hierarchy", notes: "Open a subtask, click Focus parent, and confirm Tasks filters to only that parent and all descendants.", priority: "normal" },
    { title: "Ask TaskMap environment setup is documented", notes: "Without an API key, confirm Ask TaskMap tells you to add OPENAI_API_KEY to .env.local and Vercel environment variables.", priority: "normal" },

    // V7 checks are retained as Normal in v8 so only the newest rebuild stays Urgent.
    { title: "Repeat builder supports complete interval frequencies", notes: "Verify every X minutes, hours, days, weeks, months, and years can be configured and saved.", priority: "normal" },
    { title: "Repeat builder supports weekday and weekend combinations", notes: "Verify daily/weekly rules can target selected weekdays, weekdays only, weekends only, and multiple selected days.", priority: "normal" },
    { title: "Repeat builder supports monthly position rules", notes: "Verify first/last day, specific month days, first through fifth or last weekday, first weekday, and last weekday patterns.", priority: "normal" },
    { title: "Repeat builder supports selected months", notes: "Verify monthly/yearly rules can be limited to any selected months or all months.", priority: "normal" },
    { title: "Repeat builder supports skip-date exceptions", notes: "Add one or more excluded dates and confirm projected/next occurrences skip those dates without deleting the series.", priority: "normal" },
    { title: "Inbox keeps subtasks under their parent", notes: "Open Inbox with an unprojected parent hierarchy and confirm children and nested descendants remain directly below the parent with indentation.", priority: "normal" },
    { title: "Template creation uses task-list style editing", notes: "Create/edit a template and confirm it uses task-like rows, hierarchy indentation, quick add, selection, and a details editor rather than a simple parent/children form.", priority: "normal" },
    { title: "Use Template opens the new parent hierarchy", notes: "Click Use Template and confirm TaskMap navigates to Tasks focused on the newly created parent and all generated descendants.", priority: "normal" },
    { title: "Task Details can delete a task", notes: "Open Task Details and use Delete Task. Confirm deletion is soft/tombstoned and history is preserved.", priority: "normal" },
    { title: "Tasks supports multi-select delete", notes: "In Tasks enter Select mode, choose multiple tasks, delete them together, and confirm the selection clears.", priority: "normal" },
    { title: "Inbox Today and Completed support multi-select delete", notes: "Verify the same multi-task delete workflow works from Inbox, Today, and Completed.", priority: "normal" },
    { title: "Deleting a parent offers cascade or orphan children", notes: "Delete a parent and verify TaskMap lets you delete all descendants or delete only the parent and make direct children top-level.", priority: "normal" },
    { title: "Quick Add accepts comma-delimited tasks", notes: "Enter several task titles separated by commas and confirm they are created together in the current project/parent scope.", priority: "normal" },
    { title: "Template Quick Add accepts comma-delimited tasks", notes: "In the template task-list editor add multiple comma-separated items and confirm each becomes a template task.", priority: "normal" },
    { title: "Transaction History is collapsed by default", notes: "Open Task Details and confirm Transaction History starts minimized and expands only when requested.", priority: "normal" },
    { title: "Task Details fields can be reordered by dragging labels", notes: "Drag field labels such as Status and Priority to new positions and confirm the order changes with a clear drop target.", priority: "normal" },
    { title: "Task Details field layout persists in two columns", notes: "Reopen Task Details after rearranging fields and confirm the saved order returns; fields pair in two columns and an unpaired field spans both.", priority: "normal" },
    { title: "Expanded Notes supports rich HTML content", notes: "Use headings, bold/italic, lists, links, and pasted HTML in expanded Notes and confirm sanitized formatting persists.", priority: "normal" },
    { title: "Expanded Notes accepts pasted or dropped images", notes: "Paste or drag an image into expanded Notes and confirm it renders and persists with the task note.", priority: "normal" },
    // V8: newest asks and bug fixes stay urgent so they sort to the top for validation.
    { title: "Task cards show clickable Tag chips", notes: "Add one or more tags to a task. Confirm each tag appears beside Project/Parent as a clickable chip and clicking it filters Tasks to that tag.", priority: "normal" },
    { title: "Task Details Tag chips are clickable filters", notes: "Open a tagged task, click one of its Tag chips in Task Details, and confirm Tasks switches to a tag-focused view while keeping the selected task visible.", priority: "normal" },
    { title: "Task Details drag highlights exact destination", notes: "Drag a Task Details field by its label. Confirm a clear indigo drop target shows whether the field will become its own row or occupy the left/right column beside a single field.", priority: "normal" },
    { title: "Task Details rows do not auto-repack after a move", notes: "Move one field out of a two-field row. Confirm the remaining field expands across both columns and fields from the next row do not jump upward automatically.", priority: "normal" },

    // V9: newest asks and bug fixes stay urgent for focused validation.
    { title: "Bulk delete has Select All for the visible filtered tasks", notes: "Enter Select mode in Tasks, Today, Inbox, or Completed. Click Select all and confirm every currently visible task is selected without selecting hidden tasks outside the current filter/search.", priority: "normal" },
    { title: "Settings appears below Offline status", notes: "Confirm a Settings button appears in the lower-left sidebar directly below the offline/sync status area.", priority: "normal" },
    { title: "Settings About shows the current TaskMap version", notes: "Open Settings and confirm About displays the current TaskMap version from the shared app version source.", priority: "normal" },
    { title: "Every Task Details row supports field dragging", notes: "Drag fields from the first, middle, and lower rows by their labels. Confirm all fields can move and all destination rows accept drops.", priority: "normal" },
    { title: "Untitled Task Details actions can be reordered", notes: "Drag Show this task + all subtasks and Save task + subtasks as a template using their small handle icons. Confirm neither action needs a visible field title.", priority: "normal" },
    { title: "Tasks pane owns its scrollbar while Task Details is open", notes: "Open Task Details on a wide screen and scroll the Tasks list. Confirm the scrollbar is directly on the right edge of the Tasks pane rather than at the far-right edge of the window.", priority: "normal" },
    { title: "Recurring reopen does not duplicate future Calendar occurrences", notes: "Create a repeating task, complete it, reopen the completed occurrence, then navigate to future Calendar dates. Confirm each expected occurrence appears once with no duplicate React key warning.", priority: "normal" },
    { title: "Changing a parent Project asks about cascading to subtasks", notes: "Change a parent task's Project. Confirm TaskMap asks whether to change all descendants too; verify both parent-only and parent-plus-descendants paths.", priority: "normal" },
    { title: "Tag editor suggests existing tags and stays open", notes: "Focus Tags and confirm the top five existing tags are suggested. Type to filter, select several tags without closing the suggestion box, and create a new tag when no exact tag exists.", priority: "normal" },
    { title: "Main workspace keeps a clickable breadcrumb", notes: "Navigate across Tasks, project/parent/tag filters, Calendar, Templates, and Settings. Confirm a persistent breadcrumb appears at the top and earlier clickable segments navigate back appropriately.", priority: "normal" },

    // V10: prior drag fix is now stable.
    { title: "Task Details lower rows can initiate and receive field drags", notes: "Open Task Details, grab a field label from the third or later row, move it to another lower or upper row, refresh TaskMap, and confirm the moved layout persists. Repeat with an untitled action handle.", priority: "normal" },

    // V11: current asks and bug fixes stay urgent for focused validation.
    { title: "Project cascade prompt uses the hierarchy decision modal", notes: "Change the Project on a parent from Task Details and by dropping it onto a sidebar project. Confirm both paths use the same styled decision modal as parent deletion, with parent-only, parent-plus-subtasks, and Cancel choices.", priority: "normal" },
    { title: "Recurring completion lingers and protects the next checkbox", notes: "Complete a recurring task from the list. Confirm the completed occurrence stays visible for about one second with its next-occurrence message, then the next task shows a Next occurrence badge and its checkbox is briefly protected from rapid/double clicks.", priority: "normal" },
    { title: "Calendar warns when a scheduled task has no real duration", notes: "Drag an unscheduled task with no estimated duration onto Calendar. Confirm the block shows a warning icon and explains that the displayed length is a placeholder. Resize it to set a duration and confirm the warning disappears.", priority: "normal" },

    // V12: Task Details editing regression fix is the newest urgent validation target.
    { title: "Task Details fields remain editable after drag-layout changes", notes: "Open Task Details, rearrange a field from a lower row, then edit Status, Priority, Project, Parent, Duration, dates/times, Tags, Repeat, and Notes. Confirm only the field label/drag handle starts a drag and every editor remains clickable and editable.", priority: "normal" },

    // V13: replace native HTML drag with pointer-driven field reordering.
    { title: "Task Details pointer drag works from every row", notes: "Open Task Details and drag a field from the third or later row by its title/handle. Confirm the field immediately gets the dragging-field class, destination highlights follow the pointer across upper/lower rows, dropping moves the field, inputs remain editable, and the layout persists after refresh.", priority: "normal" },


    // V14: weekly Calendar and browser/PWA identity are the newest validation targets.
    { title: "Calendar switches between Day and Week views", notes: "Open Calendar, switch to Week, and confirm previous/next navigation moves one week at a time. Click a day header and confirm it opens that date in Day view.", priority: "normal" },
    { title: "Calendar supports 5-day and 7-day weeks with a shared unscheduled strip", notes: "In Week view toggle between 5 days and 7 days. Confirm unscheduled tasks span the shared Week Tasks strip across the top, can be dragged into any visible day/time, scheduled blocks can move across day columns, and dragging a block back to Week Tasks unschedules it.", priority: "normal" },
    { title: "Browser tab uses the TaskMap sidebar logo", notes: "Open or refresh TaskMap in Chrome and confirm the tab favicon matches the indigo GitBranch logo shown in the upper-left TaskMap brand. Also confirm the PWA manifest references the same icon.", priority: "normal" },
    { title: "Today Completed filter and counters exclude completed work", notes: "Open Today and confirm a Completed filter appears next to Urgent. Scheduled, Unscheduled, and Urgent counts must exclude completed tasks. Completed must count and show only tasks whose completed timestamp is today, including tasks completed today that are no longer otherwise due/scheduled/urgent today.", priority: "normal" },

    // V15: redesigned visual planning and restored task-row drag interactions.
    { title: "Mind Map auto-arranges parent child hierarchy", notes: "Open Mind Map after upgrading and confirm the canvas starts in a clean parent-to-child tree. Move nodes manually, then click Auto Arrange and confirm the hierarchy is laid out cleanly again.", priority: "normal" },
    { title: "Mind Map switches horizontal and vertical planning layouts", notes: "Change Layout between Left to right and Top to bottom. Click Auto Arrange in each mode and confirm hierarchy direction and handles match the selected orientation.", priority: "normal" },
    { title: "Mind Map branches can collapse and expand", notes: "Use the child-count control on a parent node. Confirm all nested descendants hide when collapsed and return when expanded without changing the underlying parent relationships.", priority: "normal" },
    { title: "Mind Map planning cards show useful task context", notes: "Confirm map nodes show title plus useful context such as priority, project, due date, recurrence, tags, completion state, and child count without looking like miniature task-list rows.", priority: "normal" },
    { title: "Mind Map available tasks can drop directly onto a parent node", notes: "Use Project or Parent scope, drag a task from Available tasks directly onto a node, and confirm it becomes that node's child and inherits the target project when appropriate.", priority: "normal" },
    { title: "Mind Map completed tasks can dim show or hide", notes: "Change the Completed control between Dim, Show normally, and Hide. Confirm the canvas updates without deleting or changing completion data.", priority: "normal" },
    { title: "Task row drag handle restores reorder and nesting", notes: "Set Tasks sort to Manual. Drag a task by the dedicated handle between rows and confirm the insertion line appears and order persists. Then drag the task onto the center of another task and confirm it becomes a subtask. Also verify the same handle can still drop the task onto a sidebar project.", priority: "normal" },


    // v1.1: mobile/responsive release validation targets. v15.1 is the v1.0 product baseline.
    { title: "Mobile bottom navigation replaces the desktop sidebar", notes: "Open TaskMap at phone width. Confirm the desktop sidebar is hidden and the fixed bottom navigation shows Today, Tasks, Quick Add, Calendar, and More with safe-area spacing.", priority: "normal" },
    { title: "Mobile More menu exposes secondary navigation and projects", notes: "Tap More on a phone. Confirm Inbox, Home, Map, Completed, Templates, Settings, Ask TaskMap, project shortcuts, and sync/offline status are accessible without the desktop sidebar.", priority: "normal" },
    { title: "Mobile Quick Add creates one or many tasks", notes: "Tap the center + button from multiple views. Confirm the Quick Add sheet opens without changing views, supports comma-delimited task creation, respects the current parent/project context, and closes after creation.", priority: "normal" },
    { title: "Task Details becomes a full-screen mobile editor", notes: "Open a task on a phone. Confirm Task Details uses the full screen, all fields remain editable, field drag handles remain touchable, Notes/tag/repeat controls fit without horizontal clipping, and closing returns to the previous view.", priority: "normal" },
    { title: "Touch task drag can reorder and create subtasks", notes: "On a touch device use the task row drag handle. In Manual sort drag between rows and confirm the insertion line/reorder. Drag onto the center of another task and confirm it becomes a subtask without needing native HTML drag events.", priority: "normal" },
    { title: "Mobile Calendar day view is touch friendly", notes: "Open Calendar on a phone. Confirm Day view is readable, time labels and task blocks fit the screen, scheduled blocks can be moved/resized by touch, and dragging a scheduled block into Day Tasks unschedules it.", priority: "normal" },
    { title: "Mobile Calendar schedules unscheduled tasks by touch", notes: "Use the grip on an unscheduled Day/Week Task and drag it onto the timeline. Confirm the target highlights and the task receives the selected day/time. Verify tasks without duration retain the placeholder-duration warning.", priority: "normal" },
    { title: "Mobile weekly Calendar scrolls instead of compressing", notes: "Switch Calendar to 5-day and 7-day Week views on a phone. Confirm the shared Week Tasks strip remains usable and the week timeline scrolls horizontally with readable day columns.", priority: "normal" },
    { title: "TaskMap PWA respects mobile safe areas and standalone layout", notes: "Install/open TaskMap as a PWA or emulate standalone display. Confirm the bottom nav, full-screen Task Details, sheets, and app content avoid device notches/home indicators and the TaskMap icon/manifest remain correct.", priority: "normal" },

    // v1.1.1: mobile bug-fix / recovery / Quick Add release. Only these new checks are urgent.
    { title: "Mobile task pills filter without opening Task Details", notes: "On a phone tap Parent, Project, and Tag pills on task cards. Confirm each changes only the corresponding filter and does not open Task Details.", priority: "normal" },
    { title: "Deleted tasks stay deleted after refresh", notes: "Delete a normal task and a QA checklist task, refresh/restart TaskMap, and confirm neither is recreated or returned to active views.", priority: "normal" },
    { title: "Settings Trash restores and permanently deletes tasks", notes: "Delete tasks, open Settings → Trash, restore one task, restore a hierarchy, bulk restore selected tasks, and permanently delete a task. Confirm permanently deleted tasks disappear from Trash.", priority: "normal" },
    { title: "Mobile More can create a new project", notes: "On a phone open More → Projects, create a new project, and confirm TaskMap opens the new project and it is immediately available to tasks.", priority: "normal" },
    { title: "Quick Add creates inline parent child hierarchies", notes: "Create `Cheese Types > Swiss, Parm, Cheddar` and confirm one parent with three sibling children. Then create `Cheese Types > Swiss > Parmesan > Cheddar` and confirm a four-level chain.", priority: "normal" },
    { title: "Quick Add can move back up hierarchy levels", notes: "Create `Dinner > Main > Steak << Dessert > Cake, Ice Cream` and confirm Main/Steak and Dessert/Cake/Ice Cream form the intended sibling branches. Verify < moves up one level and << moves up two.", priority: "normal" },
    { title: "Template Quick Add keeps current focus", notes: "While editing a template, select an existing template task and add one or more new tasks. Confirm the new tasks are created under the current context without automatically focusing the newly created row.", priority: "normal" },

    // v1.2 account-sync checks are retained as historical QA, but v1.3 replaces account sync with Sync Workspaces.
    { title: "Online Sync account signs in without disabling local mode", notes: "Historical v1.2 account-sync check. v1.3 replaces this flow with opt-in Sync Workspaces.", priority: "normal" },
    { title: "First cloud sync uploads current local TaskMap", notes: "Historical v1.2 account-sync check. Validate equivalent behavior through a newly created Sync Workspace in v1.3.", priority: "normal" },
    { title: "Second device pulls cloud state without duplicating QA", notes: "Historical v1.2 account-sync check. Validate equivalent behavior by joining the same Sync Key in v1.3.", priority: "normal" },
    { title: "Offline edits sync after reconnect", notes: "Disconnect a synced workspace, edit several fields, reconnect, and confirm queued changes upload.", priority: "normal" },
    { title: "Concurrent field edits merge independently", notes: "With two devices offline in the same workspace, change different fields and then the same field; confirm per-field merge semantics remain correct.", priority: "normal" },
    { title: "Cloud Realtime pulls changes from another device", notes: "Historical wording. v1.3 uses foreground/interval sync rather than authenticated Realtime subscriptions; confirm changes arrive automatically within the sync interval.", priority: "normal" },
    { title: "Cloud sync preserves transaction history", notes: "Make edits on device A, sync, then open the same task history on device B and confirm synced transactions are present.", priority: "normal" },
    { title: "Quick Add less-than operators move up real levels", notes: "Create `Dinner > Main > Steak < Dessert` and confirm Dessert is a sibling of Main. Create `Dinner > Main > Steak << Grocery Shopping` and confirm Grocery Shopping is a top-level sibling of Dinner. Commas remain same-level siblings.", priority: "normal" },

    // v1.3 Sync Workspace checks are retained as Normal in v1.4.
    { title: "Cloud Sync remains off until a Sync Workspace is created", notes: "Fresh/local-only TaskMap should not create cloud credentials automatically. Open Settings → Online Sync and confirm Local Only remains active until Create Sync Workspace or Connect Existing Key is explicitly used.", priority: "normal" },
    { title: "Create a named Sync Workspace from current TaskMap", notes: "Create a workspace such as Personal and choose Use current TaskMap data. Confirm a TM1 Sync Key is shown once, the workspace becomes active, and the current tasks upload without changing the Local Only database.", priority: "normal" },
    { title: "Create an empty named Sync Workspace", notes: "Create a workspace such as Work and choose Start empty. Confirm it receives an isolated local database and does not inherit Personal/Local Only tasks except development QA created in that workspace.", priority: "normal" },
    { title: "Connect an existing Sync Key on another device", notes: "Paste the same TM1 Sync Key on another browser/device. Confirm the workspace name is discovered, data pulls into an isolated IndexedDB database, and no traditional account is required.", priority: "normal" },
    { title: "Switch between Local Only and multiple Sync Workspaces", notes: "Create/connect at least Personal and Work. Switch among Local Only, Personal, and Work and confirm each reloads its own task/project/template data with no cross-workspace bleed.", priority: "normal" },
    { title: "Workspace sync merges offline edits by original field timestamp", notes: "With two devices in one Sync Workspace offline, edit different fields and then the same field. Reconnect and confirm independent fields merge and the later original client edit wins for a conflict.", priority: "normal" },
    { title: "Optional recovery email can be added and verified", notes: "Add a recovery email to an owner workspace. Confirm it is shown as unverified until the Supabase recovery link is completed, then the workspace shows a verified recovery-email hint.", priority: "normal" },
    { title: "Recovery email can generate a replacement Sync Key", notes: "Use Recover Workspace with a verified recovery email, select the matching workspace, generate a new Sync Key, connect it, and confirm existing workspace data is accessible without the lost key.", priority: "normal" },
    { title: "Rotate a Sync Key without storing plaintext server-side", notes: "Rotate the active owner key. Confirm the old key stops connecting, the new key works, and Supabase stores only a key hash rather than the plaintext TM1 key.", priority: "normal" },


    // v1.4 External API checks are retained as Normal in v1.5.
    { title: "Joining an existing Sync Key is pull-only on first sync", notes: "On a device that already has unrelated Local Only tasks, connect an existing TM1 Sync Key and open that workspace. Confirm the newly created workspace database starts from the cloud snapshot only, Local Only remains untouched, and none of the device's pre-existing local tasks are uploaded into the established cloud workspace.", priority: "normal" },
    { title: "External API stays unavailable for Local Only data", notes: "Open Settings while Local Only is active. Confirm External API explains that a cloud Sync Workspace is required and does not generate an API key automatically.", priority: "normal" },
    { title: "Create named read-only and read-write API keys", notes: "In a cloud workspace, create one read-only key and one key with Allow changes enabled. Confirm each key has a human-friendly name, the TMAPI1 secret is shown only when created, and the saved key list never reveals the secret again.", priority: "normal" },
    { title: "External API lists and searches workspace tasks", notes: "Use POST /api/taskmap with a read-only API key and action=list_tasks. Confirm filters such as query, status, priority, projectName, tag, limit, and offset return only the active cloud workspace data.", priority: "normal" },
    { title: "Read-only API key rejects write actions", notes: "Call create_task or update_task with a read-only API key. Confirm the API returns 403 and no TaskMap transaction or task change is created.", priority: "normal" },
    { title: "Read-write API creates and updates tasks through transaction history", notes: "Use create_task then update_task with a read-write API key. Confirm the task appears after workspace sync on another device and Task Details history contains API_TASK_CREATED / API_TASK_UPDATED transactions.", priority: "normal" },
    { title: "API completion and reopen preserve hierarchy semantics", notes: "Complete a parent through the API and confirm incomplete descendants are completed with the parent marker. Reopen the parent and confirm only descendants auto-completed by that action reopen. Also confirm a recurring task advances exactly once to its next occurrence.", priority: "normal" },
    { title: "API delete supports orphan and cascade modes plus restore", notes: "Delete a parent once with childMode=orphan and confirm children become top-level; restore it. Then delete with childMode=cascade and confirm descendants move to Trash. Use restore_task to restore a soft-deleted task.", priority: "normal" },
    { title: "Revoking one API key immediately blocks only that integration", notes: "Create two named API keys, use both, then revoke one. Confirm the revoked key returns 401 while the other API key and the workspace Sync Key continue working.", priority: "normal" },
    { title: "External API exposes a callable OpenAPI description", notes: "Open /api/taskmap?openapi=1 and confirm an OpenAPI 3.1 document describes the callTaskMap POST operation, Bearer TMAPI1 authentication, and supported actions for chatbot/agent integration.", priority: "normal" },
    { title: "Vercel API proxy forwards TaskMap API calls", notes: "From an outside client call the deployed TaskMap domain at /api/taskmap instead of the Supabase URL. Confirm GET metadata and authenticated POST actions proxy successfully with CORS enabled.", priority: "normal" },

    // v1.5 REST GPT Actions + project management checks are retained as Normal in v1.6.
    { title: "Project can be renamed from its project view", notes: "Open a project, click Rename project, enter a new name, and confirm the sidebar, breadcrumb, task chips, and synced devices reflect the new name without changing task assignments.", priority: "normal" },
    { title: "Project delete modal offers keep-tasks or cascade choices", notes: "Open a project and click Delete project. Confirm the modal matches the parent-delete pattern and clearly offers Delete project only (keep tasks) or Delete project + all tasks/descendants.", priority: "normal" },
    { title: "Deleting project only keeps tasks and hierarchy", notes: "Delete a temporary project using Delete project only. Confirm all tasks previously assigned to it remain active, become unassigned/Inbox eligible, and parent-child hierarchy remains intact.", priority: "normal" },
    { title: "Deleting project with tasks cascades through nested descendants", notes: "Create a project with nested tasks, including at least one descendant assigned to another project. Choose Delete project + all tasks/descendants and confirm every assigned task and nested descendant is soft-deleted into Trash; the modal warns about cross-project descendants first.", priority: "normal" },
    { title: "Project rename and delete sync across devices", notes: "Rename a cloud project on device A and sync device B. Then delete a temporary project with keep-tasks mode and confirm device B receives the project deletion and detached tasks through normal transaction sync.", priority: "normal" },
    { title: "REST API exposes separate GPT Actions", notes: "Open /api/taskmap/openapi.json and confirm distinct operationIds exist for getWorkspaceInfo, searchTasks, createTask, getTask, updateTask, deleteTask, completeTask, reopenTask, restoreTask, listProjects, createProject, updateProject, and deleteProject.", priority: "normal" },
    { title: "REST task endpoints remain compatible with legacy API", notes: "Create/search/update/complete/reopen/delete/restore tasks through the REST endpoints and confirm the same workspace entities and API_* transaction history appear as when using legacy POST /api/taskmap.", priority: "normal" },
    { title: "REST project endpoints create rename and delete projects", notes: "Use GET/POST /api/taskmap/projects and PATCH/DELETE /api/taskmap/projects/{projectId}. Verify PATCH renames/recolors and DELETE supports taskMode=detach and taskMode=cascade.", priority: "normal" },
    { title: "Legacy POST /api/taskmap remains backward compatible", notes: "Call the existing POST /api/taskmap with action=list_tasks and action=create_task and confirm integrations built for v1.4 continue working after the REST API is added.", priority: "normal" },
    { title: "GPT Actions OpenAPI imports without schema warnings", notes: "Import /api/taskmap/openapi.json into Custom GPT Actions. Confirm OpenAPI 3.1 is accepted and each REST operation appears as an individual callable action rather than one generic POST tool.", priority: "normal" },


    // v1.6: Kanban replaces rule-based views + collapsible hierarchy. Only these new checks are Urgent.
    { title: "Kanban replaces the old Rule-based Views section", notes: "Open Tasks and confirm the old Rule-based Views / Task categories section is gone. Confirm Kanban appears as its own left-sidebar navigation item and opens the same task scope/filter model as Tasks.", priority: "urgent" },
    { title: "Kanban breakout selector supports Status Priority Project and dates", notes: "Open Kanban and switch Breakout among Status, Priority, Project, Start date, and Due date. Confirm each distinct value becomes a column, including Done, all four priorities, No project plus named projects, and No date plus each date currently represented in the filtered task set.", priority: "urgent" },
    { title: "Dragging between Status columns changes real task status", notes: "Drag a task from Not started to In progress and Blocked and confirm the field updates. Drag it to Done and confirm normal completion rules run; drag a completed non-recurring task back to an open status and confirm it reopens rather than merely changing display lanes.", priority: "urgent" },
    { title: "Kanban Done drag preserves recurrence and completion cascade", notes: "Drag a recurring task to Done and confirm exactly one next occurrence advances. Drag a parent with unfinished descendants to Done and confirm TaskMap's normal parent completion cascade still applies.", priority: "urgent" },
    { title: "Dragging between breakout columns changes the real field", notes: "Break out by Priority and move cards between columns; confirm priority changes. Break out by Project and move a task to another project or No project; for a parent with descendants confirm the normal parent-only vs parent+subtasks project-change dialog still appears. Break out by Start date or Due date and move cards between existing date/No date lanes; confirm the corresponding date field updates, and clearing a date also clears its associated time.", priority: "urgent" },
    { title: "Kanban keeps normal task-to-task nesting and manual reorder drag rules", notes: "In Manual sort, drag a card before/after another card in a lane and confirm manual order changes. Drop directly on another task and confirm it becomes a subtask. In a non-Manual sort, direct task drops should nest but before/after reorder should not run.", priority: "urgent" },
    { title: "Parent rows can collapse and expand descendants", notes: "In Tasks, Today, Inbox, Completed, and Kanban where hierarchy is visible, confirm parent rows show a chevron. Collapse a parent and confirm all nested descendants disappear; expand it and confirm the same hierarchy returns without changing task data.", priority: "urgent" },
    { title: "Expand all and Hide all control the visible hierarchy", notes: "Use Hide all at the top of a task view and confirm every visible parent hierarchy is minimized. Use Expand all and confirm all parents in the current filtered scope reopen. Hidden/filtered tasks outside the current scope should not be altered.", priority: "urgent" },
    { title: "Collapsed parents hide descendants across different Kanban columns", notes: "Break out by Status or Priority, give a parent and child different breakout values, then collapse the parent. Confirm the descendant is hidden even though it would otherwise render in another column; expanding restores it to its own column.", priority: "urgent" },
    { title: "Reorder up and down arrows are removed everywhere", notes: "Check desktop and mobile task lists plus Kanban. Confirm the old up/down reorder arrow buttons no longer appear. Manual ordering must still work through the dedicated drag handle.", priority: "urgent" },
    { title: "Project-delete null transaction change passes production TypeScript", notes: "Deploy v1.6 to Vercel and confirm lib/task-service.ts no longer fails on projectId newValue:null. The project-delete change array should be typed as TransactionChange[] and production typecheck should continue past the previous v1.5 error.", priority: "urgent" },
    { title: "Kanban remains usable on mobile", notes: "Open Kanban on a phone-size viewport. Confirm columns scroll horizontally, cards remain selectable, touch drag can move a task to a different lane or onto another task, and hierarchy expand/collapse controls remain tappable.", priority: "urgent" },
  ];

  // Seed atomically. V5 preserves existing QA progress and only adds checklist entries that do not already exist.
  await db.transaction("rw", db.tasks, db.projects, db.transactions, db.transactionChanges, async () => {
    const now = nowIso();
    const deviceId = getDeviceId();
    let qa = await db.projects.where("name").equals("TaskMap QA Checklist").first();
    if (!qa) {
      qa = { id: crypto.randomUUID(), name: "TaskMap QA Checklist", color: "#5B5BD6", createdAt: now, updatedAt: now };
      const projectTxId = crypto.randomUUID();
      await db.projects.add(qa);
      await db.transactions.add({ id: projectTxId, entityType: "project", entityId: qa.id, actionType: "PROJECT_CREATED", deviceId, clientTimestamp: now, serverReceivedTimestamp: null, baseRevision: 0, resultRevision: 1, syncStatus: "pending" });
      await db.transactionChanges.add({ id: crypto.randomUUID(), transactionId: projectTxId, fieldName: "__entity__", oldValue: null, newValue: qa });
    }

    const existingQaAll = await db.tasks.where("projectId").equals(qa!.id).toArray();
    const obsoleteQaTitles = new Set([
      "Create a custom task category",
      "Create a multi-condition category rule",
      "Validate an invalid category rule",
      "Delete a custom task category",
    ]);
    const obsoleteQaTasks = existingQaAll.filter(task => !task.deletedAt && obsoleteQaTitles.has(task.title));
    for (const task of obsoleteQaTasks) {
      const retiredAt = nowIso();
      const txId = crypto.randomUUID();
      await db.tasks.update(task.id, { deletedAt: retiredAt, updatedAt: retiredAt, revision: task.revision + 1 });
      await db.transactions.add({ id: txId, entityType: "task", entityId: task.id, actionType: "QA_CHECK_RETIRED", deviceId, clientTimestamp: retiredAt, serverReceivedTimestamp: null, baseRevision: task.revision, resultRevision: task.revision + 1, syncStatus: "pending" });
      await db.transactionChanges.bulkAdd([
        { id: crypto.randomUUID(), transactionId: txId, fieldName: "deletedAt", oldValue: task.deletedAt, newValue: retiredAt },
        { id: crypto.randomUUID(), transactionId: txId, fieldName: "updatedAt", oldValue: task.updatedAt, newValue: retiredAt },
        { id: crypto.randomUUID(), transactionId: txId, fieldName: "revision", oldValue: task.revision, newValue: task.revision + 1 },
      ]);
    }
    const existingQaTasks = existingQaAll.filter(task => !task.deletedAt && !obsoleteQaTitles.has(task.title));
    const desiredPriority = new Map(checklist.map(item => [item.title, item.priority ?? "normal"] as const));
    const priorityUpdates = existingQaTasks.filter(task => desiredPriority.has(task.title) && task.priority !== desiredPriority.get(task.title));
    if (priorityUpdates.length) {
      const priorityNow = nowIso();
      await db.tasks.bulkPut(priorityUpdates.map(task => ({ ...task, priority: desiredPriority.get(task.title)!, updatedAt: priorityNow, revision: task.revision + 1 })));
    }
    // Deleted QA tasks intentionally remain deleted. A tombstoned checklist row must not be re-seeded on refresh.
    const existingTitles = new Set(existingQaAll.map(task => task.title));
    const missing = checklist.filter(item => !existingTitles.has(item.title));
    if (!missing.length) return;
    const currentLast = await db.tasks.orderBy("manualOrder").last();
    const baseOrder = currentLast?.manualOrder ?? 0;
    const seededTasks: Task[] = missing.map((item, index) => ({
      id: crypto.randomUUID(),
      title: item.title.trim(),
      notes: item.notes ?? "",
      tags: item.tags ?? [],
      status: item.status ?? "not_started",
      priority: item.priority ?? "normal",
      projectId: qa!.id,
      parentTaskId: item.parentTaskId ?? null,
      autoCompletedByParentId: item.autoCompletedByParentId ?? null,
      startDate: item.startDate ?? null,
      startTime: item.startTime ?? null,
      estimatedMinutes: item.estimatedMinutes ?? null,
      dueDate: item.dueDate ?? null,
      dueTime: item.dueTime ?? null,
      manualOrder: baseOrder + (index + 1) * 1000,
      createdAt: now, updatedAt: now, completedAt: null, deletedAt: null, purgedAt: null, revision: 1,
      recurrence: item.recurrence ?? null, recurrenceSeriesId: item.recurrenceSeriesId ?? null, recurrenceOccurrence: item.recurrenceOccurrence ?? null,
    }));

    // If the hierarchy QA rows are being created for the first time, connect them immediately.
    const allForHierarchy = [...await db.tasks.toArray(), ...seededTasks];
    const hierarchyParent = allForHierarchy.find(task => task.title === "Parent Task field assigns hierarchy");
    if (hierarchyParent) {
      for (const childTitle of ["Parent task link opens the parent", "Subtasks render indented under their parent", "Project and Parent tags are clickable"]) {
        const child = seededTasks.find(task => task.title === childTitle);
        if (child) child.parentTaskId = hierarchyParent.id;
      }
    }

    const taskTransactions = seededTasks.map(task => ({
      id: crypto.randomUUID(), entityType: "task" as const, entityId: task.id, actionType: "TASK_CREATED", deviceId, clientTimestamp: now, serverReceivedTimestamp: null, baseRevision: 0, resultRevision: 1, syncStatus: "pending" as const,
    }));
    await db.tasks.bulkAdd(seededTasks);
    await db.transactions.bulkAdd(taskTransactions);
    await db.transactionChanges.bulkAdd(taskTransactions.map((tx, index) => ({ id: crypto.randomUUID(), transactionId: tx.id, fieldName: "__entity__", oldValue: null, newValue: seededTasks[index] })));
  });
}
