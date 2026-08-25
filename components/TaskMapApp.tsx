"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  CalendarDays,
  CheckCircle2,
  Circle,
  CloudOff,
  GitBranch,
  FileStack,
  Expand,
  Repeat2,
  Trash2,
  Home,
  Inbox,
  ListTodo,
  Map as MapIcon,
  Plus,
  Search,
  Sparkles,
  Sun,
  Wifi,
  X,
} from "lucide-react";
import { db } from "@/lib/db";
import {
  addDevBacklogItem,
  createProject,
  createTask,
  createTaskCategory,
  deleteTaskCategory,
  deleteTaskSet,
  moveTaskInList,
  seedQaChecklist,
  saveTaskHierarchyAsTemplate,
  useTaskTemplate,
  toggleTaskComplete,
  updateTask,
} from "@/lib/task-service";
import { taskMatchesRule, validateRule } from "@/lib/rule-service";
import type { AssistantAction, Project, RecurrenceRule, Task, TaskCategory, TaskSortMode, TodayFilter } from "@/lib/types";
import { formatDayHeading, formatDuration, formatTime, localDateOnly } from "@/lib/format";
import MindMapView from "./views/MindMapView";
import CalendarView from "./views/CalendarView";
import HistoryPanel from "./views/HistoryPanel";
import OfflineBootstrap from "./OfflineBootstrap";
import AssistantPanel from "./AssistantPanel";
import TemplatesView from "./TemplatesView";
import { defaultRecurrenceRule, recurrenceLabel } from "@/lib/recurrence";

const nav = [
  ["home", "Home", Home],
  ["today", "Today", Sun],
  ["inbox", "Inbox", Inbox],
  ["map", "Map", MapIcon],
  ["calendar", "Calendar", CalendarDays],
  ["tasks", "Tasks", ListTodo],
  ["completed", "Completed", CheckCircle2],
  ["templates", "Templates", FileStack],
] as const;

type View = (typeof nav)[number][0];
type DropMode = "before" | "after" | "nest";
type HierarchyEntry = { task: Task; depth: number };

const priorityRank: Record<Task["priority"], number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function sortTasks(tasks: Task[], mode: TaskSortMode) {
  const copy = [...tasks];
  switch (mode) {
    case "priority": return copy.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.manualOrder - b.manualOrder);
    case "due": return copy.sort((a, b) => (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31") || a.manualOrder - b.manualOrder);
    case "start": return copy.sort((a, b) => `${a.startDate ?? "9999-12-31"}T${a.startTime ?? "23:59"}`.localeCompare(`${b.startDate ?? "9999-12-31"}T${b.startTime ?? "23:59"}`) || a.manualOrder - b.manualOrder);
    case "created": return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case "alphabetical": return copy.sort((a, b) => a.title.localeCompare(b.title));
    default: return copy.sort((a, b) => a.manualOrder - b.manualOrder);
  }
}

function descendantIds(tasks: Task[], parentId: string) {
  const byParent = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    const list = byParent.get(task.parentTaskId) ?? [];
    list.push(task);
    byParent.set(task.parentTaskId, list);
  }
  const found = new Set<string>();
  const queue = [parentId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of byParent.get(current) ?? []) {
      if (found.has(child.id)) continue;
      found.add(child.id);
      queue.push(child.id);
    }
  }
  return found;
}

function hierarchyEntries(tasks: Task[], mode: TaskSortMode): HierarchyEntry[] {
  const ids = new Set(tasks.map(task => task.id));
  const byParent = new Map<string | null, Task[]>();
  for (const task of tasks) {
    const effectiveParent = task.parentTaskId && ids.has(task.parentTaskId) ? task.parentTaskId : null;
    const list = byParent.get(effectiveParent) ?? [];
    list.push(task);
    byParent.set(effectiveParent, list);
  }
  for (const [key, list] of byParent) byParent.set(key, sortTasks(list, mode));

  const output: HierarchyEntry[] = [];
  const visited = new Set<string>();
  const walk = (task: Task, depth: number) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    output.push({ task, depth });
    for (const child of byParent.get(task.id) ?? []) walk(child, depth + 1);
  };
  for (const root of byParent.get(null) ?? []) walk(root, 0);
  for (const task of sortTasks(tasks, mode)) if (!visited.has(task.id)) walk(task, 0);
  return output;
}

