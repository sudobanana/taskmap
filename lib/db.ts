import Dexie, { type EntityTable } from "dexie";
import type { DevBacklogItem, Project, Task, TaskCategory, TaskLayout, TaskTemplate, Transaction, TransactionChange } from "./types";
import { workspaceDatabaseName } from "./workspace-storage";

export class TaskMapDB extends Dexie {
  tasks!: EntityTable<Task, "id">;
  projects!: EntityTable<Project, "id">;
  taskCategories!: EntityTable<TaskCategory, "id">;
  taskLayouts!: EntityTable<TaskLayout, "taskId">;
  transactions!: EntityTable<Transaction, "id">;
  transactionChanges!: EntityTable<TransactionChange, "id">;
  devBacklog!: EntityTable<DevBacklogItem, "id">;
  taskTemplates!: EntityTable<TaskTemplate, "id">;

  constructor(databaseName = workspaceDatabaseName()) {
    super(databaseName);
    this.version(1).stores({
      tasks: "id, projectId, parentTaskId, startDate, dueDate, priority, status, updatedAt, deletedAt",
      taskLayouts: "taskId, updatedAt",
      transactions: "id, entityId, entityType, clientTimestamp, syncStatus",
      transactionChanges: "id, transactionId, fieldName",
    });

    this.version(2)
      .stores({
        tasks: "id, projectId, parentTaskId, startDate, dueDate, priority, status, manualOrder, updatedAt, deletedAt",
        projects: "id, name, updatedAt",
        taskCategories: "id, name, updatedAt",
        taskLayouts: "taskId, updatedAt",
        transactions: "id, entityId, entityType, clientTimestamp, syncStatus",
        transactionChanges: "id, transactionId, fieldName",
      })
      .upgrade(async tx => {
        const table = tx.table("tasks");
        const existing = await table.toArray();
        const sorted = existing.sort((a: Task, b: Task) => String(a.createdAt).localeCompare(String(b.createdAt)));
        for (let index = 0; index < sorted.length; index += 1) {
          const task = sorted[index] as Task;
          if (typeof task.manualOrder !== "number") await table.update(task.id, { manualOrder: (index + 1) * 1000 });
        }
      });

    this.version(3)
      .stores({
        tasks: "id, projectId, parentTaskId, startDate, dueDate, priority, status, manualOrder, createdAt, updatedAt, deletedAt",
        projects: "id, name, createdAt, updatedAt",
        taskCategories: "id, name, createdAt, updatedAt",
        taskLayouts: "taskId, updatedAt",
        transactions: "id, entityId, entityType, clientTimestamp, syncStatus",
        transactionChanges: "id, transactionId, fieldName",
      })
      .upgrade(async tx => {
        await tx.table("transactionChanges").clear();
        await tx.table("transactions").clear();
        await tx.table("taskLayouts").clear();
        await tx.table("taskCategories").clear();
        await tx.table("tasks").clear();
        await tx.table("projects").clear();
      });

    this.version(4)
      .stores({
        tasks: "id, projectId, parentTaskId, startDate, dueDate, priority, status, manualOrder, createdAt, updatedAt, deletedAt",
        projects: "id, name, createdAt, updatedAt",
        taskCategories: "id, name, createdAt, updatedAt",
        taskLayouts: "taskId, updatedAt",
        transactions: "id, entityId, entityType, clientTimestamp, syncStatus",
        transactionChanges: "id, transactionId, fieldName",
      })
      .upgrade(async tx => {
        await tx.table("transactionChanges").clear();
        await tx.table("transactions").clear();
        await tx.table("taskLayouts").clear();
        await tx.table("taskCategories").clear();
        await tx.table("tasks").clear();
        await tx.table("projects").clear();
      });

    // V5 preserves existing QA progress. It adds the hidden development backlog and
    // backfills new non-indexed task fields without clearing tasks or history.
    this.version(5)
      .stores({
        tasks: "id, projectId, parentTaskId, startDate, dueDate, priority, status, manualOrder, createdAt, updatedAt, deletedAt",
        projects: "id, name, createdAt, updatedAt",
        taskCategories: "id, name, createdAt, updatedAt",
        taskLayouts: "taskId, updatedAt",
        transactions: "id, entityId, entityType, clientTimestamp, syncStatus",
        transactionChanges: "id, transactionId, fieldName",
        devBacklog: "id, kind, status, createdAt, updatedAt",
      })
      .upgrade(async tx => {
        const table = tx.table("tasks");
        const existing = await table.toArray();
        for (const task of existing as Task[]) {
          const patch: Partial<Task> = {};
          if (!Array.isArray(task.tags)) patch.tags = [];
          if (typeof task.autoCompletedByParentId === "undefined") patch.autoCompletedByParentId = null;
          if (Object.keys(patch).length) await table.update(task.id, patch);
        }
      });

    // V6 adds reusable task templates and recurrence metadata while preserving QA progress.
    this.version(6)
      .stores({
        tasks: "id, projectId, parentTaskId, startDate, dueDate, priority, status, manualOrder, createdAt, updatedAt, deletedAt, recurrenceSeriesId",
        projects: "id, name, createdAt, updatedAt",
        taskCategories: "id, name, createdAt, updatedAt",
        taskLayouts: "taskId, updatedAt",
        transactions: "id, entityId, entityType, clientTimestamp, syncStatus",
        transactionChanges: "id, transactionId, fieldName",
        devBacklog: "id, kind, status, createdAt, updatedAt",
        taskTemplates: "id, name, createdAt, updatedAt",
      })
      .upgrade(async tx => {
        const table = tx.table("tasks");
        const existing = await table.toArray();
        for (const task of existing as Task[]) {
          const patch: Partial<Task> = {};
          if (typeof task.recurrence === "undefined") patch.recurrence = null;
          if (typeof task.recurrenceSeriesId === "undefined") patch.recurrenceSeriesId = null;
          if (typeof task.recurrenceOccurrence === "undefined") patch.recurrenceOccurrence = null;
          if (["Today Urgent counter filters tasks", "Calendar shows urgent unscheduled tasks at the top"].includes(task.title)) patch.priority = "normal";
          if (Object.keys(patch).length) await table.update(task.id, patch);
        }
      });

    // V7 expands recurrence/template metadata without clearing QA progress.
    // It also demotes the previous rebuild's urgent QA rows so only new asks remain urgent.
    this.version(7)
      .stores({
        tasks: "id, projectId, parentTaskId, startDate, dueDate, priority, status, manualOrder, createdAt, updatedAt, deletedAt, recurrenceSeriesId",
        projects: "id, name, createdAt, updatedAt",
        taskCategories: "id, name, createdAt, updatedAt",
        taskLayouts: "taskId, updatedAt",
        transactions: "id, entityId, entityType, clientTimestamp, syncStatus",
        transactionChanges: "id, transactionId, fieldName",
        devBacklog: "id, kind, status, createdAt, updatedAt",
        taskTemplates: "id, name, createdAt, updatedAt",
      })
      .upgrade(async tx => {
        const table = tx.table("tasks");
        const previousUrgentTitles = new Set([
          "Templates appears in the left menu",
          "Create a parent + children task template",
          "Use Template creates the full task hierarchy",
          "Save existing task hierarchy as a template",
          "Make a task repeat every X minutes or hours",
          "Make a task repeat by day/week/month/year",
          "Recurring task supports count, until date, or forever",
          "Recurring completion hides old active occurrence",
          "Recurring history keeps completed occurrences",
          "Calendar projects future recurring occurrences virtually",
          "Task Details panel is larger on wide screens",
          "Notes can expand into a full-note window",
          "Parent link in Task Details focuses parent hierarchy",
          "Ask TaskMap environment setup is documented",
        ]);
        for (const task of await table.toArray() as Task[]) {
          const patch: Partial<Task> = {};
          if (previousUrgentTitles.has(task.title)) patch.priority = "normal";
          if (task.recurrence?.enabled) {
            patch.recurrence = {
              ...task.recurrence,
              specialMonthly: task.recurrence.specialMonthly ?? null,
              excludedDates: task.recurrence.excludedDates ?? [],
            };
          }
          if (Object.keys(patch).length) await table.update(task.id, patch);
        }
      });

    // V8 preserves QA progress while making only this rebuild's new checks urgent.
    this.version(8)
      .stores({
        tasks: "id, projectId, parentTaskId, startDate, dueDate, priority, status, manualOrder, createdAt, updatedAt, deletedAt, recurrenceSeriesId",
        projects: "id, name, createdAt, updatedAt",
        taskCategories: "id, name, createdAt, updatedAt",
        taskLayouts: "taskId, updatedAt",
        transactions: "id, entityId, entityType, clientTimestamp, syncStatus",
        transactionChanges: "id, transactionId, fieldName",
        devBacklog: "id, kind, status, createdAt, updatedAt",
        taskTemplates: "id, name, createdAt, updatedAt",
      })
      .upgrade(async tx => {
        const taskTable = tx.table("tasks");
        const projectTable = tx.table("projects");
        const qaProject = (await projectTable.toArray() as Project[]).find(project => project.name === "TaskMap QA Checklist");
        if (!qaProject) return;
        for (const task of await taskTable.toArray() as Task[]) {
          if (task.projectId === qaProject.id && task.priority === "urgent") await taskTable.update(task.id, { priority: "normal" });
        }
      });

    // V9 preserves QA progress and demotes the previous rebuild's urgent checks.
    this.version(9)
      .stores({
        tasks: "id, projectId, parentTaskId, startDate, dueDate, priority, status, manualOrder, createdAt, updatedAt, deletedAt, recurrenceSeriesId",
        projects: "id, name, createdAt, updatedAt",
        taskCategories: "id, name, createdAt, updatedAt",
        taskLayouts: "taskId, updatedAt",
        transactions: "id, entityId, entityType, clientTimestamp, syncStatus",
        transactionChanges: "id, transactionId, fieldName",
        devBacklog: "id, kind, status, createdAt, updatedAt",
        taskTemplates: "id, name, createdAt, updatedAt",
      })
      .upgrade(async tx => {
        const taskTable = tx.table("tasks");
        const projectTable = tx.table("projects");
        const qaProject = (await projectTable.toArray() as Project[]).find(project => project.name === "TaskMap QA Checklist");
        if (!qaProject) return;
        for (const task of await taskTable.toArray() as Task[]) {
          if (task.projectId === qaProject.id && task.priority === "urgent") await taskTable.update(task.id, { priority: "normal" });
        }
      });

    // V10 resets only Mind Map visual layout so the redesigned planning canvas opens cleanly.
    // Tasks, projects, QA completion progress, recurrence history, and transactions are preserved.
    this.version(10)
      .stores({
        tasks: "id, projectId, parentTaskId, startDate, dueDate, priority, status, manualOrder, createdAt, updatedAt, deletedAt, recurrenceSeriesId",
        projects: "id, name, createdAt, updatedAt",
        taskCategories: "id, name, createdAt, updatedAt",
        taskLayouts: "taskId, updatedAt",
        transactions: "id, entityId, entityType, clientTimestamp, syncStatus",
        transactionChanges: "id, transactionId, fieldName",
        devBacklog: "id, kind, status, createdAt, updatedAt",
        taskTemplates: "id, name, createdAt, updatedAt",
      })
      .upgrade(async tx => {
        await tx.table("taskLayouts").clear();
      });

    // V11 / TaskMap v1.2: online-sync release. Preserve all user data and QA progress,
    // but demote prior urgent QA checks so only the newest sync/parser validation remains urgent.
    this.version(11)
      .stores({
        tasks: "id, projectId, parentTaskId, startDate, dueDate, priority, status, manualOrder, createdAt, updatedAt, deletedAt, recurrenceSeriesId",
        projects: "id, name, createdAt, updatedAt",
        taskCategories: "id, name, createdAt, updatedAt",
        taskLayouts: "taskId, updatedAt",
        transactions: "id, entityId, entityType, clientTimestamp, syncStatus",
        transactionChanges: "id, transactionId, fieldName",
        devBacklog: "id, kind, status, createdAt, updatedAt",
        taskTemplates: "id, name, createdAt, updatedAt",
      })
      .upgrade(async tx => {
        const taskTable = tx.table("tasks");
        const projectTable = tx.table("projects");
        const qaProject = (await projectTable.toArray() as Project[]).find(project => project.name === "TaskMap QA Checklist");
        if (!qaProject) return;
        for (const task of await taskTable.toArray() as Task[]) {
          if (task.projectId === qaProject.id && task.priority === "urgent") await taskTable.update(task.id, { priority: "normal" });
        }
      });
  }
}