export default function TaskMapApp() {
  const [view, setView] = useState<View>("tasks");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [focusedParentId, setFocusedParentId] = useState<string | null>(null);
  const [selectedTagFilter, setSelectedTagFilter] = useState<string | null>(null);
  const [quickTitle, setQuickTitle] = useState("");
  const [online, setOnline] = useState(true);
  const [todayFilter, setTodayFilter] = useState<TodayFilter>(null);
  const [sortMode, setSortMode] = useState<TaskSortMode>("manual");
  const [showCompleted, setShowCompleted] = useState(true);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ targetId: string; mode: DropMode } | null>(null);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categoryRule, setCategoryRule] = useState('Project = "My Project"');
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [projectDropId, setProjectDropId] = useState<string | null>(null);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [deleteRequest, setDeleteRequest] = useState<{ ids: string[]; source: "single" | "bulk" } | null>(null);

  const tasks = useLiveQuery(() => db.tasks.filter(task => !task.deletedAt).toArray(), [], []);
  const projects = useLiveQuery(() => db.projects.orderBy("name").toArray(), [], []);
  const categories = useLiveQuery(() => db.taskCategories.orderBy("createdAt").toArray(), [], []);
  const pending = useLiveQuery(() => db.transactions.where("syncStatus").equals("pending").count(), [], 0);

  useEffect(() => { void seedQaChecklist(); }, []);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selected = tasks.find(task => task.id === selectedId) ?? null;
  const today = localDateOnly();
  const projectScoped = selectedProjectId ? tasks.filter(task => task.projectId === selectedProjectId) : tasks;
  const focusedParent = focusedParentId ? tasks.find(task => task.id === focusedParentId) ?? null : null;
  const parentScopeIds = useMemo(() => focusedParentId ? new Set([focusedParentId, ...descendantIds(tasks, focusedParentId)]) : null, [tasks, focusedParentId]);
  const normalizedTagFilter = selectedTagFilter?.trim().toLowerCase() ?? null;
  const tagScoped = normalizedTagFilter ? tasks.filter(task => (task.tags ?? []).some(tag => tag.toLowerCase() === normalizedTagFilter)) : null;
  const baseScope = tagScoped ?? (parentScopeIds ? tasks.filter(task => parentScopeIds.has(task.id)) : projectScoped);

  const todayTasks = projectScoped.filter(task => task.dueDate === today || task.startDate === today || task.priority === "urgent");
  const todayVisibleByCompleted = showCompleted ? todayTasks : todayTasks.filter(task => task.status !== "done");
  const filteredToday = todayVisibleByCompleted.filter(task => {
    if (todayFilter === "scheduled") return Boolean(task.startTime);
    if (todayFilter === "unscheduled") return !task.startTime;
    if (todayFilter === "urgent") return task.priority === "urgent";
    return true;
  });

  let baseVisibleTasks: Task[] = baseScope;
  if (view === "today") baseVisibleTasks = filteredToday;
  if (view === "inbox") baseVisibleTasks = tasks.filter(task => !task.projectId);
  if (view === "completed") baseVisibleTasks = baseScope.filter(task => task.status === "done");
  if (view !== "completed") baseVisibleTasks = baseVisibleTasks.filter(task => !(task.status === "done" && task.recurrence?.enabled));
  if (view !== "today" && view !== "completed" && !showCompleted) baseVisibleTasks = baseVisibleTasks.filter(task => task.status !== "done");

  const normalizedSearch = searchQuery.trim().toLowerCase();
  if (normalizedSearch && view !== "map" && view !== "calendar") {
    baseVisibleTasks = baseVisibleTasks.filter(task => {
      const projectName = projects.find(project => project.id === task.projectId)?.name ?? "";
      const parentName = tasks.find(parent => parent.id === task.parentTaskId)?.title ?? "";
      return [task.title, task.notes, projectName, parentName, ...(task.tags ?? [])].some(value => value.toLowerCase().includes(normalizedSearch));
    });
  }

  const displayEntries = hierarchyEntries(baseVisibleTasks, sortMode);
  const visibleTasks = displayEntries.map(entry => entry.task);

  const scheduledToday = todayTasks.filter(task => Boolean(task.startTime));
  const unscheduledToday = todayTasks.filter(task => !task.startTime);
  const urgentToday = todayTasks.filter(task => task.priority === "urgent");
  const workload = todayTasks.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0);
  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null;

  async function addQuickTask() {
    const titles = quickTitle.split(",").map(title => title.trim()).filter(Boolean);
    if (!titles.length) return;
    const created: Task[] = [];
    const currentFirstOrder = tasks.length ? Math.min(...tasks.map(task => task.manualOrder)) : 1000;
    const firstNewOrder = currentFirstOrder - titles.length * 1000;
    for (let index = 0; index < titles.length; index += 1) {
      created.push(await createTask({
        title: titles[index],
        projectId: focusedParent ? focusedParent.projectId : selectedProjectId,
        parentTaskId: focusedParentId,
        dueDate: view === "today" ? today : null,
        manualOrder: firstNewOrder + index * 1000,
      }));
    }
    setQuickTitle("");
    setSelectedId(created[0]?.id ?? null);
  }

  async function addProject() {
    if (!projectName.trim()) return;
    const colors = ["#5B5BD6", "#2E9D8F", "#E68A3F", "#3FA56A", "#8B5CF6"];
    const project = await createProject(projectName, colors[projects.length % colors.length]);
    setProjectName("");
    setShowProjectForm(false);
    setFocusedParentId(null);
    setSelectedProjectId(project.id);
    setView("tasks");
  }

  async function addCategory() {
    const error = validateRule(categoryRule);
    if (error) {
      setCategoryError(error);
      return;
    }
    if (!categoryName.trim()) {
      setCategoryError("Enter a category name.");
      return;
    }
    await createTaskCategory(categoryName, categoryRule);
    setCategoryName("");
    setCategoryRule('Project = "My Project"');
    setCategoryError(null);
    setShowCategoryForm(false);
  }

  async function handleDrop(targetId: string, mode: DropMode) {
    if (!draggingId || draggingId === targetId || sortMode !== "manual") return;
    const dragged = tasks.find(task => task.id === draggingId);
    const target = tasks.find(task => task.id === targetId);
    if (!dragged || !target) return;

    if (mode === "nest") {
      if (descendantIds(tasks, dragged.id).has(target.id)) return;
      await updateTask(dragged.id, { parentTaskId: target.id, projectId: target.projectId ?? dragged.projectId }, "TASK_NESTED");
    } else {
      const withoutDragged = visibleTasks.filter(task => task.id !== draggingId);
      const targetIndex = withoutDragged.findIndex(task => task.id === targetId);
      const destinationIndex = Math.max(0, targetIndex + (mode === "after" ? 1 : 0));
      await moveTaskInList(dragged.id, visibleTasks, destinationIndex, target.parentTaskId);
    }
    setDraggingId(null);
    setDropIndicator(null);
  }

  async function moveBy(taskId: string, delta: number) {
    if (sortMode !== "manual") return;
    const index = visibleTasks.findIndex(task => task.id === taskId);
    if (index < 0) return;
    const destination = Math.max(0, Math.min(visibleTasks.length - 1, index + delta));
    if (destination === index) return;
    const target = visibleTasks[destination];
    const without = visibleTasks.filter(task => task.id !== taskId);
    const targetIndex = without.findIndex(task => task.id === target.id);
    await moveTaskInList(taskId, visibleTasks, Math.max(0, targetIndex + (delta > 0 ? 1 : 0)), target.parentTaskId);
  }

  function openProject(projectId: string | null) {
    setFocusedParentId(null);
    setSelectedTagFilter(null);
    setSelectedProjectId(projectId);
    setView("tasks");
    setSelectedId(null);
  }

  function focusParent(parentId: string) {
    setSelectedProjectId(null);
    setSelectedTagFilter(null);
    setFocusedParentId(parentId);
    setView("tasks");
    setSelectedId(parentId);
  }

  function focusTag(tag: string, keepTaskId: string | null = null) {
    const normalized = tag.trim();
    if (!normalized) return;
    setSelectedProjectId(null);
    setFocusedParentId(null);
    setSelectedTagFilter(normalized);
    setView("tasks");
    setSelectedId(keepTaskId);
  }

  function handleNav(id: View) {
    setView(id);
    setSelectedId(null);
    setBulkMode(false);
    setBulkSelected(new Set());
    if (id === "tasks" || id === "inbox") {
      setSelectedProjectId(null);
      setFocusedParentId(null);
      setSelectedTagFilter(null);
    }
  }

  async function dropTaskOnProject(projectId: string, event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    const taskId = event.dataTransfer.getData("application/taskmap-task") || draggingId;
    const task = tasks.find(candidate => candidate.id === taskId);
    setProjectDropId(null);
    setDraggingId(null);
    if (!task || task.projectId === projectId) return;
    await updateTask(task.id, { projectId }, "TASK_PROJECT_DROPPED");
  }

  function findTaskByTitle(title: string) {
    const normalized = title.trim().toLowerCase();
    return tasks.find(task => task.title.toLowerCase() === normalized) ?? tasks.find(task => task.title.toLowerCase().includes(normalized));
  }

  function findProjectByName(name: string) {
    const normalized = name.trim().toLowerCase();
    return projects.find(project => project.name.toLowerCase() === normalized) ?? projects.find(project => project.name.toLowerCase().includes(normalized));
  }

  async function executeAssistantAction(action: AssistantAction) {
    if (action.type === "create_project") { await createProject(action.name); return; }
    if (action.type === "create_category") { await createTaskCategory(action.name, action.rule); return; }
    if (action.type === "delete_category") { const match = categories.find(category => category.name.toLowerCase() === action.name.toLowerCase()); if (match) await deleteTaskCategory(match.id); return; }
    if (action.type === "remember_backlog") { await addDevBacklogItem(action.title, action.details ?? "", action.kind ?? "feature"); return; }
    if (action.type === "set_view") { handleNav(action.view); return; }
    if (action.type === "set_sort") { setSortMode(action.sort); return; }
    if (action.type === "set_show_completed") { setShowCompleted(action.value); return; }
    if (action.type === "filter_project") { const project = action.projectName ? findProjectByName(action.projectName) : null; openProject(project?.id ?? null); return; }
    if (action.type === "focus_parent") { const task = findTaskByTitle(action.taskTitle); if (task) focusParent(task.id); return; }
    if (action.type === "open_task") { const task = findTaskByTitle(action.taskTitle); if (task) setSelectedId(task.id); return; }
    if (action.type === "use_template") { const template = await db.taskTemplates.filter(item => item.name.toLowerCase() === action.templateName.toLowerCase()).first(); const project = action.projectName ? findProjectByName(action.projectName) : null; if (template) { const made = await useTaskTemplate(template.id, { projectId: action.projectName === null ? null : project?.id }); const root = made.find(task => !task.parentTaskId) ?? made[0]; if (root) handleTemplateUsed(root.id); } return; }
    if (action.type === "save_task_as_template") { const task = findTaskByTitle(action.taskTitle); if (task) await saveTaskHierarchyAsTemplate(task.id, action.templateName); return; }
    if (action.type === "set_recurrence") { const task = findTaskByTitle(action.taskTitle); if (task) { const rule = action.rule ? { ...action.rule, anchorDate: action.rule.anchorDate ?? task.startDate ?? localDateOnly(), anchorTime: action.rule.anchorTime ?? task.startTime } : null; await updateTask(task.id, { recurrence: rule, recurrenceSeriesId: rule ? task.recurrenceSeriesId ?? crypto.randomUUID() : null, recurrenceOccurrence: rule ? task.recurrenceOccurrence ?? 1 : null }, "AI_TASK_RECURRENCE_CHANGED"); } return; }
    if (action.type === "create_task") {
      const project = action.projectName ? findProjectByName(action.projectName) : null;
      const parent = action.parentTitle ? findTaskByTitle(action.parentTitle) : null;
      await createTask({ title: action.title, notes: action.notes ?? "", tags: action.tags ?? [], priority: action.priority ?? "normal", projectId: project?.id ?? parent?.projectId ?? null, parentTaskId: parent?.id ?? null, startDate: action.startDate ?? null, startTime: action.startTime ?? null, estimatedMinutes: action.estimatedMinutes ?? null, dueDate: action.dueDate ?? null, dueTime: action.dueTime ?? null });
      return;
    }
    const task = "taskTitle" in action ? findTaskByTitle(action.taskTitle) : null;
    if (!task) return;
    if (action.type === "complete_task") { if (task.status !== "done") await toggleTaskComplete(task); return; }
    if (action.type === "reopen_task") { if (task.status === "done") await toggleTaskComplete(task); return; }
    if (action.type === "delete_task") { await deleteTaskSet([task.id], "cascade"); return; }
    if (action.type === "update_task") {
      if (action.status === "done" && task.status !== "done") await toggleTaskComplete(task);
      else if (action.status && action.status !== "done" && task.status === "done") await toggleTaskComplete(task);
      const project = typeof action.projectName === "string" ? findProjectByName(action.projectName) : null;
      const parent = typeof action.parentTitle === "string" ? findTaskByTitle(action.parentTitle) : null;
      const patch: Partial<Task> = {};
      if (typeof action.title !== "undefined") patch.title = action.title;
      if (typeof action.notes !== "undefined") patch.notes = action.notes;
      if (typeof action.priority !== "undefined") patch.priority = action.priority;
      if (typeof action.status !== "undefined" && action.status !== "done") patch.status = action.status;
      if (typeof action.projectName !== "undefined") patch.projectId = action.projectName === null ? null : project?.id ?? task.projectId;
      if (typeof action.parentTitle !== "undefined") patch.parentTaskId = action.parentTitle === null ? null : parent?.id ?? task.parentTaskId;
      if (typeof action.startDate !== "undefined") patch.startDate = action.startDate;
      if (typeof action.startTime !== "undefined") patch.startTime = action.startTime;
      if (typeof action.estimatedMinutes !== "undefined") patch.estimatedMinutes = action.estimatedMinutes;
      if (typeof action.dueDate !== "undefined") patch.dueDate = action.dueDate;
      if (typeof action.dueTime !== "undefined") patch.dueTime = action.dueTime;
      if (typeof action.tags !== "undefined") patch.tags = action.tags;
      if (Object.keys(patch).length) await updateTask(task.id, patch, "AI_TASK_UPDATED");
    }
  }

  function requestDelete(ids: string[], source: "single" | "bulk" = "single") {
    const unique = [...new Set(ids)].filter(id => tasks.some(task => task.id === id));
    if (!unique.length) return;
    setDeleteRequest({ ids: unique, source });
  }

  function toggleBulkSelection(id: string) {
    setBulkSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  function handleTemplateUsed(rootTaskId: string) {
    setSelectedProjectId(null);
    setSelectedTagFilter(null);
    setFocusedParentId(rootTaskId);
    setView("tasks");
    setSelectedId(rootTaskId);
  }

  const pageTitle = view === "today"
    ? "Today"
    : view === "completed"
      ? "Completed"
      : view === "tasks" && focusedParent
        ? focusedParent.title
        : view === "tasks" && selectedTagFilter
          ? `#${selectedTagFilter}`
          : view === "tasks" && selectedProject
            ? selectedProject.name
            : view[0].toUpperCase() + view.slice(1);

  const pageSubtitle = view === "today"
    ? `${todayTasks.length} tasks · ${formatDuration(workload) || "No estimated time"} planned`
    : view === "completed"
      ? `${visibleTasks.length} completed task${visibleTasks.length === 1 ? "" : "s"}`
      : focusedParent
        ? `Parent task + ${Math.max(0, visibleTasks.length - 1)} subtask${visibleTasks.length === 2 ? "" : "s"}`
        : selectedTagFilter
          ? `${visibleTasks.length} task${visibleTasks.length === 1 ? "" : "s"} tagged ${selectedTagFilter}`
          : `${visibleTasks.length} task${visibleTasks.length === 1 ? "" : "s"}`;

  return (
    <div className="app-shell">
      <OfflineBootstrap />
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><GitBranch size={20} /></div><span>TaskMap</span></div>
        <nav>
          {nav.map(([id, label, Icon]) => (
            <button key={id} className={view === id ? "nav-item active" : "nav-item"} onClick={() => handleNav(id)}>
              <Icon size={18} /><span>{label}</span>{id === "today" && <span className="nav-count">{todayTasks.length}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-section-title">Projects</div>
        <button className={selectedProjectId === null && !focusedParentId && !selectedTagFilter ? "project-item selected-project" : "project-item"} onClick={() => openProject(null)}>
          <span className="project-dot" style={{ background: "#9CA3AF" }} />All projects
        </button>
        {projects.map(project => (
          <button key={project.id} className={`${selectedProjectId === project.id ? "project-item selected-project" : "project-item"} ${projectDropId === project.id ? "project-drop-target" : ""}`} onClick={() => openProject(project.id)} onDragOver={event => { event.preventDefault(); setProjectDropId(project.id); }} onDragLeave={() => setProjectDropId(current => current === project.id ? null : current)} onDrop={event => void dropTaskOnProject(project.id, event)}>
            <span className="project-dot" style={{ background: project.color }} />
            <span className="project-name">{project.name}</span>
            <span className="project-count">{tasks.filter(task => task.projectId === project.id && task.status !== "done").length}</span>
          </button>
        ))}
        {!showProjectForm ? (
          <button className="new-project" onClick={() => setShowProjectForm(true)}><Plus size={15} /> New project</button>
        ) : (
          <div className="sidebar-create-form">
            <input autoFocus value={projectName} onChange={event => setProjectName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") addProject(); if (event.key === "Escape") setShowProjectForm(false); }} placeholder="Project name" />
            <div><button onClick={addProject}>Add</button><button className="ghost" onClick={() => setShowProjectForm(false)}>Cancel</button></div>
          </div>
        )}

        <div className="sidebar-bottom">
          <div className={online ? "sync-pill" : "sync-pill offline"}>
            {online ? <Wifi size={15} /> : <CloudOff size={15} />}
            <span>{online ? `${pending} local change${pending === 1 ? "" : "s"}` : `Offline · ${pending} pending`}</span>
          </div>
        </div>
      </aside>

      <main className={selected ? "main-area inspector-open" : "main-area"}>
        <header className="topbar">
          <div className="search"><Search size={17} /><input id="task-search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search tasks" aria-label="Search tasks" />{searchQuery && <button className="clear-search" onClick={() => setSearchQuery("")} aria-label="Clear search"><X size={14} /></button>}<kbd>Ctrl K</kbd></div>
          <div className="topbar-actions"><button className="ask-taskmap-button" onClick={() => { setSelectedId(null); setAssistantOpen(true); }}><Sparkles size={15} /> Ask TaskMap</button><button className="avatar">BC</button></div>
        </header>

        {view === "map" ? (
          <MindMapView tasks={tasks} projects={projects} onSelect={setSelectedId} />
        ) : view === "calendar" ? (
          <CalendarView tasks={projectScoped} onSelect={setSelectedId} />
        ) : view === "templates" ? (
          <TemplatesView projects={projects} onUsed={handleTemplateUsed} />
        ) : (
          <section className="content">
            <div className="page-heading">
              <div>
                <p className="eyebrow">{view === "today" ? formatDayHeading() : focusedParent ? "Parent hierarchy" : selectedTagFilter ? `Tag · ${selectedTagFilter}` : selectedProject ? `Project · ${selectedProject.name}` : "Workspace"}</p>
                <h1>{pageTitle}</h1>
                <p className="subtitle">{pageSubtitle}</p>
              </div>
              {view !== "completed" && <button className="primary-button" onClick={() => document.getElementById("quick-task")?.focus()}><Plus size={17} /> Add task</button>}
            </div>

            {focusedParent && view === "tasks" && (
              <div className="active-filter-banner">
                <span>Showing <strong>{focusedParent.title}</strong> and all subtasks</span>
                <button onClick={() => { setFocusedParentId(null); setSelectedId(null); }}><X size={15} /> Clear parent filter</button>
              </div>
            )}

            {selectedTagFilter && view === "tasks" && (
              <div className="active-filter-banner tag-filter-banner">
                <span>Showing tasks tagged <strong>{selectedTagFilter}</strong></span>
                <button onClick={() => { setSelectedTagFilter(null); setSelectedId(null); }}><X size={15} /> Clear tag filter</button>
              </div>
            )}

            {view === "today" && (
              <div className="stat-grid">
                <StatFilterCard label="Scheduled" value={scheduledToday.length} detail={`${formatDuration(scheduledToday.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0)) || "0m"} blocked`} active={todayFilter === "scheduled"} onClick={() => setTodayFilter(todayFilter === "scheduled" ? null : "scheduled")} />
                <StatFilterCard label="Unscheduled" value={unscheduledToday.length} detail={`${formatDuration(unscheduledToday.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0)) || "0m"} to place`} active={todayFilter === "unscheduled"} onClick={() => setTodayFilter(todayFilter === "unscheduled" ? null : "unscheduled")} />
                <StatFilterCard label="Urgent" value={urgentToday.length} detail="need attention" active={todayFilter === "urgent"} danger onClick={() => setTodayFilter(todayFilter === "urgent" ? null : "urgent")} />
              </div>
            )}

            <div className="task-panel">
              <div className="task-panel-header task-panel-toolbar">
                <div><h2>{view === "today" ? "Today’s tasks" : view === "completed" ? "Completed tasks" : "Tasks"}</h2><span>{visibleTasks.filter(task => task.status !== "done").length} open</span></div>
                <div className="task-toolbar-actions">
                  {(["tasks","today","inbox","completed"] as View[]).includes(view) && <>{bulkMode ? <><span className="bulk-count">{bulkSelected.size} selected</span><button className="danger-button compact" disabled={!bulkSelected.size} onClick={() => requestDelete([...bulkSelected], "bulk")}><Trash2 size={13}/> Delete</button><button className="ghost-button compact" onClick={() => { setBulkMode(false); setBulkSelected(new Set()); }}>Done</button></> : <button className="ghost-button compact" onClick={() => { setBulkMode(true); setBulkSelected(new Set()); }}>Select</button>}</>}
                  {view !== "completed" && <label className="compact-toggle"><input type="checkbox" checked={showCompleted} onChange={event => setShowCompleted(event.target.checked)} /> Show completed</label>}
                  <label className="sort-control">Sort
                    <select value={sortMode} onChange={event => setSortMode(event.target.value as TaskSortMode)}>
                      <option value="manual">Manual</option>
                      <option value="priority">Priority</option>
                      <option value="due">Due date</option>
                      <option value="start">Start date/time</option>
                      <option value="created">Created date</option>
                      <option value="alphabetical">Alphabetical</option>
                    </select>
                  </label>
                </div>
              </div>
              {view !== "completed" && <div className="quick-add"><Plus size={18} /><input id="quick-task" value={quickTitle} onChange={event => setQuickTitle(event.target.value)} onKeyDown={event => { if (event.key === "Enter") addQuickTask(); }} placeholder={focusedParent ? `Add subtask(s) under ${focusedParent.title} — commas supported` : "Add task(s) — separate multiple with commas"} /></div>}
              <div className="task-list">
                {displayEntries.length === 0 ? <div className="empty-state">No tasks match this view.</div> : displayEntries.map(({ task, depth }, index) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    depth={depth}
                    project={projects.find(project => project.id === task.projectId) ?? null}
                    parent={task.parentTaskId ? tasks.find(parent => parent.id === task.parentTaskId) ?? null : null}
                    selected={selectedId === task.id}
                    onSelect={() => bulkMode ? toggleBulkSelection(task.id) : setSelectedId(task.id)}
                    bulkMode={bulkMode}
                    bulkChecked={bulkSelected.has(task.id)}
                    onBulkToggle={() => toggleBulkSelection(task.id)}
                    manual={sortMode === "manual"}
                    isFirst={index === 0}
                    isLast={index === displayEntries.length - 1}
                    onMove={delta => moveBy(task.id, delta)}
                    onDragStart={event => { event.dataTransfer.setData("application/taskmap-task", task.id); event.dataTransfer.setData("text/plain", task.id); setDraggingId(task.id); setDropIndicator(null); }}
                    onDragHover={(targetId, mode) => setDropIndicator({ targetId, mode })}
                    dropMode={dropIndicator?.targetId === task.id ? dropIndicator.mode : null}
                    onDrop={(targetId, mode) => handleDrop(targetId, mode)}
                    onDragEnd={() => { setDraggingId(null); setDropIndicator(null); setProjectDropId(null); }}
                    onProjectClick={projectId => openProject(projectId)}
                    onParentClick={parentId => focusParent(parentId)}
                    onTagClick={tag => focusTag(tag)}
                  />
                ))}
              </div>
            </div>

            {view === "tasks" && (
              <TaskCategoriesSection
                categories={categories}
                tasks={normalizedSearch ? baseVisibleTasks : baseScope}
                projects={projects}
                showCompleted={showCompleted}
                selectedId={selectedId}
                onSelect={setSelectedId}
                showForm={showCategoryForm}
                setShowForm={setShowCategoryForm}
                name={categoryName}
                setName={setCategoryName}
                rule={categoryRule}
                setRule={value => { setCategoryRule(value); setCategoryError(null); }}
                error={categoryError}
                onAdd={addCategory}
                onDelete={deleteTaskCategory}
              />
            )}
          </section>
        )}
      </main>

      {selected && (
        <TaskInspector
          task={selected}
          tasks={tasks}
          projects={projects}
          onClose={() => setSelectedId(null)}
          onOpenTask={setSelectedId}
          onFocusParent={focusParent}
          onTagClick={tag => focusTag(tag, selected.id)}
          onRequestDelete={() => requestDelete([selected.id], "single")}
        />
      )}
      {deleteRequest && <DeleteTasksDialog request={deleteRequest} tasks={tasks} onCancel={() => setDeleteRequest(null)} onDelete={async mode => { await deleteTaskSet(deleteRequest.ids, mode); const removed = new Set(deleteRequest.ids); if (selectedId && removed.has(selectedId)) setSelectedId(null); setBulkSelected(new Set()); setBulkMode(false); setDeleteRequest(null); }} />}
      {assistantOpen && <AssistantPanel tasks={tasks} projects={projects} onClose={() => setAssistantOpen(false)} onExecuteAction={executeAssistantAction} />}
    </div>
  );
}

function StatFilterCard({ label, value, detail, active, danger = false, onClick }: { label: string; value: number; detail: string; active: boolean; danger?: boolean; onClick: () => void }) {
  return <button className={`stat-card stat-filter ${active ? "active" : ""} ${danger ? "danger" : ""}`} aria-pressed={active} onClick={onClick}><span>{label}</span><strong>{value}</strong><small>{detail}</small></button>;
}

function TaskRow({ task, depth, project, parent, selected, onSelect, bulkMode, bulkChecked, onBulkToggle, manual, isFirst, isLast, onMove, onDragStart, onDragHover, dropMode, onDrop, onDragEnd, onProjectClick, onParentClick, onTagClick }: {
  task: Task;
  depth: number;
  project: Project | null;
  parent: Task | null;
  selected: boolean;
  onSelect: () => void;
  bulkMode: boolean;
  bulkChecked: boolean;
  onBulkToggle: () => void;
  manual: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove: (delta: number) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragHover: (targetId: string, mode: DropMode) => void;
  dropMode: DropMode | null;
  onDrop: (targetId: string, mode: DropMode) => void;
  onDragEnd: () => void;
  onProjectClick: (projectId: string) => void;
  onParentClick: (parentId: string) => void;
  onTagClick: (tag: string) => void;
}) {
  function modeFromEvent(event: DragEvent<HTMLDivElement>): DropMode {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - box.top) / Math.max(1, box.height);
    if (ratio < 0.25) return "before";
    if (ratio > 0.75) return "after";
    return "nest";
  }

  return (
    <div
      className={`${selected ? "task-row selected" : "task-row"} ${task.status === "done" ? "completed-row" : ""} ${dropMode ? `drop-${dropMode}` : ""}`}
      style={{ paddingLeft: `${18 + depth * 26}px` }}
      onClick={onSelect}
      draggable
      onDragStart={event => { event.dataTransfer.effectAllowed = "move"; onDragStart(event); }}
      onDragOver={event => { if (manual) { event.preventDefault(); onDragHover(task.id, modeFromEvent(event)); } }}
      onDrop={event => { event.preventDefault(); if (manual) onDrop(task.id, modeFromEvent(event)); }}
      onDragEnd={onDragEnd}
    >
      {bulkMode && <label className="bulk-task-check" onClick={event => event.stopPropagation()}><input type="checkbox" checked={bulkChecked} onChange={onBulkToggle} aria-label={`Select ${task.title}`} /></label>}
      <span className="drag-handle" title={manual ? "Drag between tasks to reorder, onto a task to make it a subtask, or onto a sidebar project" : "Drag onto a sidebar project to assign this task"} aria-hidden="true">⋮⋮</span>
      <button className="check-button" aria-label={task.status === "done" ? `Reopen ${task.title}` : `Complete ${task.title}`} onClick={event => { event.stopPropagation(); void toggleTaskComplete(task); }}>{task.status === "done" ? <CheckCircle2 size={21} /> : <Circle size={21} />}</button>
      <div className="task-copy">
        <strong className={task.status === "done" ? "done" : ""}>{task.title}</strong>
        <div className="task-meta">{task.startTime && <span>{formatTime(task.startTime)}</span>}{task.estimatedMinutes != null && <span>{formatDuration(task.estimatedMinutes)}</span>}{task.dueDate && <span>Due {task.dueDate === localDateOnly() ? "today" : task.dueDate}</span>}{task.status === "done" && task.completedAt && <span>Completed {new Date(task.completedAt).toLocaleDateString()}</span>}{task.recurrence?.enabled && <span className="repeat-badge"><Repeat2 size={11}/> {recurrenceLabel(task.recurrence)}</span>}</div>
        {(project || parent || (task.tags ?? []).length > 0) && <div className="task-tags">
          {project && <button className="task-tag project-tag" onClick={event => { event.stopPropagation(); onProjectClick(project.id); }}>Project: {project.name}</button>}
          {parent && <button className="task-tag parent-tag" onClick={event => { event.stopPropagation(); onParentClick(parent.id); }}>Parent: {parent.title}</button>}
          {(task.tags ?? []).map((tag, tagIndex) => <button key={`${tag}-${tagIndex}`} className="task-tag label-tag" onClick={event => { event.stopPropagation(); onTagClick(tag); }}>Tag: {tag}</button>)}
        </div>}
      </div>
      {manual && <div className="order-buttons"><button disabled={isFirst} title="Move up" onClick={event => { event.stopPropagation(); onMove(-1); }}>↑</button><button disabled={isLast} title="Move down" onClick={event => { event.stopPropagation(); onMove(1); }}>↓</button></div>}
      <span className={`priority ${task.priority}`}>{task.priority === "urgent" ? "!!!" : task.priority === "high" ? "!!" : task.priority === "normal" ? "!" : "–"}</span>
    </div>
  );
}

function TaskCategoriesSection({ categories, tasks, projects, showCompleted, selectedId, onSelect, showForm, setShowForm, name, setName, rule, setRule, error, onAdd, onDelete }: {
  categories: TaskCategory[];
  tasks: Task[];
  projects: Project[];
  showCompleted: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  showForm: boolean;
  setShowForm: (value: boolean) => void;
  name: string;
  setName: (value: string) => void;
  rule: string;
  setRule: (value: string) => void;
  error: string | null;
  onAdd: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section className="category-section">
      <div className="category-heading">
        <div><p className="eyebrow">Rule-based views</p><h2>Task categories</h2><p>Create Kanban-style lanes with rules such as <code>Project = "My Project"</code> or <code>Due Date = "9/1/2026"</code>.</p></div>
        <button className="secondary-button" onClick={() => setShowForm(!showForm)}><Plus size={16} /> Add category</button>
      </div>

      {showForm && (
        <div className="category-form">
          <label>Name<input value={name} onChange={event => setName(event.target.value)} placeholder="Due September 1" /></label>
          <label>Rule<input value={rule} onChange={event => setRule(event.target.value)} placeholder={'Project = "My Project" AND Priority = "urgent"'} /></label>
          <div className="category-form-footer"><span className={error ? "rule-error" : "rule-help"}>{error ?? "Supported: Project, Due Date, Start Date, Priority, Status, Duration, Completed, Title, Created Date. Join rules with AND."}</span><div><button className="ghost-button" onClick={() => setShowForm(false)}>Cancel</button><button className="primary-button compact" onClick={onAdd}>Create category</button></div></div>
        </div>
      )}

      {categories.length === 0 ? <div className="empty-category">No custom categories yet.</div> : (
        <div className="kanban-board">
          {categories.map(category => {
            const matching = tasks.filter(task => (showCompleted || task.status !== "done") && taskMatchesRule(task, category.rule, projects));
            return (
              <div className="kanban-lane" key={category.id}>
                <div className="kanban-lane-header"><div><span className="lane-dot" style={{ background: category.color }} /><strong>{category.name}</strong><small>{matching.length}</small></div><button title="Delete category" onClick={() => onDelete(category.id)}>×</button></div>
                <code className="lane-rule">{category.rule}</code>
                <div className="kanban-cards">
                  {matching.map(task => <button key={task.id} className={selectedId === task.id ? "kanban-task selected" : "kanban-task"} onClick={() => onSelect(task.id)}><span className={task.status === "done" ? "done" : ""}>{task.title}</span><small>{task.dueDate ? `Due ${task.dueDate}` : task.estimatedMinutes ? formatDuration(task.estimatedMinutes) : "No date"}</small></button>)}
                  {matching.length === 0 && <div className="lane-empty">No matching tasks</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

type CommitFn = (value: string) => Promise<unknown> | unknown;

function BufferedControl({ value, onCommit, children }: { value: string; onCommit: CommitFn; children: (state: { draft: string; setDraft: (value: string) => void; onBlur: () => void; dirty: boolean; error: boolean }) => ReactNode }) {
  const [draft, setDraftState] = useState(value);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (value === draft) {
      setDirty(false);
      setError(false);
    } else if (!dirty) {
      setDraftState(value);
    }
  }, [value, draft, dirty]);

  function setDraft(next: string) {
    setDraftState(next);
    setDirty(next !== value);
    setError(false);
  }

  async function commit() {
    if (!dirty) return;
    try {
      await onCommit(draft);
      setError(false);
    } catch {
      setError(true);
    }
  }

  return <>{children({ draft, setDraft, onBlur: commit, dirty, error })}</>;
}

function FieldState({ dirty, error }: { dirty: boolean; error: boolean }) {
  if (error) return <span className="field-state error">Save failed</span>;
  if (dirty) return <span className="field-state dirty">Unsaved</span>;
  return null;
}

function BufferedInput({ value, onCommit, type = "text", min, step, placeholder, className = "" }: { value: string; onCommit: CommitFn; type?: string; min?: string; step?: string; placeholder?: string; className?: string }) {
  return <BufferedControl value={value} onCommit={onCommit}>{({ draft, setDraft, onBlur, dirty, error }) => <><input className={`${className} ${dirty ? "dirty-field" : ""} ${error ? "save-error-field" : ""}`.trim()} type={type} min={min} step={step} value={draft} onChange={event => setDraft(event.target.value)} onBlur={onBlur} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setDraft(value); event.currentTarget.blur(); } }} placeholder={placeholder} /><FieldState dirty={dirty} error={error} /></>}</BufferedControl>;
}

function BufferedSelect({ value, onCommit, children }: { value: string; onCommit: CommitFn; children: ReactNode }) {
  return <BufferedControl value={value} onCommit={onCommit}>{({ draft, setDraft, onBlur, dirty, error }) => <><select className={`${dirty ? "dirty-field" : ""} ${error ? "save-error-field" : ""}`.trim()} value={draft} onChange={event => setDraft(event.target.value)} onBlur={onBlur}>{children}</select><FieldState dirty={dirty} error={error} /></>}</BufferedControl>;
}

function BufferedTextarea({ value, onCommit, placeholder }: { value: string; onCommit: CommitFn; placeholder?: string }) {
  return <BufferedControl value={value} onCommit={onCommit}>{({ draft, setDraft, onBlur, dirty, error }) => <><textarea className={`${dirty ? "dirty-field" : ""} ${error ? "save-error-field" : ""}`.trim()} value={draft} onChange={event => setDraft(event.target.value)} onBlur={onBlur} placeholder={placeholder} /><FieldState dirty={dirty} error={error} /></>}</BufferedControl>;
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="detail-field"><span>{label}</span>{children}</div>;
}

function stripHtml(value: string) {
  if (!value) return "";
  if (typeof document === "undefined") return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const div = document.createElement("div");
  div.innerHTML = value;
  return (div.textContent ?? "").replace(/\s+/g," ").trim();
}

function sanitizeRichHtml(value: string) {
  if (typeof document === "undefined") return value;
  const template = document.createElement("template");
  template.innerHTML = value;
  const blocked = new Set(["SCRIPT","STYLE","IFRAME","OBJECT","EMBED","FORM","INPUT","BUTTON","META","LINK"]);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];
  while (walker.nextNode()) elements.push(walker.currentNode as Element);
  for (const element of elements) {
    if (blocked.has(element.tagName)) { element.remove(); continue; }
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim();
      if (name.startsWith("on") || name === "srcdoc" || name === "style") element.removeAttribute(attr.name);
      if (name === "href" && val && !/^(https?:|mailto:|tel:|#|\/)/i.test(val)) element.removeAttribute(attr.name);
      if (name === "src" && val && !/^(https?:|data:image\/(png|jpeg|jpg|gif|webp);base64,)/i.test(val)) element.removeAttribute(attr.name);
    }
    if (element.tagName === "A") { element.setAttribute("target","_blank"); element.setAttribute("rel","noopener noreferrer"); }
    if (element.tagName === "IMG") { element.setAttribute("loading","lazy"); element.setAttribute("alt",element.getAttribute("alt") || "Task note image"); }
  }
  return template.innerHTML;
}

function NotesField({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);
  const preview = stripHtml(task.notes);
  return <>
    <div className="notes-field-wrap rich-notes-preview"><div className={preview ? "note-preview-text" : "note-preview-text empty"}>{preview || "No notes yet."}</div><button className="expand-notes-button" onClick={() => setExpanded(true)} title="Open rich note editor"><Expand size={14}/> Expand</button></div>
    {expanded && <RichNotesModal task={task} onClose={() => setExpanded(false)} />}
  </>;
}

function RichNotesModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const [draft,setDraft] = useState(task.notes || "");
  const [sourceMode,setSourceMode] = useState(false);
  const [saving,setSaving] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const dirty = draft !== task.notes;

  useEffect(()=>{ if (!sourceMode && editorRef.current && editorRef.current.innerHTML !== draft) editorRef.current.innerHTML = draft; },[sourceMode,task.id]);

  function syncEditor() { if (editorRef.current) setDraft(editorRef.current.innerHTML); }
  function command(name:string,value?:string) { editorRef.current?.focus(); document.execCommand(name,false,value); syncEditor(); }
  function insertHtml(html:string) { editorRef.current?.focus(); document.execCommand("insertHTML",false,html); syncEditor(); }
  function addLink() { const url=window.prompt("Link URL","https://"); if(url?.trim()) command("createLink",url.trim()); }
  async function addImageFile(file:File) {
    if (!file.type.startsWith("image/")) return;
    if (file.size > 5 * 1024 * 1024) { window.alert("Images are limited to 5 MB each in this prototype build."); return; }
    const dataUrl = await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});
    insertHtml(`<img src="${dataUrl}" alt="${file.name.replaceAll('"','&quot;')}" />`);
  }
  async function saveAndClose() { setSaving(true); const clean=sanitizeRichHtml(sourceMode?draft:(editorRef.current?.innerHTML??draft)); await updateTask(task.id,{notes:clean},"TASK_RICH_NOTES_CHANGED"); setSaving(false); onClose(); }

  return <div className="notes-modal-backdrop" onMouseDown={event => { if(event.currentTarget===event.target && !dirty) onClose(); }}><div className="notes-modal rich-notes-modal">
    <div className="notes-modal-head"><div><p className="eyebrow">Rich HTML note</p><strong>{task.title}</strong></div><button onClick={()=>{if(!dirty||window.confirm("Discard unsaved note changes?"))onClose();}}>×</button></div>
    <div className="rich-note-toolbar">
      <button onMouseDown={e=>e.preventDefault()} onClick={()=>command("bold")}><b>B</b></button><button onMouseDown={e=>e.preventDefault()} onClick={()=>command("italic")}><i>I</i></button><button onMouseDown={e=>e.preventDefault()} onClick={()=>command("underline")}><u>U</u></button>
      <button onMouseDown={e=>e.preventDefault()} onClick={()=>command("insertUnorderedList")}>• List</button><button onMouseDown={e=>e.preventDefault()} onClick={()=>command("insertOrderedList")}>1. List</button><button onMouseDown={e=>e.preventDefault()} onClick={addLink}>Link</button><button onMouseDown={e=>e.preventDefault()} onClick={()=>imageInputRef.current?.click()}>Image</button>
      <select defaultValue="p" onChange={e=>{command("formatBlock",e.target.value);e.currentTarget.value="p";}}><option value="p">Paragraph</option><option value="h2">Heading</option><option value="h3">Subheading</option><option value="blockquote">Quote</option><option value="pre">Code block</option></select>
      <button className={sourceMode?"active":""} onClick={()=>{if(!sourceMode)syncEditor();setSourceMode(v=>!v);}}>&lt;/&gt; HTML</button>
      <input ref={imageInputRef} className="hidden-file-input" type="file" accept="image/*" onChange={e=>{const file=e.target.files?.[0];if(file)void addImageFile(file);e.currentTarget.value="";}} />
    </div>
    {sourceMode ? <textarea className="html-source-editor" value={draft} onChange={e=>setDraft(e.target.value)} spellCheck={false}/> : <div ref={editorRef} className="rich-note-editor" contentEditable suppressContentEditableWarning onInput={syncEditor} onPaste={event=>{const files=[...event.clipboardData.files].filter(file=>file.type.startsWith("image/"));if(files.length){event.preventDefault();for(const file of files)void addImageFile(file);}}} onDragOver={event=>event.preventDefault()} onDrop={event=>{const files=[...event.dataTransfer.files].filter(file=>file.type.startsWith("image/"));if(files.length){event.preventDefault();for(const file of files)void addImageFile(file);}}} />}
    <div className="notes-modal-footer"><span className={dirty?"note-dirty":"note-saved"}>{dirty?"Unsaved changes":"Saved"}</span><div><button className="ghost-button" onClick={()=>{if(!dirty||window.confirm("Discard unsaved note changes?"))onClose();}}>Cancel</button><button className="primary-button" disabled={saving} onClick={()=>void saveAndClose()}>{saving?"Saving…":"Save & close"}</button></div></div>
  </div></div>;
}

function RecurrenceEditor({ task }: { task: Task }) {
  const [open, setOpen] = useState(Boolean(task.recurrence?.enabled));
  const [draft, setDraft] = useState<RecurrenceRule>(()=>({ ...defaultRecurrenceRule(), ...(task.recurrence ?? {}) }));
  const [excludedText,setExcludedText] = useState((task.recurrence?.excludedDates ?? []).join(", "));
  useEffect(() => { setDraft({ ...defaultRecurrenceRule(), ...(task.recurrence ?? {}) }); setExcludedText((task.recurrence?.excludedDates ?? []).join(", ")); setOpen(Boolean(task.recurrence?.enabled)); }, [task.id, task.recurrence]);
  const weekdays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function toggleNumber(list: number[], value: number) { return list.includes(value) ? list.filter(item => item !== value) : [...list,value].sort((a,b)=>a-b); }
  function patternMode() {
    if (draft.specialMonthly === "first_weekday") return "first_weekday";
    if (draft.specialMonthly === "last_weekday") return "last_weekday";
    if (draft.ordinal && draft.ordinalWeekday != null) return "ordinal";
    if (draft.monthDays.includes(-1)) return "last";
    if (draft.monthDays.length === 1 && draft.monthDays[0] === 1) return "first";
    if (draft.monthDays.length) return "days";
    return "same";
  }
  function setPattern(mode:string) {
    setDraft(current=>({ ...current, monthDays: mode==="first"?[1]:mode==="last"?[-1]:mode==="days"?[1,15]:[], ordinal:mode==="ordinal"?1:null, ordinalWeekday:mode==="ordinal"?1:null, specialMonthly:mode==="first_weekday"?"first_weekday":mode==="last_weekday"?"last_weekday":null }));
  }
  function setFrequency(frequency:RecurrenceRule["frequency"]) {
    setDraft(current=>({ ...current, frequency, weekdays:(frequency==="day"||frequency==="week")?current.weekdays:[], months:(frequency==="month"||frequency==="year")?current.months:[], monthDays:(frequency==="month"||frequency==="year")?current.monthDays:[], ordinal:(frequency==="month"||frequency==="year")?current.ordinal:null, ordinalWeekday:(frequency==="month"||frequency==="year")?current.ordinalWeekday:null, specialMonthly:(frequency==="month"||frequency==="year")?current.specialMonthly:null }));
  }
  return <div className="recurrence-editor">
    {!open ? <button className="recurrence-enable" onClick={() => setOpen(true)}><Repeat2 size={14}/> Make repeatable</button> : <div className="recurrence-card full-recurrence-card">
      <div className="recurrence-row"><label>Every <input type="number" min="1" max="999" value={draft.interval} onChange={e => setDraft({...draft, interval: Math.max(1,Number(e.target.value)||1)})}/></label><select value={draft.frequency} onChange={e => setFrequency(e.target.value as RecurrenceRule["frequency"])}><option value="minute">minute(s)</option><option value="hour">hour(s)</option><option value="day">day(s)</option><option value="week">week(s)</option><option value="month">month(s)</option><option value="year">year(s)</option></select></div>
      {(draft.frequency==="day"||draft.frequency==="week") && <div className="recurrence-section"><div className="recurrence-section-head"><small>On days</small><div className="recurrence-presets"><button onClick={()=>setDraft({...draft,weekdays:[1,2,3,4,5]})}>Weekdays</button><button onClick={()=>setDraft({...draft,weekdays:[0,6]})}>Weekends</button><button onClick={()=>setDraft({...draft,weekdays:[]})}>Any day</button></div></div><div className="recurrence-pills">{weekdays.map((day,index)=><button key={day} className={draft.weekdays.includes(index)?"active":""} onClick={()=>setDraft({...draft,weekdays:toggleNumber(draft.weekdays,index)})}>{day}</button>)}</div></div>}
      {(draft.frequency==="month"||draft.frequency==="year") && <>
        <div className="recurrence-row"><label>Pattern<select value={patternMode()} onChange={e=>setPattern(e.target.value)}><option value="same">Same day number as start</option><option value="first">First day of month</option><option value="last">Last day of month</option><option value="days">Specific day(s) of month</option><option value="ordinal">First/Second/Third/Fourth/Fifth/Last weekday</option><option value="first_weekday">First weekday (Mon–Fri)</option><option value="last_weekday">Last weekday (Mon–Fri)</option></select></label></div>
        {patternMode()==="days"&&<label className="recurrence-wide-label">Days of month<input value={draft.monthDays.filter(day=>day>0).join(",")} onChange={e=>setDraft({...draft,monthDays:[...new Set<number>(e.target.value.split(",").map(v=>Number(v.trim())).filter(v=>v>=1&&v<=31))].sort((a,b)=>a-b)})} placeholder="1, 15, 30"/></label>}
        {patternMode()==="ordinal"&&<div className="recurrence-row"><select value={draft.ordinal??1} onChange={e=>setDraft({...draft,ordinal:Number(e.target.value) as RecurrenceRule["ordinal"]})}><option value="1">First</option><option value="2">Second</option><option value="3">Third</option><option value="4">Fourth</option><option value="5">Fifth</option><option value="-1">Last</option></select><select value={draft.ordinalWeekday??1} onChange={e=>setDraft({...draft,ordinalWeekday:Number(e.target.value)})}>{weekdays.map((day,index)=><option key={day} value={index}>{day}</option>)}</select></div>}
        <div className="recurrence-months"><div className="recurrence-section-head"><small>{draft.frequency==="year"?"Months in each matching year":"Limit to months"} · none selected = {draft.frequency==="year"?"start month":"every month"}</small><button onClick={()=>setDraft({...draft,months:[]})}>Clear</button></div><div>{months.map((month,index)=><button key={month} className={draft.months.includes(index+1)?"active":""} onClick={()=>setDraft({...draft,months:toggleNumber(draft.months,index+1)})}>{month}</button>)}</div></div>
      </>}
      <label className="recurrence-wide-label">Skip dates <small>comma-separated exceptions</small><input value={excludedText} onChange={e=>setExcludedText(e.target.value)} onBlur={()=>setDraft({...draft,excludedDates:excludedText.split(",").map(v=>v.trim()).filter(v=>/^\d{4}-\d{2}-\d{2}$/.test(v))})} placeholder="2026-12-25, 2027-01-01"/></label>
      <div className="recurrence-row"><label>Ends<select value={draft.endMode} onChange={e=>setDraft({...draft,endMode:e.target.value as RecurrenceRule["endMode"]})}><option value="forever">Forever</option><option value="count">After X occurrences</option><option value="until">On a date</option></select></label>{draft.endMode==="count"&&<input type="number" min="1" value={draft.count??1} onChange={e=>setDraft({...draft,count:Math.max(1,Number(e.target.value)||1)})}/>} {draft.endMode==="until"&&<input type="date" value={draft.untilDate??""} onChange={e=>setDraft({...draft,untilDate:e.target.value||null})}/>}</div>
      <div className="recurrence-summary"><Repeat2 size={12}/> {recurrenceLabel(draft)}{draft.endMode==="count"&&draft.count?` · ${draft.count} times`:draft.endMode==="until"&&draft.untilDate?` · until ${draft.untilDate}`:""}</div>
      <div className="recurrence-actions"><button className="ghost-button" onClick={async()=>{await updateTask(task.id,{recurrence:null,recurrenceSeriesId:null,recurrenceOccurrence:null},"TASK_RECURRENCE_REMOVED");setOpen(false);}}>Remove</button><button className="primary-button compact" onClick={()=>void updateTask(task.id,{recurrence:{...draft,enabled:true,anchorDate:draft.anchorDate??task.startDate??localDateOnly(),anchorTime:draft.anchorTime??task.startTime,specialMonthly:draft.specialMonthly??null,excludedDates:excludedText.split(",").map(v=>v.trim()).filter(v=>/^\d{4}-\d{2}-\d{2}$/.test(v))},recurrenceSeriesId:task.recurrenceSeriesId??crypto.randomUUID(),recurrenceOccurrence:task.recurrenceOccurrence??1},"TASK_RECURRENCE_CHANGED")}>Save repeat</button></div>
    </div>}
  </div>;
}

type InspectorFieldKey = "status"|"priority"|"project"|"parent"|"duration"|"startDate"|"startTime"|"dueDate"|"dueTime"|"tags"|"repeat"|"notes";
const defaultInspectorFieldOrder: InspectorFieldKey[] = ["status","priority","project","parent","duration","startDate","startTime","dueDate","dueTime","tags","repeat","notes"];
const defaultInspectorFieldRows: InspectorFieldKey[][] = [["status","priority"],["project","parent"],["duration","startDate"],["startTime","dueDate"],["dueTime"],["tags"],["repeat"],["notes"]];
type InspectorDropMode = "before"|"after"|"left"|"right";
type InspectorDropTarget = { anchor: InspectorFieldKey; mode: InspectorDropMode };

function rowsFromLegacyOrder(order: InspectorFieldKey[]) {
  const fullByDefault = new Set<InspectorFieldKey>(["tags","repeat","notes"]);
  const rows: InspectorFieldKey[][] = [];
  let pending: InspectorFieldKey | null = null;
  for (const key of order) {
    if (fullByDefault.has(key)) {
      if (pending) { rows.push([pending]); pending = null; }
      rows.push([key]);
      continue;
    }
    if (pending) { rows.push([pending, key]); pending = null; }
    else pending = key;
  }
  if (pending) rows.push([pending]);
  return rows;
}

function normalizeInspectorRows(value: unknown): InspectorFieldKey[][] {
  const validKeys = new Set(defaultInspectorFieldOrder);
  const seen = new Set<InspectorFieldKey>();
  let source: InspectorFieldKey[][] = [];
  if (Array.isArray(value) && value.every(item => typeof item === "string")) {
    source = rowsFromLegacyOrder((value as string[]).filter((key): key is InspectorFieldKey => validKeys.has(key as InspectorFieldKey)));
  } else if (Array.isArray(value)) {
    source = (value as unknown[]).filter(Array.isArray).map(row => (row as unknown[]).filter((key): key is InspectorFieldKey => typeof key === "string" && validKeys.has(key as InspectorFieldKey)).slice(0, 2));
  }
  const rows: InspectorFieldKey[][] = [];
  for (const row of source) {
    const clean = row.filter(key => !seen.has(key));
    clean.forEach(key => seen.add(key));
    if (clean.length) rows.push(clean);
  }
  for (const key of defaultInspectorFieldOrder) if (!seen.has(key)) rows.push([key]);
  return rows.length ? rows : defaultInspectorFieldRows.map(row => [...row]);
}

function moveInspectorField(rows: InspectorFieldKey[][], field: InspectorFieldKey, target: InspectorDropTarget) {
  const next = rows.map(row => row.filter(key => key !== field)).filter(row => row.length > 0);
  const targetRowIndex = next.findIndex(row => row.includes(target.anchor));
  if (targetRowIndex < 0) return rows;
  if (target.mode === "before") next.splice(targetRowIndex, 0, [field]);
  else if (target.mode === "after") next.splice(targetRowIndex + 1, 0, [field]);
  else {
    const row = next[targetRowIndex];
    if (row.length !== 1) return rows;
    next[targetRowIndex] = target.mode === "left" ? [field, row[0]] : [row[0], field];
  }
  return next;
}

function DraggableInspectorField({ fieldKey, label, singleRow, dragging, onDragStart, onDragEnd, children }: { fieldKey: InspectorFieldKey; label: string; singleRow: boolean; dragging: boolean; onDragStart:(key:InspectorFieldKey)=>void; onDragEnd:()=>void; children:ReactNode }) {
  return <div className={`detail-field draggable-detail-field ${singleRow?"span-two":""} ${dragging?"dragging-field":""}`}>
    <span className="detail-field-drag-label" title="Drag to reposition field" draggable onDragStart={e=>{e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",fieldKey);onDragStart(fieldKey);}} onDragEnd={onDragEnd}><b>⋮⋮</b>{label}</span>
    {children}
  </div>;
}

function InspectorDropZone({ active, className, label, onHover, onDrop }: { active:boolean; className:string; label:string; onHover:()=>void; onDrop:()=>void }) {
  return <div className={`${className} ${active?"active":""}`} aria-label={label} onDragEnter={event=>{event.preventDefault();onHover();}} onDragOver={event=>{event.preventDefault();event.dataTransfer.dropEffect="move";onHover();}} onDrop={event=>{event.preventDefault();onDrop();}}><span>{label}</span></div>;
}

function TaskInspector({ task, tasks, projects, onClose, onOpenTask, onFocusParent, onTagClick, onRequestDelete }: { task: Task; tasks: Task[]; projects: Project[]; onClose: () => void; onOpenTask: (id: string) => void; onFocusParent: (id: string) => void; onTagClick: (tag: string) => void; onRequestDelete: () => void }) {
  const descendants = descendantIds(tasks, task.id);
  const parent = task.parentTaskId ? tasks.find(candidate => candidate.id === task.parentTaskId) ?? null : null;
  const parentOptions = tasks.filter(candidate => candidate.id !== task.id && !descendants.has(candidate.id));
  const [fieldRows,setFieldRows] = useState<InspectorFieldKey[][]>(()=>defaultInspectorFieldRows.map(row=>[...row]));
  const [draggingField,setDraggingField] = useState<InspectorFieldKey|null>(null);
  const [fieldDropTarget,setFieldDropTarget] = useState<InspectorDropTarget|null>(null);
  useEffect(()=>{
    try {
      const rowRaw=localStorage.getItem("taskmap.inspectorFieldRows.v2");
      const legacyRaw=localStorage.getItem("taskmap.inspectorFieldOrder.v1");
      if(rowRaw) setFieldRows(normalizeInspectorRows(JSON.parse(rowRaw)));
      else if(legacyRaw) setFieldRows(normalizeInspectorRows(JSON.parse(legacyRaw)));
    } catch {}
  },[]);
  function commitFieldDrop(target:InspectorDropTarget) {
    if(!draggingField){setFieldDropTarget(null);return;}
    setFieldRows(current=>{
      const next=moveInspectorField(current,draggingField,target);
      try{localStorage.setItem("taskmap.inspectorFieldRows.v2",JSON.stringify(next));}catch{}
      return next;
    });
    setDraggingField(null);
    setFieldDropTarget(null);
  }

  const fields: Record<InspectorFieldKey,{label:string;content:ReactNode}> = {
    status:{label:"Status",content:<BufferedSelect value={task.status} onCommit={async value => { const next = value as Task["status"]; if ((next === "done") !== (task.status === "done")) { await toggleTaskComplete(task); if (next !== "done" && next !== "not_started") await updateTask(task.id, { status: next }, "TASK_STATUS_CHANGED"); return; } await updateTask(task.id, { status: next }, "TASK_STATUS_CHANGED"); }}><option value="not_started">Not started</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="done">Done</option></BufferedSelect>},
    priority:{label:"Priority",content:<BufferedSelect value={task.priority} onCommit={value => updateTask(task.id, { priority: value as Task["priority"] }, "TASK_PRIORITY_CHANGED")}><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></BufferedSelect>},
    project:{label:"Project",content:<BufferedSelect value={task.projectId ?? ""} onCommit={value => updateTask(task.id, { projectId: value || null }, "TASK_PROJECT_CHANGED")}><option value="">No project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</BufferedSelect>},
    parent:{label:"Parent task",content:<><BufferedSelect value={task.parentTaskId ?? ""} onCommit={value => updateTask(task.id, { parentTaskId: value || null }, "TASK_PARENT_CHANGED")}><option value="">No parent</option>{parentOptions.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</BufferedSelect>{parent && <button className="parent-link-button" onClick={() => onFocusParent(parent.id)}>Focus parent: {parent.title}</button>}</>},
    duration:{label:"Duration",content:<BufferedInput type="number" min="0" step="15" value={task.estimatedMinutes == null ? "" : String(task.estimatedMinutes)} onCommit={value => updateTask(task.id, { estimatedMinutes: value === "" ? null : Math.max(0, Number(value)) }, "TASK_DURATION_CHANGED")} placeholder="minutes" />},
    startDate:{label:"Start date",content:<BufferedInput type="date" value={task.startDate ?? ""} onCommit={value => updateTask(task.id, { startDate: value || null }, "TASK_START_DATE_CHANGED")} />},
    startTime:{label:"Start time",content:<BufferedInput type="time" value={task.startTime ?? ""} onCommit={value => updateTask(task.id, { startTime: value || null }, "TASK_START_TIME_CHANGED")} />},
    dueDate:{label:"Due date",content:<BufferedInput type="date" value={task.dueDate ?? ""} onCommit={value => updateTask(task.id, { dueDate: value || null }, "TASK_DUE_DATE_CHANGED")} />},
    dueTime:{label:"Due time",content:<BufferedInput type="time" value={task.dueTime ?? ""} onCommit={value => updateTask(task.id, { dueTime: value || null }, "TASK_DUE_TIME_CHANGED")} />},
    tags:{label:"Tags",content:<><BufferedInput value={(task.tags ?? []).join(", ")} onCommit={value => updateTask(task.id, { tags: value.split(",").map(tag => tag.trim()).filter(Boolean) }, "TASK_TAGS_CHANGED")} placeholder="work, follow-up, calls" />{(task.tags ?? []).length > 0 && <div className="detail-tag-chips">{(task.tags ?? []).map((tag, tagIndex) => <button key={`${tag}-${tagIndex}`} className="task-tag label-tag" onClick={() => onTagClick(tag)}>Tag: {tag}</button>)}</div>}</>},
    repeat:{label:"Repeat",content:<RecurrenceEditor task={task}/>},
    notes:{label:"Notes",content:<NotesField task={task}/>},
  };

  return <aside className="inspector">
    <div className="inspector-header"><span>Task details</span><button onClick={onClose}>×</button></div>
    <div className="title-field"><BufferedInput className="title-input" value={task.title} onCommit={value => updateTask(task.id, { title: value.trim() || task.title }, "TASK_TITLE_CHANGED")} /></div>
    <div className="detail-grid draggable-detail-grid">
      {fieldRows.map((row,rowIndex)=>{
        const anchor=row.find(key=>key!==draggingField) ?? row[0];
        const beforeTarget:InspectorDropTarget={anchor,mode:"before"};
        const afterTarget:InspectorDropTarget={anchor,mode:"after"};
        const canDropAround=Boolean(draggingField && !(row.length===1 && row[0]===draggingField));
        const showPairZones=Boolean(draggingField && row.length===1 && row[0]!==draggingField);
        return <div className="detail-layout-row" key={`${row.join("-")}-${rowIndex}`}>
          {canDropAround && <InspectorDropZone className="detail-row-drop-zone before" label="Place on its own row here" active={fieldDropTarget?.anchor===anchor&&fieldDropTarget.mode==="before"} onHover={()=>setFieldDropTarget(beforeTarget)} onDrop={()=>commitFieldDrop(beforeTarget)} />}
          <div className={`detail-row-fields ${row.length===1?"single":"paired"}`}>
            {row.map(key=><DraggableInspectorField key={key} fieldKey={key} label={fields[key].label} singleRow={row.length===1} dragging={draggingField===key} onDragStart={key=>{setDraggingField(key);setFieldDropTarget(null);}} onDragEnd={()=>{setDraggingField(null);setFieldDropTarget(null);}}>{fields[key].content}</DraggableInspectorField>)}
            {showPairZones && <>
              <InspectorDropZone className="detail-pair-drop-zone left" label="Place in left column" active={fieldDropTarget?.anchor===anchor&&fieldDropTarget.mode==="left"} onHover={()=>setFieldDropTarget({anchor,mode:"left"})} onDrop={()=>commitFieldDrop({anchor,mode:"left"})} />
              <InspectorDropZone className="detail-pair-drop-zone right" label="Place in right column" active={fieldDropTarget?.anchor===anchor&&fieldDropTarget.mode==="right"} onHover={()=>setFieldDropTarget({anchor,mode:"right"})} onDrop={()=>commitFieldDrop({anchor,mode:"right"})} />
            </>}
          </div>
          {canDropAround && <InspectorDropZone className="detail-row-drop-zone after" label="Place on its own row here" active={fieldDropTarget?.anchor===anchor&&fieldDropTarget.mode==="after"} onHover={()=>setFieldDropTarget(afterTarget)} onDrop={()=>commitFieldDrop(afterTarget)} />}
        </div>;
      })}
    </div>
    <div className="inspector-utility-actions"><button className="focus-hierarchy-button" onClick={() => onFocusParent(task.id)}>Show this task + all subtasks</button><button className="save-template-button" onClick={async () => { const name = window.prompt("Template name", task.title); if (name?.trim()) await saveTaskHierarchyAsTemplate(task.id, name); }}><FileStack size={14}/> Save task + subtasks as template</button></div>
    <HistoryPanel taskId={task.id} />
    <div className="inspector-danger-zone"><button className="danger-button delete-task-button" onClick={onRequestDelete}><Trash2 size={14}/> Delete Task</button></div>
  </aside>;
}

function DeleteTasksDialog({ request, tasks, onCancel, onDelete }: { request:{ids:string[];source:"single"|"bulk"}; tasks:Task[]; onCancel:()=>void; onDelete:(mode:"cascade"|"orphan")=>Promise<void> }) {
  const roots=request.ids.map(id=>tasks.find(task=>task.id===id)).filter((task):task is Task=>Boolean(task));
  const rootIds=new Set(request.ids);
  const hasChildren=tasks.some(task=>task.parentTaskId && rootIds.has(task.parentTaskId));
  const [working,setWorking]=useState(false);
  async function go(mode:"cascade"|"orphan"){setWorking(true);await onDelete(mode);setWorking(false);}
  return <div className="delete-modal-backdrop"><div className="delete-modal"><div className="delete-modal-icon"><Trash2 size={20}/></div><div><p className="eyebrow">Delete {request.source==="bulk"?`${roots.length} tasks`:"task"}</p><h2>{request.source==="single"?roots[0]?.title:`${roots.length} selected tasks`}</h2><p>{hasChildren?"At least one selected task has children. Choose what should happen to the hierarchy.":"This task will be removed from active views but kept as a tombstone in transaction history."}</p></div>{hasChildren?<div className="delete-choice-list"><button disabled={working} className="danger-choice" onClick={()=>void go("cascade")}><strong>Delete parent + all descendants</strong><span>Deletes every nested child below the selected parent task(s).</span></button><button disabled={working} onClick={()=>void go("orphan")}><strong>Delete parent only</strong><span>Direct children become top-level tasks; their own children stay attached.</span></button></div>:<button disabled={working} className="danger-button full" onClick={()=>void go("orphan")}>Delete {roots.length===1?"Task":`${roots.length} Tasks`}</button>}<button className="ghost-button full" disabled={working} onClick={onCancel}>Cancel</button></div></div>;
}