export const db = new TaskMapDB();

export async function cloneActiveDatabaseToWorkspace(workspaceId: string) {
  const target = new TaskMapDB(workspaceDatabaseName(workspaceId));
  await target.open();
  const [tasks, projects, categories, layouts, transactions, changes, backlog, templates] = await Promise.all([
    db.tasks.toArray(), db.projects.toArray(), db.taskCategories.toArray(), db.taskLayouts.toArray(),
    db.transactions.toArray(), db.transactionChanges.toArray(), db.devBacklog.toArray(), db.taskTemplates.toArray(),
  ]);
  await target.transaction("rw", [
    target.tasks,
    target.projects,
    target.taskCategories,
    target.taskLayouts,
    target.transactions,
    target.transactionChanges,
    target.devBacklog,
    target.taskTemplates,
  ], async () => {
    await Promise.all([target.tasks.clear(), target.projects.clear(), target.taskCategories.clear(), target.taskLayouts.clear(), target.transactions.clear(), target.transactionChanges.clear(), target.devBacklog.clear(), target.taskTemplates.clear()]);
    if (tasks.length) await target.tasks.bulkPut(tasks);
    if (projects.length) await target.projects.bulkPut(projects);
    if (categories.length) await target.taskCategories.bulkPut(categories);
    if (layouts.length) await target.taskLayouts.bulkPut(layouts);
    if (transactions.length) await target.transactions.bulkPut(transactions);
    if (changes.length) await target.transactionChanges.bulkPut(changes);
    if (backlog.length) await target.devBacklog.bulkPut(backlog);
    if (templates.length) await target.taskTemplates.bulkPut(templates);
  });
  target.close();
}

export async function clearWorkspaceDatabase(workspaceId: string) {
  await Dexie.delete(workspaceDatabaseName(workspaceId));
}
